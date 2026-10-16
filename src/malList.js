// Export and import of MyAnimeList (MAL) lists, in the XML format MAL's
// own "Export My List" produces (and its import page accepts).
//
// Export: one file per type (animelist.xml / mangalist.xml) holding every
// entry that has a MAL id — entries recorded by browsing get theirs from
// the page's link to myanimelist.net. It's offered to the share sheet
// (save to Files, send, ...) and also written to the MangaTracker folder
// on Google Drive, replacing the previous export there.
//
// Import: reads a MAL export (.xml or .xml.gz) and adds every title not
// already in the library, matched by MAL id, then by title. An imported
// title has no cover or site page yet (source_id "mal-<id>", linking to
// MyAnimeList); opening it on the site later turns it into a normal entry
// (see adoptImportedEntry in db.js). Titles already in the library but
// without a MAL id get it filled in.
//
// Each imported entry keeps its MAL fields as JSON (mal_data), so an
// export gives back exactly what came in — dates, 1-10 score, progress,
// priority — except for what you changed in the app (status, tags, and
// the score when you re-rated it).
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { ungzip } from 'pako';
import { getAllEntries, getEntryByMalId, restoreEntry, setMalData, getSetting, setSetting } from './db';
import { MEDIA_TYPES } from './mediaTypes';
import { isDriveConnected, uploadTextFileToDrive } from './GoogleDriveService';

const IMPORTED_PREFIX = 'mal-';

export function isImportedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith(IMPORTED_PREFIX);
}

// Per-type differences in MAL's format. Fields are listed in the order
// MAL writes them; `cdata` ones are wrapped in <![CDATA[...]]>.
const FORMATS = {
  anime: {
    item: 'anime',
    exportType: 1,
    idField: 'series_animedb_id',
    titleField: 'series_title',
    progressField: 'my_watched_episodes',
    totalField: 'series_episodes',
    statuses: {
      reading: 'Watching',
      read: 'Completed',
      on_hold: 'On-Hold',
      dropped: 'Dropped',
      want_to_read: 'Plan to Watch',
    },
    totals: {
      reading: 'user_total_watching',
      read: 'user_total_completed',
      on_hold: 'user_total_onhold',
      dropped: 'user_total_dropped',
      want_to_read: 'user_total_plantowatch',
    },
    totalAll: 'user_total_anime',
    fields: [
      ['series_animedb_id', ''],
      ['series_title', '', 'cdata'],
      ['series_type', ''],
      ['series_episodes', '0'],
      ['my_id', '0'],
      ['my_watched_episodes', '0'],
      ['my_start_date', '0000-00-00'],
      ['my_finish_date', '0000-00-00'],
      ['my_rated', ''],
      ['my_score', '0'],
      ['my_storage', ''],
      ['my_storage_value', '0.00'],
      ['my_status', ''],
      ['my_comments', '', 'cdata'],
      ['my_times_watched', '0'],
      ['my_rewatch_value', ''],
      ['my_priority', 'LOW'],
      ['my_tags', '', 'cdata'],
      ['my_rewatching', '0'],
      ['my_rewatching_ep', '0'],
      ['my_discuss', '1'],
      ['my_sns', 'default'],
      ['update_on_import', '0'],
    ],
  },
  manga: {
    item: 'manga',
    exportType: 2,
    idField: 'manga_mangadb_id',
    titleField: 'manga_title',
    progressField: 'my_read_chapters',
    totalField: 'manga_chapters',
    statuses: {
      reading: 'Reading',
      read: 'Completed',
      on_hold: 'On-Hold',
      dropped: 'Dropped',
      want_to_read: 'Plan to Read',
    },
    totals: {
      reading: 'user_total_reading',
      read: 'user_total_completed',
      on_hold: 'user_total_onhold',
      dropped: 'user_total_dropped',
      want_to_read: 'user_total_plantoread',
    },
    totalAll: 'user_total_manga',
    fields: [
      ['manga_mangadb_id', ''],
      ['manga_title', '', 'cdata'],
      ['manga_volumes', '0'],
      ['manga_chapters', '0'],
      ['my_id', '0'],
      ['my_read_volumes', '0'],
      ['my_read_chapters', '0'],
      ['my_start_date', '0000-00-00'],
      ['my_finish_date', '0000-00-00'],
      ['my_scanalation_group', '', 'cdata'],
      ['my_score', '0'],
      ['my_storage', ''],
      ['my_retail_volumes', '0'],
      ['my_status', ''],
      ['my_comments', '', 'cdata'],
      ['my_times_read', '0'],
      ['my_tags', '', 'cdata'],
      ['my_priority', 'Low'],
      ['my_reread_value', ''],
      ['my_rereading', 'NO'],
      ['my_discuss', 'YES'],
      ['my_sns', 'default'],
      ['update_on_import', '0'],
    ],
  },
};

