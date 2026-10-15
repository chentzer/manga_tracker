import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('manga.db');

// `source_id` is the ID pulled straight from the URL (manga id, video id,
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

export function insertEntry({ sourceId, mediaType, title, altTitle, author, sourceUrl, localImagePath }) {
  // INSERT OR IGNORE closes the race between an entryExists() check and
  // this write (e.g. two rapid navigations to the same item).
  // read_status defaults to 'read' (not left unset) — you're actively
  // viewing the page as it's being saved, so "already read/watched" is
  // the sensible default rather than making every new entry start as
  // an unset/"want to" item you'd have to manually mark.
  db.runSync(
    `INSERT OR IGNORE INTO entries (source_id, media_type, title, alt_title, author, source_url, local_image_path, read_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'read')`,
    [sourceId, mediaType, title ?? null, altTitle ?? null, author ?? null, sourceUrl ?? null, localImagePath]
  );
}

export function markSynced(sourceId, mediaType, driveFileId) {
  db.runSync(
    "UPDATE entries SET drive_file_id = ?, sync_status = 'synced' WHERE source_id = ? AND media_type = ?",
    [driveFileId, sourceId, mediaType]
  );
}

// Inserts a full entry restored from a Drive CSV backup — unlike
// insertEntry (used when actively browsing), this accepts every field
// including score/tags/read_status/created_at, since a restore is
// bringing back data that already existed rather than recording
// something fresh. INSERT OR IGNORE means restoring never overwrites an
// entry that already exists locally.
export function restoreEntry({
  sourceId,
  mediaType,
  title,
  altTitle,
  author,
  score,
  tags,
  readStatus,
  sourceUrl,
  localImagePath,
  syncStatus,
  createdAt,
}) {
  db.runSync(
    `INSERT OR IGNORE INTO entries
     (source_id, media_type, title, alt_title, author, score, tags, read_status, source_url, local_image_path, sync_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceId,
      mediaType,
      title || null,
      altTitle || null,
      author || null,
      score || null,
      tags || null,
      readStatus || null,
      sourceUrl || null,
      localImagePath || null,
      syncStatus || 'pending',
      createdAt || null,
    ]
  );
}

export function markSyncFailed(sourceId, mediaType) {
  db.runSync(
    "UPDATE entries SET sync_status = 'failed' WHERE source_id = ? AND media_type = ?",
    [sourceId, mediaType]
  );
}

// score is 1-5, or null to clear a rating.
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

// status is 'read' | 'want_to_read' | null (unset).
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

export function deleteEntry(sourceId, mediaType) {
  db.runSync('DELETE FROM entries WHERE source_id = ? AND media_type = ?', [sourceId, mediaType]);
}

// Wipes every recorded entry. Used by the "Clear All" action in the
// library — callers are responsible for confirming with the user first
// and for cleaning up local image files, since this only touches the DB.
export function clearAllEntries() {
  db.execSync('DELETE FROM entries;');
}
