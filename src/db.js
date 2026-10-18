import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';
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
    // favorite: 1 = marked as a favourite (♥) in the Library, 0 = not.
    'favorite INTEGER DEFAULT 0',
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
  // Favourite artists (the Library's Artists view, artists.js), per media
  // type. Un-favourited artists are kept with favorite = 0 rather than
  // deleted, and updated_at (ms) says when that last changed, so the
  // Drive backup can tell which side's change is newer (backup.js).
  db.execSync(`
    CREATE TABLE IF NOT EXISTS artist_favorites (
      media_type TEXT NOT NULL,
      name TEXT NOT NULL,
      favorite INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (media_type, name)
    );
  `);
  // Notepad: only ever holds notes written on THIS device.
  // Drive keeps a merged copy of every device's notes (see notepadSync.js),
  // but nothing is ever restored from Drive into this table — each
  // device only sees what it added itself.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Named notes ("Grocery list", ...). Each item in `notes` belongs to
  // one via notebook_id; NULL means the built-in Inbox, which is where
  // anything shared in from another app lands (no unlock needed, so no
  // choosing a destination either — items get moved later in-app).
  db.execSync(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try {
    db.execSync('ALTER TABLE notes ADD COLUMN notebook_id INTEGER;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  // uid: a stable id per item, so the Drive sync can tell "the same
  // item, now moved to another note" apart from "a new item", and remove
  // exactly the items deleted one by one. Backfilled for older items.
  try {
    db.execSync('ALTER TABLE notes ADD COLUMN uid TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  for (const row of db.getAllSync('SELECT id FROM notes WHERE uid IS NULL')) {
    db.runSync('UPDATE notes SET uid = ? WHERE id = ?', [Crypto.randomUUID(), row.id]);
  }
  // updated_at (ISO): when this note was created here, or the time
  // another device created it if it was picked up from Drive. Compared
  // against deletions from other devices to decide which happened last.
  try {
    db.execSync('ALTER TABLE notebooks ADD COLUMN updated_at TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  // Notes deleted on this device, remembered until the next successful
  // Drive sync tells the other devices to delete them too. Keyed by
  // lowercase title, since note names are unique case-insensitively.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS notebook_tombstones (
      title_key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
  `);
  // Drive deletion rule: deleting ONE item on the phone removes it from
  // Drive; deleting a whole note keeps it and its items in Drive. This
  // table remembers single deletes until the next successful Drive sync
  // has removed them there. Whole-note deletes never write to it.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS note_item_tombstones (
      uid TEXT PRIMARY KEY
    );
  `);
  initEntrySync();

  // App lock (AppLock.js): off on a fresh install. Builds before this
  // setting existed always locked, so an update from one of those keeps
  // the lock on. Once set, it's only ever changed from Settings.
  if (getSetting('appLockEnabled') === null) {
    setSetting('appLockEnabled', existingInstall ? '1' : '0');
  }
}

// Two-way Drive sync of entries (backup.js mergeLibraryFromDrive, and the
// browser extension in extension/): every entry carries updated_at, the
// last time its details changed anywhere (ISO, UTC), and deletions are
// remembered in entry_tombstones with the time they happened, so the
// newer side wins. Triggers keep both up to date for every write in the
// app: a change to an entry's details stamps it (unless the write sets
// updated_at itself, as the Drive merge does), and deleting an entry or
// moving it to another code or type (adopting an imported title, sorting
// manga into manhwa) leaves a tombstone for the old one.
const ENTRY_DATA_COLUMNS = [
  'source_id', 'media_type', 'title', 'alt_title', 'author', 'score', 'tags', 'read_status',
  'source_url', 'mal_id', 'mal_data', 'start_date', 'finish_date', 'progress',
  'progress_volumes', 'total', 'total_volumes', 'times_repeated', 'repeating', 'priority',
  'comments', 'series_type', 'genres', 'is_adult', 'mal_conflicts', 'last_progress_url',
  'repeat_progress', 'group_name', 'group_order', 'favorite',
];
const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function initEntrySync() {
  try {
    db.execSync('ALTER TABLE entries ADD COLUMN updated_at TEXT;');
  } catch (e) {
    // Column already exists — nothing to do.
  }
  db.execSync(`
    CREATE TABLE IF NOT EXISTS entry_tombstones (
      source_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (source_id, media_type)
    );
    CREATE TRIGGER IF NOT EXISTS entries_sync_insert AFTER INSERT ON entries
    BEGIN
      DELETE FROM entry_tombstones WHERE source_id = NEW.source_id AND media_type = NEW.media_type;
      UPDATE entries SET updated_at = ${NOW_ISO} WHERE id = NEW.id AND updated_at IS NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS entries_sync_update AFTER UPDATE ON entries
    WHEN NEW.updated_at IS OLD.updated_at AND (${ENTRY_DATA_COLUMNS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')})
    BEGIN
      UPDATE entries SET updated_at = ${NOW_ISO} WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS entries_sync_rekey AFTER UPDATE OF source_id, media_type ON entries
    WHEN OLD.source_id IS NOT NEW.source_id OR OLD.media_type IS NOT NEW.media_type
    BEGIN
      INSERT OR REPLACE INTO entry_tombstones (source_id, media_type, deleted_at)
        VALUES (OLD.source_id, OLD.media_type, ${NOW_ISO});
      DELETE FROM entry_tombstones WHERE source_id = NEW.source_id AND media_type = NEW.media_type;
    END;
    CREATE TRIGGER IF NOT EXISTS entries_sync_delete AFTER DELETE ON entries
    BEGIN
      INSERT OR REPLACE INTO entry_tombstones (source_id, media_type, deleted_at)
        VALUES (OLD.source_id, OLD.media_type, ${NOW_ISO});
    END;
  `);
  // Deletions older than half a year have reached every device by now.
  db.runSync(`DELETE FROM entry_tombstones WHERE deleted_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days')`);
}

// Deleted entries of one type: [{ source_id, media_type, deleted_at }].
export function getEntryTombstones(mediaType) {
  return db.getAllSync('SELECT * FROM entry_tombstones WHERE media_type = ?', [mediaType]);
}

export function getEntryTombstone(sourceId, mediaType) {
  return db.getFirstSync('SELECT * FROM entry_tombstones WHERE source_id = ? AND media_type = ?', [
    sourceId,
    mediaType,
  ]);
}

// Records a deletion that happened elsewhere: the later time wins, or
// with `exact`, this time (an entry just deleted here because of it,
// whose own tombstone says "now").
export function putEntryTombstone(sourceId, mediaType, deletedAt, { exact = false } = {}) {
  db.runSync(
    `INSERT INTO entry_tombstones (source_id, media_type, deleted_at) VALUES (?, ?, ?)
     ON CONFLICT (source_id, media_type) DO UPDATE SET deleted_at = ${
       exact ? 'excluded.deleted_at' : 'MAX(deleted_at, excluded.deleted_at)'
     }`,
    [sourceId, mediaType, deletedAt]
  );
}

// Takes an entry's details from Drive (a newer change made elsewhere),
// including its updated_at, so the update isn't stamped as a new change.
const SYNCED_COLUMNS = ['title', 'alt_title', 'author', 'source_url', 'updated_at'];
export function applySyncedFields(sourceId, mediaType, fields) {
  const keys = Object.keys(fields).filter((k) => SYNCED_COLUMNS.includes(k) || EDITABLE_COLUMNS.includes(k));
  if (keys.length === 0) return;
  db.runSync(
    `UPDATE entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE source_id = ? AND media_type = ?`,
    [...keys.map((k) => (fields[k] === undefined ? null : fields[k])), sourceId, mediaType]
  );
}

function hasColumn(name) {
  return db.getAllSync('PRAGMA table_info(entries)').some((c) => c.name === name);
}

export const INBOX_TITLE = 'Inbox';

// notebookId null/undefined = Inbox.
export function addNote(content, notebookId = null) {
  db.runSync('INSERT INTO notes (content, notebook_id, uid) VALUES (?, ?, ?)', [
    content,
    notebookId ?? null,
    Crypto.randomUUID(),
  ]);
}

// One note's items, newest first, for display.
export function getNotes(notebookId = null) {
  if (notebookId == null) {
    return db.getAllSync('SELECT * FROM notes WHERE notebook_id IS NULL ORDER BY id DESC');
  }
  return db.getAllSync('SELECT * FROM notes WHERE notebook_id = ? ORDER BY id DESC', [notebookId]);
}

// Deleting a single item: it also leaves Drive at the next sync.
export function deleteNote(id) {
  const row = db.getFirstSync('SELECT uid FROM notes WHERE id = ?', [id]);
  db.runSync('DELETE FROM notes WHERE id = ?', [id]);
  if (row?.uid) {
    db.runSync('INSERT OR IGNORE INTO note_item_tombstones (uid) VALUES (?)', [row.uid]);
  }
}

export function getNoteItemTombstones() {
  return db.getAllSync('SELECT uid FROM note_item_tombstones').map((r) => r.uid);
}

// Called after a successful Drive sync has removed these from Drive.
export function clearNoteItemTombstones(uids) {
  for (const uid of uids) {
    db.runSync('DELETE FROM note_item_tombstones WHERE uid = ?', [uid]);
  }
}

export function moveNote(id, notebookId) {
  db.runSync('UPDATE notes SET notebook_id = ? WHERE id = ?', [notebookId ?? null, id]);
}

export function getNotebooks() {
  return db.getAllSync('SELECT * FROM notebooks ORDER BY title COLLATE NOCASE');
}

// Item counts keyed by notebook id, with the Inbox under 'inbox'.
export function getNoteCounts() {
  const counts = { inbox: 0 };
  for (const row of db.getAllSync('SELECT notebook_id, COUNT(*) AS n FROM notes GROUP BY notebook_id')) {
    counts[row.notebook_id == null ? 'inbox' : row.notebook_id] = row.n;
  }
  return counts;
}

// Throws with a user-facing message on an empty, reserved, or
// duplicate (case-insensitive) title. Returns the new notebook's id.
// updatedAt is only passed when creating a note picked up from another
// device via Drive (its original creation time); otherwise it's now.
export function createNotebook(title, updatedAt = null) {
  const clean = title.trim();
  if (!clean) throw new Error('Give the note a name.');
  if (clean.toLowerCase() === INBOX_TITLE.toLowerCase()) {
    throw new Error(`"${INBOX_TITLE}" is reserved for shared items.`);
  }
  if (db.getFirstSync('SELECT id FROM notebooks WHERE title = ? COLLATE NOCASE', [clean])) {
    throw new Error(`A note called "${clean}" already exists.`);
  }
  // Re-creating a note deleted earlier here cancels that pending delete.
  db.runSync('DELETE FROM notebook_tombstones WHERE title_key = ?', [clean.toLowerCase()]);
  return db.runSync('INSERT INTO notebooks (title, updated_at) VALUES (?, ?)', [
    clean,
    updatedAt || new Date().toISOString(),
  ]).lastInsertRowId;
}

// keepItems: true moves its items to the Inbox first; false deletes them
// from this device only — deliberately no item tombstones, so Drive
// keeps the whole note and its items either way.
// fromSync: true when applying a delete made on another device — no
// tombstone, since that device already told Drive.
export function deleteNotebook(id, keepItems, fromSync = false) {
  const book = db.getFirstSync('SELECT title FROM notebooks WHERE id = ?', [id]);
  if (keepItems) {
    db.runSync('UPDATE notes SET notebook_id = NULL WHERE notebook_id = ?', [id]);
  } else {
    db.runSync('DELETE FROM notes WHERE notebook_id = ?', [id]);
  }
  db.runSync('DELETE FROM notebooks WHERE id = ?', [id]);
  if (book && !fromSync) {
    db.runSync(
      `INSERT INTO notebook_tombstones (title_key, title, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT(title_key) DO UPDATE SET title = excluded.title, deleted_at = excluded.deleted_at`,
      [book.title.toLowerCase(), book.title, new Date().toISOString()]
    );
  }
}

export function getNotebookTombstones() {
  return db.getAllSync('SELECT * FROM notebook_tombstones');
}

// Called after a successful Drive sync has recorded these deletes.
// Only clears ones not re-deleted since (deleted_at unchanged).
export function clearNotebookTombstones(tombstones) {
  for (const t of tombstones) {
    db.runSync('DELETE FROM notebook_tombstones WHERE title_key = ? AND deleted_at = ?', [t.title_key, t.deleted_at]);
  }
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

// [{ media_type, name, favorite, updated_at }] — every artist ever
// favourited, including ones since un-favourited (favorite = 0).
export function getArtistFavorites(mediaType = null) {
  return mediaType
    ? db.getAllSync('SELECT * FROM artist_favorites WHERE media_type = ?', [mediaType])
    : db.getAllSync('SELECT * FROM artist_favorites');
}

export function setArtistFavorite(mediaType, name, favorite, updatedAt = Date.now()) {
  db.runSync(
    `INSERT INTO artist_favorites (media_type, name, favorite, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(media_type, name) DO UPDATE SET favorite = excluded.favorite, updated_at = excluded.updated_at`,
    [mediaType, name, favorite ? 1 : 0, updatedAt]
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
  'favorite',
  // When its details last changed (two-way Drive sync, initEntrySync).
  'updated_at',
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
       local_image_path = COALESCE(?, local_image_path),
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

// Sets an entry's cover file and queues it for upload to Drive.
export function setCoverImage(sourceId, mediaType, localImagePath) {
  db.runSync(
    "UPDATE entries SET local_image_path = ?, sync_status = 'pending' WHERE source_id = ? AND media_type = ?",
    [localImagePath, sourceId, mediaType]
  );
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
