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
// MAL has two lists, anime and manga. Manga's holds every type that isn't
// anime (manga, manhwa, ...): its export includes them all, and its
// import matches against them all. New titles from it are sorted by
// AniList's country of origin: Korean ones go to Manhwa, the rest to
// Manga. Imported titles also get AniList's English title as their
// alternate title, so opening them on a site that has no MAL links (the
// Manhwa sites) can still find them by name (findImportedByTitle).
//
// Hentai is left out of exports (ecchi stays). Genres, and the total
// episode/chapter/volume counts when they aren't known yet, come from
// AniList, looked up by MAL id (refreshFromAniList).
//
// MAL fields with no column of their own (my_id, storage, ...) are kept
// as JSON in mal_data, so an export gives back exactly what came in.
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { ungzip } from 'pako';
import {
  getAllEntries,
  getEntryByMalId,
  restoreEntry,
  updateEntryFields,
  setEntryType,
  setAltTitle,
  setCoverImage,
  getSetting,
  setSetting,
} from './db';
import { MEDIA_TYPE_LIST } from './mediaTypes';
import { isDriveConnected, uploadTextFileToDrive } from './GoogleDriveService';
import { beginSync } from './syncStatus';
import {
  FORMATS,
  malTypeOf,
  columnsFromMalItem,
  malItemFromEntry,
  compareWithEntry,
  todayString,
} from './malFormat';

const IMPORTED_PREFIX = 'mal-';

export function isImportedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.startsWith(IMPORTED_PREFIX);
}

// The two lists, for the Export button.
export const MAL_LISTS = [
  { key: 'anime', label: 'Anime' },
  { key: 'manga', label: 'Manga' },
];

// The app's types that go on a MAL list, e.g. 'manga' → manga, manhwa.
export function typesOnMalList(malType) {
  return MEDIA_TYPE_LIST.map((m) => m.key).filter((key) => malTypeOf(key) === malType);
}

function entriesOnMalList(malType) {
  return typesOnMalList(malType).flatMap((type) => getAllEntries(type));
}

export function exportFileNameFor(malType) {
  return `${FORMATS[malType].item}list.xml`;
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

// ---------- Genres and totals (AniList) ----------

const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_QUERY = `query ($ids: [Int], $type: MediaType) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: $type) { idMal isAdult genres episodes chapters volumes }
  }
}`;

export function isHentai(entry) {
  return entry.is_adult === 1 || /(^|,)\s*hentai\s*(,|$)/i.test(entry.genres || '');
}

// Entries worth asking AniList about: genres never looked up, or no total
// yet (still airing, or never known) and not already asked today.
function needsAniList(entry) {
  if (!entry.mal_id) return false;
  if (entry.genres === null || entry.genres === undefined) return true;
  return !entry.total && entry.anilist_checked !== todayString();
}

// Looks up genres and total counts on AniList by MAL id (50 per request)
// and saves them on the entries: genres/is_adult always, totals only
// where the entry has none (a total you set, or MAL's, is never
// replaced). Series still coming out have no total on AniList either.
// A title AniList doesn't know gets genres '' so it isn't asked about
// again. Throws if AniList can't be reached.
export async function refreshFromAniList(entries) {
  const today = todayString();
  for (const malType of ['anime', 'manga']) {
    const due = entries.filter((e) => malTypeOf(e.media_type) === malType && needsAniList(e));
    for (let i = 0; i < due.length; i += 50) {
      const batch = due.slice(i, i + 50);
      const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: ANILIST_QUERY,
          variables: { ids: batch.map((e) => e.mal_id), type: malType === 'anime' ? 'ANIME' : 'MANGA' },
        }),
      });
      if (!res.ok) throw new Error(`Couldn't look up genres on AniList (${res.status}).`);
      const json = await res.json();
      const found = new Map((json.data?.Page?.media || []).map((m) => [m.idMal, m]));
      batch.forEach((e) => {
        const m = found.get(e.mal_id);
        const fields = {
          genres: m ? (m.genres || []).join(',') : '',
          is_adult: m && m.isAdult ? 1 : 0,
          anilist_checked: today,
        };
        const total = m ? (malType === 'anime' ? m.episodes : m.chapters) : null;
        if (!e.total && total) fields.total = total;
        if (malType === 'manga' && !e.total_volumes && m && m.volumes) fields.total_volumes = m.volumes;
        Object.assign(e, fields);
        updateEntryFields(e.source_id, e.media_type, fields);
      });
    }
  }
}

// ---------- Export ----------

