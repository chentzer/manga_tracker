import * as SQLite from 'expo-sqlite';
import { columnsFromMalItem } from './malFormat';

const db = SQLite.openDatabaseSync('manga.db');

// `source_id` is the ID pulled straight from the URL (manga id, anime id,
// etc.) — this is the dedup key, since it's guaranteed unique on the
// source site. `title` is separate and purely for display: titles can be
// missing, slow to load, or coincidentally shared between two different
// items, so they're not safe to dedup on.
export function initDb() {
  // Checked before anything is created: an existing `entries` table means
  // this is an update of an install, not a fresh one (see appLockEnabled
  // below).
  const existingInstall = !!db.getFirstSync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'"
  );

  db.execSync(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      title TEXT,
      author TEXT,
      score INTEGER,
      source_url TEXT,
      local_image_path TEXT,
      drive_file_id TEXT,
      sync_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_id, media_type)
    );
  `);

  // Migration for installs that created the table before `score` existed.
  // ALTER TABLE ADD COLUMN throws if the column is already there, so this
  // is wrapped rather than run unconditionally.
  try {
    db.execSync('ALTER TABLE entries ADD COLUMN score INTEGER;');
  } catch (e) {
    // Column already exists — nothing to do.
  }

  // tags: comma-separated free text (e.g. "romance,slice of life") —
  // simple enough for personal-scale use without needing a separate
  // join table. read_status: 'read' | 'want_to_read' | null (unset).
  try {
    db.execSync('ALTER TABLE entries ADD COLUMN tags TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  try {
    db.execSync('ALTER TABLE entries ADD COLUMN read_status TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  // alt_title: a secondary title in another language/script — e.g. the
  // original Japanese title alongside the English one.
  // Generic, so any media type can use it if a site
  // exposes more than one title.
  try {
    db.execSync('ALTER TABLE entries ADD COLUMN alt_title TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }

  // mal_id: the entry's MyAnimeList id, read from the site's link to
  // MyAnimeList (or from an imported MAL list). mal_data: the MAL fields
  // from an imported list that have no column of their own, as JSON, so
  // an export can give back exactly what came in. The rest mirror MAL's
  // own list fields (dates, progress, ...) — see malFormat.js.
  const hadMalColumns = hasColumn('start_date');
  [
    'mal_id INTEGER',
    'mal_data TEXT',
    'start_date TEXT',
    'finish_date TEXT',
    'progress INTEGER',
    'progress_volumes INTEGER',
    'total INTEGER',
    'total_volumes INTEGER',
    'times_repeated INTEGER',
    'repeating INTEGER',
    'priority TEXT',
    'comments TEXT',
    'series_type TEXT',
    // genres: comma-separated, from AniList by MAL id (malList.js), with
    // is_adult (1 for hentai) — used to leave hentai out of exports.
    'genres TEXT',
    'is_adult INTEGER',
    // mal_conflicts: JSON { column: value in your MAL list } for details
    // where an imported list disagrees with the app, until you settle
    // them in the detail sheet.
    'mal_conflicts TEXT',
    // last_progress_url: the last episode/chapter page you opened, for
    // "Watch next" / "Read next".
    'last_progress_url TEXT',
    // repeat_progress: how far the current rewatch/reread is.
    'repeat_progress INTEGER',
    // anilist_checked: the day totals/genres were last looked up on
    // AniList (malList.js), so unknown totals are asked about once a day.
    'anilist_checked TEXT',
    // group_name / group_order: the group a book is in and its place
    // there (types with groupField; src/groups.js).
    'group_name TEXT',
    'group_order INTEGER',
  ].forEach((column) => {
    try {
      db.execSync(`ALTER TABLE entries ADD COLUMN ${column};`);
    } catch (e) {
      // Column already exists — nothing to do.
    }
  });
  // Scores went from 1-5 stars to MAL's 1-10. Done once, when the MAL
  // columns arrive: entries imported from MAL get their exact score (and
  // dates, progress, ...) back from mal_data; the rest are doubled.
  if (!hadMalColumns) {
    db.withTransactionSync(() => {
      db.getAllSync('SELECT source_id, media_type, score, mal_data FROM entries').forEach((row) => {
        let item = null;
        try {
          item = row.mal_data ? JSON.parse(row.mal_data) : null;
        } catch (e) {
          item = null;
        }
        if (item) {
          // Status and tags stay as set in the app; so does the score,
          // if it was re-rated since the import.
          const { tags, read_status, ...columns } = columnsFromMalItem(row.media_type, item);
          const importedStars = columns.score ? Math.max(1, Math.round(columns.score / 2)) : null;
          if ((row.score || null) !== importedStars) columns.score = row.score ? row.score * 2 : null;
          updateEntryFields(row.source_id, row.media_type, columns);
        } else if (row.score) {
          updateEntryFields(row.source_id, row.media_type, { score: row.score * 2 });
        }
      });
    });
  }

  // The "video" type was renamed to "anime"; carry existing entries over.
  db.runSync("UPDATE entries SET media_type = 'anime' WHERE media_type = 'video'");

  // Generic key-value store for small app preferences (e.g. whether
  // debug tools are shown) — not worth a whole new storage mechanism
  // when SQLite is already here.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // App lock (AppLock.js): off on a fresh install. Builds before this
  // setting existed always locked, so an update from one of those keeps
  // the lock on. Once set, it's only ever changed from Settings.
  if (getSetting('appLockEnabled') === null) {
    setSetting('appLockEnabled', existingInstall ? '1' : '0');
  }
}

function hasColumn(name) {
  return db.getAllSync('PRAGMA table_info(entries)').some((c) => c.name === name);
}

// Values are always stored/read as strings — callers compare/convert as
// needed (e.g. getSetting('showDebugTools', '0') === '1' for a boolean).
export function getSetting(key, defaultValue = null) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

export function setSetting(key, value) {
  db.runSync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

export function entryExists(sourceId, mediaType) {
  const row = db.getFirstSync(
    'SELECT id FROM entries WHERE source_id = ? AND media_type = ?',
    [sourceId, mediaType]
  );
  return !!row;
}

export function getEntry(sourceId, mediaType) {
  return db.getFirstSync(
    'SELECT * FROM entries WHERE source_id = ? AND media_type = ?',
    [sourceId, mediaType]
  );
}

export function getEntryByMalId(malId, mediaType) {
  return db.getFirstSync(
    'SELECT * FROM entries WHERE mal_id = ? AND media_type = ?',
    [malId, mediaType]
  );
}

export function setMalId(sourceId, mediaType, malId) {
  db.runSync(
    'UPDATE entries SET mal_id = ? WHERE source_id = ? AND media_type = ?',
    [malId, sourceId, mediaType]
  );
}

// Columns that can be set through updateEntryFields / restoreEntry.
export const EDITABLE_COLUMNS = [
  'score',
  'tags',
  'read_status',
  'start_date',
  'finish_date',
  'progress',
  'progress_volumes',
  'total',
  'total_volumes',
  'times_repeated',
  'repeating',
  'priority',
  'comments',
  'series_type',
  'mal_id',
  'mal_data',
  'genres',
  'is_adult',
  'mal_conflicts',
  'last_progress_url',
  'repeat_progress',
  'anilist_checked',
  'group_name',
  'group_order',
];

// Sets any of EDITABLE_COLUMNS on one entry, e.g. { progress: 12 }.
export function updateEntryFields(sourceId, mediaType, fields) {
  const keys = Object.keys(fields).filter((k) => EDITABLE_COLUMNS.includes(k));
  if (keys.length === 0) return;
  db.runSync(
    `UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE source_id = ? AND media_type = ?`,
    [...keys.map((k) => (fields[k] === undefined ? null : fields[k])), sourceId, mediaType]
  );
}

// Turns an entry imported from a MAL list (source_id "mal-<id>", no
// cover) into a normal one once you open that title on the site: it
// takes the site's id, URL, cover and details, and keeps your status,
// score, tags and MAL fields. The MAL title is kept as the alternate
// title when the site doesn't give one.
export function adoptImportedEntry(oldSourceId, mediaType, { sourceId, title, altTitle, author, sourceUrl, localImagePath }) {
  db.runSync(
    `UPDATE entries SET
       source_id = ?,
       alt_title = COALESCE(?, CASE WHEN ? IS NULL OR title = ? THEN alt_title ELSE title END),
       title = COALESCE(?, title),
       author = COALESCE(?, author),
       source_url = ?,
       local_image_path = ?,
       sync_status = 'pending'
     WHERE source_id = ? AND media_type = ?`,
    [
      sourceId,
      altTitle ?? null,
      title ?? null,
      title ?? null,
      title ?? null,
      author ?? null,
      sourceUrl ?? null,
      localImagePath ?? null,
      oldSourceId,
      mediaType,
    ]
  );
}

export function insertEntry({ sourceId, mediaType, title, altTitle, author, sourceUrl, localImagePath, malId }) {
  // INSERT OR IGNORE closes the race between an entryExists() check and
  // this write (e.g. two rapid navigations to the same item).
  // read_status starts as 'want_to_read' (MAL's "Plan to Read/Watch"):
  // opening a series page doesn't mean you've read it. Opening one of
  // its episodes/chapters moves it to 'reading' (MediaWebView.js).
  db.runSync(
    `INSERT OR IGNORE INTO entries (source_id, media_type, title, alt_title, author, source_url, local_image_path, read_status, mal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'want_to_read', ?)`,
    [sourceId, mediaType, title ?? null, altTitle ?? null, author ?? null, sourceUrl ?? null, localImagePath, malId ?? null]
  );
}

export function markSynced(sourceId, mediaType, driveFileId) {
  db.runSync(
    "UPDATE entries SET drive_file_id = ?, sync_status = 'synced' WHERE source_id = ? AND media_type = ?",
    [driveFileId, sourceId, mediaType]
  );
}

// Inserts a full entry restored from a Drive CSV backup or imported from
// a MyAnimeList list — unlike insertEntry (used when actively browsing),
// this accepts every field, since it's bringing back data that already
// existed rather than recording something fresh. Besides the fields
// named below it takes any of EDITABLE_COLUMNS by column name (score,
// read_status, start_date, ...). INSERT OR IGNORE means it never
// overwrites an entry that already exists locally.
export function restoreEntry({
  sourceId,
  mediaType,
  title,
  altTitle,
  author,
  sourceUrl,
  localImagePath,
  syncStatus,
  createdAt,
  malId,
  malData,
  ...columns
}) {
  const fields = {
    source_id: sourceId,
    media_type: mediaType,
    title: title || null,
    alt_title: altTitle || null,
    author: author || null,
    source_url: sourceUrl || null,
    local_image_path: localImagePath || null,
    sync_status: syncStatus || 'pending',
    mal_id: malId || null,
    mal_data: malData || null,
  };
  EDITABLE_COLUMNS.forEach((k) => {
    if (columns[k] !== undefined && columns[k] !== '') fields[k] = columns[k];
  });
  const keys = Object.keys(fields);
  db.runSync(
    `INSERT OR IGNORE INTO entries (${keys.join(', ')}, created_at)
     VALUES (${keys.map(() => '?').join(', ')}, COALESCE(?, CURRENT_TIMESTAMP))`,
    [...keys.map((k) => fields[k]), createdAt || null]
  );
}

export function markSyncFailed(sourceId, mediaType) {
  db.runSync(
    "UPDATE entries SET sync_status = 'failed' WHERE source_id = ? AND media_type = ?",
    [sourceId, mediaType]
  );
}

// score is 1-10 (MyAnimeList's scale), or null to clear a rating.
export function setScore(sourceId, mediaType, score) {
  db.runSync(
    'UPDATE entries SET score = ? WHERE source_id = ? AND media_type = ?',
    [score, sourceId, mediaType]
  );
}

// Normalizes a list of raw tag strings: trims whitespace, drops empties,
// dedupes case-insensitively while keeping the first-seen casing.
export function normalizeTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

// Parses the stored comma-separated tags field into an array. Safe to
// call on null/undefined/empty.
export function parseTags(tagsField) {
  if (!tagsField) return [];
  return normalizeTags(tagsField.split(','));
}

// Replaces an entry's full tag list with the given array.
export function setTags(sourceId, mediaType, tags) {
  const csv = normalizeTags(tags).join(',');
  db.runSync(
    'UPDATE entries SET tags = ? WHERE source_id = ? AND media_type = ?',
    [csv || null, sourceId, mediaType]
  );
}

// status is null (unset) or one of MyAnimeList's five list statuses:
// 'reading' (reading/watching), 'read' (completed), 'on_hold',
// 'dropped', 'want_to_read' (plan to read/watch).
export function setReadStatus(sourceId, mediaType, status) {
  db.runSync(
    'UPDATE entries SET read_status = ? WHERE source_id = ? AND media_type = ?',
    [status, sourceId, mediaType]
  );
}

export function getAllEntries(mediaType = null) {
  if (mediaType) {
    return db.getAllSync(
      'SELECT * FROM entries WHERE media_type = ? ORDER BY created_at DESC',
      [mediaType]
    );
  }
  return db.getAllSync('SELECT * FROM entries ORDER BY created_at DESC');
}

export function getPendingSyncEntries() {
  return db.getAllSync("SELECT * FROM entries WHERE sync_status != 'synced'");
}

export function setAltTitle(sourceId, mediaType, altTitle) {
  db.runSync('UPDATE entries SET alt_title = ? WHERE source_id = ? AND media_type = ?', [
    altTitle,
    sourceId,
    mediaType,
  ]);
}

// Moves an entry to another type (e.g. an imported title that turns out
// to be manhwa).
export function setEntryType(sourceId, fromType, toType) {
  db.runSync('UPDATE entries SET media_type = ? WHERE source_id = ? AND media_type = ?', [
    toType,
    sourceId,
    fromType,
  ]);
}

export function deleteEntry(sourceId, mediaType) {
  db.runSync('DELETE FROM entries WHERE source_id = ? AND media_type = ?', [sourceId, mediaType]);
}

// Wipes every recorded entry. Used by the "Clear All" action in the
// library — callers are responsible for confirming with the user first
// and for cleaning up local image files, since this only touches the DB.
export function clearAllEntries() {
  db.execSync('DELETE FROM entries;');
}
