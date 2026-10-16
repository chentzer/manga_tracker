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
// (see adoptImportedEntry in db.js). A title already in the library but
// without a MAL id gets it, plus any MAL details it doesn't have yet.
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
import { FORMATS, columnsFromMalItem, malItemFromEntry } from './malFormat';

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

// ---------- Export ----------

// Builds the export for one type, saves it to Drive (replacing the last
// export there) when connected, and offers it to the share sheet.
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

// Only the columns an entry doesn't have a value for yet.
function missingColumns(entry, columns) {
  const result = {};
  Object.entries(columns).forEach(([key, value]) => {
    const current = entry[key];
    if ((current === null || current === undefined || current === 0 || current === '') && value) {
      result[key] = value;
    }
  });
  return result;
}

// Adds the titles in a parsed MAL export that aren't in the library yet.
// Returns { mediaType, added, linked, alreadyThere }.
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

  items.forEach((item) => {
    const malId = Number(item[format.idField]);
    if (!malId) return;
    if (getEntryByMalId(malId, mediaType)) {
      alreadyThere++;
      return;
    }
    const malData = JSON.stringify(item);
    const title = item[format.titleField] || '';
    const columns = columnsFromMalItem(mediaType, item);

    // Same title already recorded by browsing, but without its MAL id:
    // give it the id and whatever MAL details it doesn't have yet.
    const sameTitle = byTitle.get(normalizeTitle(title));
    if (sameTitle && !sameTitle.mal_id) {
      updateEntryFields(sameTitle.source_id, mediaType, {
        ...missingColumns(sameTitle, columns),
        mal_id: malId,
        mal_data: malData,
      });
      sameTitle.mal_id = malId;
      linked++;
      return;
    }

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