export function exportFileNameFor(mediaType) {
  return `${FORMATS[mediaType].item}list.xml`;
}

// ---------- Scores: app stars are 1-5, MAL scores 1-10 ----------

function starsFromMalScore(malScore) {
  const n = Number(malScore) || 0;
  return n > 0 ? Math.max(1, Math.round(n / 2)) : null;
}

// Keeps the imported 1-10 score unless the stars were changed since.
function malScoreFor(entry, malData) {
  const stars = entry.score || null;
  const original = Number(malData.my_score) || 0;
  if (original > 0 && starsFromMalScore(original) === stars) return original;
  return stars ? stars * 2 : 0;
}

// ---------- XML ----------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function cdata(value) {
  // "]]>" can't appear inside CDATA; split it across two sections.
  return `<![CDATA[${String(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// Reads the flat <tag>value</tag> children of one element's body.
function readFields(body) {
  const fields = {};
  const re = /<([A-Za-z_][\w]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  let m;
  while ((m = re.exec(body))) {
    fields[m[1]] = m[2] !== undefined ? m[2] : decodeXml(m[3]);
  }
  return fields;
}

// Parses a MAL export into { mediaType, user, items }, or throws if the
// text isn't one.
export function parseMalXml(text) {
  if (!/<myanimelist>/.test(text)) {
    throw new Error("This isn't a MyAnimeList export (no <myanimelist> element).");
  }
  const infoMatch = text.match(/<myinfo>([\s\S]*?)<\/myinfo>/);
  const user = infoMatch ? readFields(infoMatch[1]) : {};
  let mediaType = user.user_export_type === '2' ? 'manga' : user.user_export_type === '1' ? 'anime' : null;
  if (!mediaType) mediaType = /<manga>/.test(text) ? 'manga' : 'anime';

  const format = FORMATS[mediaType];
  const items = [];
  const re = new RegExp(`<${format.item}>([\\s\\S]*?)</${format.item}>`, 'g');
  let m;
  while ((m = re.exec(text))) items.push(readFields(m[1]));
  return { mediaType, user, items };
}

export function buildMalXml(mediaType, entries, user = {}) {
  const format = FORMATS[mediaType];
  const counts = { reading: 0, read: 0, on_hold: 0, dropped: 0, want_to_read: 0 };

  const items = entries.map((entry) => {
    let malData = {};
    try {
      malData = entry.mal_data ? JSON.parse(entry.mal_data) : {};
    } catch (e) {
      malData = {};
    }
    const status = entry.read_status && format.statuses[entry.read_status] ? entry.read_status : null;
    if (status) counts[status]++;

    const values = {
      ...malData,
      [format.idField]: entry.mal_id,
      [format.titleField]: malData[format.titleField] || entry.title || entry.alt_title || '',
      my_score: malScoreFor(entry, malData),
      // MAL needs a status; an unset one goes in as "plan to".
      my_status: format.statuses[status || 'want_to_read'],
      my_tags: entry.tags || '',
    };

    const lines = format.fields.map(([name, fallback, kind]) => {
      const raw = values[name] !== undefined && values[name] !== null ? values[name] : fallback;
      const inner = kind === 'cdata' ? cdata(raw) : escapeXml(raw);
      return `\t\t\t\t\t<${name}>${inner}</${name}>`;
    });
    return `\t\t\t\t<${format.item}>\n${lines.join('\n')}\n\t\t\t\t</${format.item}>`;
  });

  const info = [
    ['user_id', user.user_id || '0'],
    ['user_name', user.user_name || ''],
    ['user_export_type', String(format.exportType)],
    [format.totalAll, String(entries.length)],
    ...Object.entries(format.totals).map(([status, tag]) => [tag, String(counts[status])]),
  ]
    .map(([tag, value]) => `\t\t\t<${tag}>${escapeXml(value)}</${tag}>`)
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8" ?>\n' +
    '\t\t<!--\n\t\t Created by XML Export feature at MyAnimeList.net\n\t\t Version 1.1.0\n\t\t-->\n\n' +
    '\t\t<myanimelist>\n\n' +
    `\t\t\t<myinfo>\n${info}\n\t\t\t</myinfo>\n\n\n` +
    items.join('\n\n') +
    '\n\n\t\t\t</myanimelist>\n'
  );
}

// ---------- Export ----------

// Builds the export for one type, offers it to the share sheet and
// saves it to Drive (replacing the last export there) when connected.
// Returns { exported, skipped, drive: 'saved' | 'not connected' | error }.
export async function exportMalList(mediaType) {
  const all = getAllEntries(mediaType);
  const withId = all.filter((e) => e.mal_id);
  let user = {};
  try {
    user = JSON.parse(getSetting(`malUser_${mediaType}`, '{}')) || {};
  } catch (e) {
    user = {};
  }
  const xml = buildMalXml(mediaType, withId, user);
  const fileName = exportFileNameFor(mediaType);

  let drive = 'not connected';
  if (isDriveConnected()) {
    try {
      await uploadTextFileToDrive(xml, fileName, 'application/xml');
      drive = 'saved';
    } catch (err) {
      drive = err.message;
    }
  }

  const path = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(path, xml);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, {
      mimeType: 'application/xml',
      dialogTitle: `Export ${MEDIA_TYPES[mediaType].label} list`,
      UTI: 'public.xml',
    });
  }

  return { exported: withId.length, skipped: all.length - withId.length, drive };
}

// ---------- Import ----------

// Lowercase, without spaces and ASCII punctuation, so "Kaguya-sama: Love
// is War" matches "Kaguya-sama Love Is War".
function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/[\s!-/:-@[-`{-~]+/g, '');
}