// Builds the export for one MAL list ('anime' or 'manga'), saves it to
// Drive (replacing the last export there) when connected, and offers it
// to the share sheet. Hentai is left out. Returns { exported, skipped,
// hentai, drive: 'saved' | 'not connected' | error }.
export async function exportMalList(malType) {
  const all = entriesOnMalList(malType);
  const linked = all.filter((e) => e.mal_id);
  await refreshFromAniList(linked);
  const withId = linked.filter((e) => !isHentai(e));
  let user = {};
  try {
    user = JSON.parse(getSetting(`malUser_${malType}`, '{}')) || {};
  } catch (e) {
    user = {};
  }
  const xml = buildMalXml(malType, withId, user);
  const fileName = exportFileNameFor(malType);

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
      dialogTitle: `Export ${MAL_LISTS.find((l) => l.key === malType).label} list`,
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
export function normalizeTitle(title) {
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

// ---------- Sorting imports (AniList) ----------

const ANILIST_INFO_QUERY = `query ($ids: [Int], $type: MediaType) {
  Page(perPage: 50) {
    media(idMal_in: $ids, type: $type) { idMal countryOfOrigin title { english } coverImage { large } }
  }
}`;

// Map of MAL id → { country, english, cover } from AniList, 50 per
// request (job: a status-pill job, one step per request). Throws if
// AniList can't be reached.
export async function lookUpOnAniList(malType, malIds, job = null) {
  const info = new Map();
  for (let i = 0; i < malIds.length; i += 50) {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: ANILIST_INFO_QUERY,
        variables: { ids: malIds.slice(i, i + 50), type: malType === 'anime' ? 'ANIME' : 'MANGA' },
      }),
    });
    if (!res.ok) throw new Error(`AniList lookup failed (${res.status}).`);
    const json = await res.json();
    (json.data?.Page?.media || []).forEach((m) => {
      info.set(m.idMal, {
        country: m.countryOfOrigin,
        english: m.title?.english || null,
        cover: m.coverImage?.large || null,
      });
    });
    job?.step();
  }
  return info;
}

// ---------- Covers (AniList) ----------

// Entries on this MAL list with no cover whose cover AniList gave
// (`aniList` from lookUpOnAniList): each { entry, url }.
function coverTargets(malType, aniList) {
  return getAllEntries()
    .filter((e) => malTypeOf(e.media_type) === malType && e.mal_id && !e.local_image_path)
    .map((entry) => ({ entry, url: aniList.get(entry.mal_id)?.cover }))
    .filter((t) => t.url);
}

// Downloads the covers, a few at a time, into the same folders and names
// as covers saved while browsing, and queues them for Drive. Returns {
// downloaded, failed }.
async function downloadCovers(targets, job) {
  let downloaded = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const { entry, url } = targets[next++];
      try {
        const dir = `${FileSystem.documentDirectory}${entry.media_type}-covers/`;
        const info = await FileSystem.getInfoAsync(dir);
        if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const result = await FileSystem.downloadAsync(url, `${dir}${entry.source_id}.jpg`);
        if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
        setCoverImage(entry.source_id, entry.media_type, result.uri);
        downloaded++;
      } catch (err) {
        console.warn(`Cover download failed for ${entry.source_id}:`, err.message);
        failed++;
      }
      job.step();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { downloaded, failed };
}

// Which of the app's types an imported title belongs in: Korean titles
// on the manga list go to Manhwa (when the app has that type).
function typeForImport(malType, details) {
  const hasManhwa = MEDIA_TYPE_LIST.some((m) => m.key === 'manhwa');
  return malType === 'manga' && hasManhwa && details && details.country === 'KR' ? 'manhwa' : malType;
}

// An imported title (not opened on a site yet) of this type whose title or
// alternate title matches one of `titles`, or null.
export function findImportedByTitle(mediaType, titles) {
  const keys = titles.map(normalizeTitle).filter(Boolean);
  if (keys.length === 0) return null;
  return (
    getAllEntries(mediaType).find(
      (e) => isImportedSourceId(e.source_id) && [e.title, e.alt_title].some((t) => keys.includes(normalizeTitle(t)))
    ) || null
  );
}

