// Export and import of MyAnimeList (MAL) lists, in the XML format MAL's
// own "Export My List" produces (and its import page accepts). The
// format itself, and how it maps onto an entry's columns, is in
// malFormat.js.
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
// (see adoptImportedEntry in db.js). A title already in the library gets
// the MAL details it doesn't have yet; where both have a value and they
// differ, the MAL value is kept in mal_conflicts for you to settle in the
// detail sheet (nothing in the app is overwritten).
//
// Hentai is left out of exports (ecchi stays): genres come from AniList,
// looked up by MAL id and cached on the entry (genres, is_adult).
//
// MAL fields with no column of their own (my_id, storage, ...) are kept
// as JSON in mal_data, so an export gives back exactly what came in.
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { ungzip } from 'pako';
import { getAllEntries, getEntryByMalId, restoreEntry, updateEntryFields, getSetting, setSetting } from './db';
import { MEDIA_TYPES } from './mediaTypes';
import { isDriveConnected, uploadTextFileToDrive } from './GoogleDriveService';
import { FORMATS, columnsFromMalItem, malItemFromEntry, compareWithEntry } from './malFormat';

const IMPORTED_PREFIX = 'mal-';

export function isImportedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith(IMPORTED_PREFIX);
}

export function exportFileNameFor(mediaType) {
  return `${FORMATS[mediaType].item}list.xml`;
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
    if (counts[entry.read_status] !== undefined) counts[entry.read_status]++;
    const values = malItemFromEntry(mediaType, entry);
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

// ---------- Genres (AniList) ----------

const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_QUERY = `query ($ids: [Int], $type: MediaType) {
  Page(perPage: 50) { media(idMal_in: $ids, type: $type) { idMal isAdult genres } }
}`;

export function isHentai(entry) {
  return entry.is_adult === 1 || /(^|,)\s*hentai\s*(,|$)/i.test(entry.genres || '');
}

// Looks up genres for entries with a MAL id that haven't been checked yet
// (genres is null), 50 per request, and saves them on the entries. A title
// AniList doesn't know gets genres '' so it isn't asked about again.
// Throws if AniList can't be reached.
export async function fetchMissingGenres(mediaType, entries) {
  const unchecked = entries.filter((e) => e.mal_id && e.genres === null);
  for (let i = 0; i < unchecked.length; i += 50) {
    const batch = unchecked.slice(i, i + 50);
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: { ids: batch.map((e) => e.mal_id), type: mediaType === 'anime' ? 'ANIME' : 'MANGA' },
      }),
    });
    if (!res.ok) throw new Error(`Couldn't look up genres on AniList (${res.status}).`);
    const json = await res.json();
    const found = new Map((json.data?.Page?.media || []).map((m) => [m.idMal, m]));
    batch.forEach((e) => {
      const m = found.get(e.mal_id);
      e.genres = m ? (m.genres || []).join(',') : '';
      e.is_adult = m && m.isAdult ? 1 : 0;
      updateEntryFields(e.source_id, mediaType, { genres: e.genres, is_adult: e.is_adult });
    });
  }
}

// ---------- Export ----------

// Builds the export for one type, saves it to Drive (replacing the last
// export there) when connected, and offers it to the share sheet. Hentai
// is left out. Returns { exported, skipped, hentai, drive: 'saved' |
// 'not connected' | error }.
export async function exportMalList(mediaType) {
  const all = getAllEntries(mediaType);
  const linked = all.filter((e) => e.mal_id);
  await fetchMissingGenres(mediaType, linked);
  const withId = linked.filter((e) => !isHentai(e));
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

  return {
    exported: withId.length,
    skipped: all.length - linked.length,
    hentai: linked.length - withId.length,
    drive,
  };
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

// Brings a MAL item into an entry that's already in the library: fills
// in what it doesn't have and records what differs (merged with any
// differences still unsettled). Returns true if anything differs.
function mergeIntoEntry(entry, mediaType, item, malId) {
  const columns = columnsFromMalItem(mediaType, item);
  const { fill, conflicts } = compareWithEntry(entry, columns);
  let previous = {};
  try {
    previous = entry.mal_conflicts ? JSON.parse(entry.mal_conflicts) : {};
  } catch (e) {
    previous = {};
  }
  const merged = { ...previous, ...conflicts };
  const hasConflicts = Object.keys(merged).length > 0;
  updateEntryFields(entry.source_id, mediaType, {
    ...fill,
    // Anime type isn't something you'd set yourself; MAL's is used.
    ...(columns.series_type ? { series_type: columns.series_type } : {}),
    mal_id: malId,
    mal_data: JSON.stringify(item),
    mal_conflicts: hasConflicts ? JSON.stringify(merged) : null,
  });
  return Object.keys(conflicts).length > 0;
}

// Adds the titles in a parsed MAL export that aren't in the library yet,
// and compares the ones that are. Returns { mediaType, added, linked,
// alreadyThere, differing }.
export function importParsedList({ mediaType, user, items }) {
  const format = FORMATS[mediaType];

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
  let differing = 0;

  items.forEach((item) => {
    const malId = Number(item[format.idField]);
    if (!malId) return;
    const title = item[format.titleField] || '';

    const sameId = getEntryByMalId(malId, mediaType);
    if (sameId) {
      alreadyThere++;
      if (mergeIntoEntry(sameId, mediaType, item, malId)) differing++;
      return;
    }

    // Same title already recorded by browsing, but without its MAL id.
    const sameTitle = byTitle.get(normalizeTitle(title));
    if (sameTitle && !sameTitle.mal_id) {
      if (mergeIntoEntry(sameTitle, mediaType, item, malId)) differing++;
      sameTitle.mal_id = malId;
      linked++;
      return;
    }

    const malData = JSON.stringify(item);
    const columns = columnsFromMalItem(mediaType, item);

    restoreEntry({
      sourceId: `${IMPORTED_PREFIX}${malId}`,
      mediaType,
      title,
      sourceUrl: `https://myanimelist.net/${format.item}/${malId}`,
      malId,
      malData,
      ...columns,
    });
    added++;
  });

  if (user && (user.user_id || user.user_name)) {
    setSetting(
      `malUser_${mediaType}`,
      JSON.stringify({ user_id: user.user_id || '', user_name: user.user_name || '' })
    );
  }

  return { mediaType, added, linked, alreadyThere, differing };
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