function base64ToBytes(base64) {
  const binary = global.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Reads a picked file as text, unzipping it first if it's gzip.
async function readPickedFile(uri) {
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = base64ToBytes(base64);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return ungzip(bytes, { to: 'string' });
  }
  return FileSystem.readAsStringAsync(uri);
}

// Adds the titles in a parsed MAL export that aren't in the library yet.
// Returns { mediaType, added, linked, alreadyThere }.
export function importParsedList({ mediaType, user, items }) {
  const format = FORMATS[mediaType];
  const statusFromMal = {};
  Object.entries(format.statuses).forEach(([key, label]) => {
    statusFromMal[label.toLowerCase()] = key;
  });

  const byTitle = new Map();
  getAllEntries(mediaType).forEach((e) => {
    [e.title, e.alt_title].forEach((t) => {
      const key = normalizeTitle(t);
      if (key && !byTitle.has(key)) byTitle.set(key, e);
    });
  });

  let added = 0;
  let linked = 0;
  let alreadyThere = 0;

  items.forEach((item) => {
    const malId = Number(item[format.idField]);
    if (!malId) return;
    if (getEntryByMalId(malId, mediaType)) {
      alreadyThere++;
      return;
    }
    const malData = JSON.stringify(item);
    const title = item[format.titleField] || '';

    // Same title already recorded by browsing, but without its MAL id.
    const sameTitle = byTitle.get(normalizeTitle(title));
    if (sameTitle && !sameTitle.mal_id) {
      setMalData(sameTitle.source_id, mediaType, malId, malData);
      sameTitle.mal_id = malId;
      linked++;
      return;
    }

    restoreEntry({
      sourceId: `${IMPORTED_PREFIX}${malId}`,
      mediaType,
      title,
      score: starsFromMalScore(item.my_score),
      tags: item.my_tags || null,
      readStatus: statusFromMal[(item.my_status || '').toLowerCase()] || null,
      sourceUrl: `https://myanimelist.net/${format.item}/${malId}`,
      malId,
      malData,
    });
    added++;
  });

  if (user && (user.user_id || user.user_name)) {
    setSetting(
      `malUser_${mediaType}`,
      JSON.stringify({ user_id: user.user_id || '', user_name: user.user_name || '' })
    );
  }

  return { mediaType, added, linked, alreadyThere };
}

// Lets you pick a MAL export file and imports it. Returns null if the
// picker was cancelled.
export async function pickAndImportMalList() {
  const picked = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) return null;
  const text = await readPickedFile(picked.assets[0].uri);
  return importParsedList(parseMalXml(text));
}