// Brings a MAL item into an entry that's already in the library: fills
// in what it doesn't have and records what differs (merged with any
// differences still unsettled). Returns true if anything differs.
function mergeIntoEntry(entry, item, malId) {
  const columns = columnsFromMalItem(entry.media_type, item);
  const { fill, conflicts } = compareWithEntry(entry, columns);
  let previous = {};
  try {
    previous = entry.mal_conflicts ? JSON.parse(entry.mal_conflicts) : {};
  } catch (e) {
    previous = {};
  }
  const merged = { ...previous, ...conflicts };
  const hasConflicts = Object.keys(merged).length > 0;
  updateEntryFields(entry.source_id, entry.media_type, {
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
// and compares the ones that are. `aniList` (from lookUpOnAniList) sorts
// new titles into Manga/Manhwa and gives English titles; imported titles
// already in Manga that turn out to be Korean move to Manhwa. Returns {
// mediaType, added, linked, alreadyThere, differing, manhwa }.
export function importParsedList({ mediaType, user, items }, aniList = new Map()) {
  const format = FORMATS[mediaType];

  const listTypes = typesOnMalList(mediaType);
  const byId = (malId) => listTypes.map((type) => getEntryByMalId(malId, type)).find(Boolean);
  const byTitle = new Map();
  entriesOnMalList(mediaType).forEach((e) => {
    [e.title, e.alt_title].forEach((t) => {
      const key = normalizeTitle(t);
      if (key && !byTitle.has(key)) byTitle.set(key, e);
    });
  });

  let added = 0;
  let linked = 0;
  let alreadyThere = 0;
  let differing = 0;
  let manhwa = 0;

  items.forEach((item) => {
    const malId = Number(item[format.idField]);
    if (!malId) return;
    const title = item[format.titleField] || '';

    const details = aniList.get(malId);
    const sameId = byId(malId);
    if (sameId) {
      alreadyThere++;
      if (mergeIntoEntry(sameId, item, malId)) differing++;
      // Imported earlier, before titles were sorted: move it if it's manhwa.
      const type = typeForImport(mediaType, details);
      if (isImportedSourceId(sameId.source_id) && sameId.media_type !== type) {
        setEntryType(sameId.source_id, sameId.media_type, type);
        if (!sameId.alt_title && details && details.english && details.english !== sameId.title) {
          setAltTitle(sameId.source_id, type, details.english);
        }
        manhwa++;
      }
      return;
    }

    // Same title already recorded by browsing, but without its MAL id.
    const sameTitle = byTitle.get(normalizeTitle(title));
    if (sameTitle && !sameTitle.mal_id) {
      if (mergeIntoEntry(sameTitle, item, malId)) differing++;
      sameTitle.mal_id = malId;
      linked++;
      return;
    }

    const malData = JSON.stringify(item);
    const columns = columnsFromMalItem(mediaType, item);

    const type = typeForImport(mediaType, details);
    if (type !== mediaType) manhwa++;
    const english = details && details.english;
    restoreEntry({
      sourceId: `${IMPORTED_PREFIX}${malId}`,
      mediaType: type,
      title,
      altTitle: english && normalizeTitle(english) !== normalizeTitle(title) ? english : null,
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

  return { mediaType, added, linked, alreadyThere, differing, manhwa };
}

// Lets you pick a MAL export file and imports it, showing "Import" in
// the status pill. Returns null if the picker was cancelled. The import
// itself is done when this returns; covers for every title on that list
// that has none (`covers` of them) then download in the background, still
// in the pill, and `onCoversDone` runs (and is waited for) before the
// pill finishes.
export async function pickAndImportMalList({ onCoversDone } = {}) {
  const picked = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) return null;
  const job = beginSync('import', { show: true, total: 1 });
  let result;
  let targets = [];
  try {
    const text = await readPickedFile(picked.assets[0].uri);
    const parsed = parseMalXml(text);
    const format = FORMATS[parsed.mediaType];
    const ids = parsed.items.map((item) => Number(item[format.idField])).filter(Boolean);
    job.addTotal(Math.ceil(ids.length / 50));
    // Sorting into Manga/Manhwa, English titles and covers need AniList;
    // without it the import still runs (everything from the manga list
    // goes to Manga, with no covers).
    let aniList = new Map();
    let aniListFailed = false;
    try {
      aniList = await lookUpOnAniList(parsed.mediaType, ids, job);
    } catch (e) {
      aniListFailed = true;
    }
    result = { ...importParsedList(parsed, aniList), aniListFailed };
    job.step();
    targets = coverTargets(parsed.mediaType, aniList);
    job.addTotal(targets.length);
  } catch (err) {
    job.end({ ok: false, error: err.message });
    throw err;
  }

  (async () => {
    const { downloaded, failed } = await downloadCovers(targets, job);
    try {
      await onCoversDone?.({ downloaded, failed });
    } catch (e) {
      // Reported by whatever it ran (e.g. the Drive upload's own job).
    }
    job.end({
      summary: failed ? `${downloaded}/${targets.length} covers` : `Imported ${result.added}`,
    });
  })();

  return { ...result, covers: targets.length };
}
