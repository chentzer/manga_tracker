// What a visit to a page does to the library, on the rows of a type's
// backup file (strings, as in the CSV). The same rules as the app's tabs
// (src/MediaWebView.js applyProgress / recordProgress). Pure functions,
// so they can be tested on their own (extension/test/).
import { normalizeTitle } from './csv.js';

export const nowIso = () => new Date().toISOString();
// The app's created_at format (SQLite CURRENT_TIMESTAMP, UTC).
export const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const num = (value) => Number(value) || 0;
export const isImportedId = (id) => String(id || '').startsWith('mal-');

export function findRow(rows, sourceId) {
  return rows.find((r) => r.source_id === sourceId && !r.deleted_at) || null;
}

// A title imported from a MyAnimeList list that this page is (by MAL id,
// or by title), so it's linked instead of recorded twice.
export function findImported(rows, malId, titles) {
  const live = rows.filter((r) => !r.deleted_at && isImportedId(r.source_id));
  if (malId) {
    const byId = live.find((r) => num(r.mal_id) === Number(malId));
    if (byId) return byId;
  }
  const keys = titles.map(normalizeTitle).filter(Boolean);
  if (!keys.length) return null;
  return live.find((r) => [r.title, r.alt_title].some((t) => keys.includes(normalizeTitle(t)))) || null;
}

// Marks a row changed (two-way sync: the newer side wins).
export function touch(row) {
  row.updated_at = nowIso();
}

// Removes a code from the file the way the app does: a deletion row, so
// the other side drops it too.
export function tombstone(rows, mediaType, sourceId) {
  const at = nowIso();
  const existing = rows.find((r) => r.source_id === sourceId && r.deleted_at);
  if (existing) existing.deleted_at = at;
  else rows.push({ media_type: mediaType, source_id: sourceId, deleted_at: at });
}

// Opening episode/chapter `number`: the series is Reading, progress moves
// forward, and the last chapter of a reread finishes it. Returns null if
// nothing changed, else { finishedRepeat } (the row is changed in place).
export function recordProgress(row, number, url) {
  const repeating = row.read_status === 'read' && num(row.repeating) === 1;
  const current = num(repeating ? row.repeat_progress : row.progress);
  const fields = {};
  if (!repeating && row.read_status !== 'reading') {
    fields.read_status = 'reading';
    if (!row.start_date) fields.start_date = today();
  }
  if (number > current) fields[repeating ? 'repeat_progress' : 'progress'] = String(number);
  if (number >= current && url && url !== row.last_progress_url) fields.last_progress_url = url;
  if (Object.keys(fields).length === 0) return null;
  const finishedRepeat = repeating && num(row.total) > 0 && number >= num(row.total);
  if (finishedRepeat) {
    fields.repeating = '0';
    fields.repeat_progress = '0';
    fields.times_repeated = String(num(row.times_repeated) + 1);
  }
  Object.assign(row, fields);
  touch(row);
  return { finishedRepeat };
}

// What opening episode/chapter `chapter` of a recorded series should do:
// { ask: 'repeat' } for a completed series, { ask: 'ahead', current } when
// it's more than one past the record, else { record: number }. A chapter
// 0 counts as 1 when it's the whole title (a total of 1). fresh: the
// series was recorded just now, so there's no record to be ahead of.
export function progressDecision(row, chapter, { fresh = false } = {}) {
  if (chapter === null || chapter === undefined || Number.isNaN(chapter)) return null;
  const number = chapter === 0 && num(row.total) === 1 ? 1 : chapter;
  if (row.read_status === 'read' && num(row.repeating) !== 1) return { ask: 'repeat', number };
  const repeating = row.read_status === 'read' && num(row.repeating) === 1;
  const current = num(repeating ? row.repeat_progress : row.progress);
  if (!fresh && number > current + 1 && !(repeating && current === 0)) return { ask: 'ahead', number, current };
  return { record: number };
}

// A new row for a title seen on a site.
export function newRow(mediaType, sourceId, details) {
  const row = {
    media_type: mediaType,
    source_id: sourceId,
    title: details.title || '',
    alt_title: details.altTitle || '',
    author: details.author || '',
    read_status: 'want_to_read',
    source_url: details.sourceUrl || '',
    sync_status: details.coverSaved ? 'synced' : 'pending',
    created_at: sqlNow(),
    mal_id: details.malId ? String(details.malId) : '',
    favorite: '0',
  };
  touch(row);
  return row;
}

// Links an imported title to its page on a site (the app's
// adoptImportedEntry): it takes the site's code, address and details,
// keeping status, score, tags and MAL fields; the MAL title stays as the
// alternate title when the site gives none. The old code is left as a
// deletion row.
export function adoptImported(rows, mediaType, row, sourceId, details) {
  const oldId = row.source_id;
  if (details.altTitle) row.alt_title = details.altTitle;
  else if (details.title && row.title !== details.title) row.alt_title = row.title;
  if (details.title) row.title = details.title;
  if (details.author) row.author = details.author;
  row.source_id = sourceId;
  row.source_url = details.sourceUrl || row.source_url;
  if (details.coverSaved) row.sync_status = 'synced';
  touch(row);
  tombstone(rows, mediaType, oldId);
}

// Genres that mark a title 18+ (as the app's isAdultTitle).
const ADULT_GENRE = /^(hentai|adult|18\+|r-?18|smut|pornographic)$/i;
export function hasAdultGenre(genres) {
  const text = Array.isArray(genres) ? genres.join(',') : genres || '';
  return text.split(/[,;|/]/).some((g) => ADULT_GENRE.test(g.trim()));
}
