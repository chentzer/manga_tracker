import {
  getAllEntries,
  getPendingSyncEntries,
  markSynced,
  markSyncFailed,
  entryExists,
  restoreEntry,
  EDITABLE_COLUMNS,
  getArtistFavorites,
  setArtistFavorite,
  getEntry,
  deleteEntry,
  getEntryTombstones,
  getEntryTombstone,
  putEntryTombstone,
  applySyncedFields,
} from './db';
import * as FileSystem from 'expo-file-system/legacy';
import { MEDIA_TYPE_LIST } from './mediaTypes';
import { driveSyncAllowed, markDriveSyncDeferred } from './dataSaver';
import { beginSync } from './syncStatus';
import {
  backupCsvToDrive,
  uploadImageToDrive,
  buildDriveDisplayName,
  isDriveConnected,
  fetchBackupCsvContent,
  downloadCoverForRestore,
} from './GoogleDriveService';

const COLUMNS = [
  'media_type',
  'source_id',
  'title',
  'alt_title',
  'author',
  'score',
  'tags',
  'read_status',
  'source_url',
  'sync_status',
  'created_at',
  'mal_id',
  'mal_data',
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
  'genres',
  'is_adult',
  'mal_conflicts',
  'last_progress_url',
  'repeat_progress',
  'anilist_checked',
  'group_name',
  'group_order',
  'favorite',
  // Two-way sync (initEntrySync in db.js; also written by the browser
  // extension): when the row's details last changed, and on rows that
  // only say an entry was deleted, when that happened.
  'updated_at',
  'deleted_at',
];

// Number columns: a CSV gives back strings.
const NUMBER_COLUMNS = [
  'score',
  'mal_id',
  'progress',
  'progress_volumes',
  'total',
  'total_volumes',
  'times_repeated',
  'repeating',
  'is_adult',
  'repeat_progress',
  'group_order',
  'favorite',
];

// Each media type gets its own backup file (e.g. "manga-backup.csv",
// "anime-backup.csv") rather than one combined "library-backup.csv" —
// keeps them separate and easy to browse/open individually in Drive.
function backupFileNameFor(mediaType) {
  return `${mediaType}-backup.csv`;
}

// Favourite artists (artists.js) go to their own file.
const ARTIST_FAVORITES_FILE = 'favorite-artists.csv';
const ARTIST_FAVORITE_COLUMNS = ['media_type', 'name', 'favorite', 'updated_at'];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Quote any field containing a comma, quote, or newline, doubling
  // internal quotes — standard CSV escaping so Excel/Sheets parse it
  // correctly regardless of what's in a title or URL.
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(rows, columns) {
  return [columns.join(','), ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','))].join('\n');
}

export function entriesToCsv(mediaType = null) {
  const entries = getAllEntries(mediaType);
  const rows = [COLUMNS.join(',')];
  entries.forEach((entry) => {
    rows.push(COLUMNS.map((col) => csvEscape(entry[col])).join(','));
  });
  // Deleted entries, so the other side deletes them too.
  if (mediaType) {
    getEntryTombstones(mediaType).forEach((t) => {
      rows.push(COLUMNS.map((col) => csvEscape(t[col])).join(','));
    });
  }
  return rows.join('\n');
}

// Character-by-character CSV parser (handles quoted fields containing
// commas, quotes, and embedded newlines) — a simple split('\n') isn't
// safe here since a title or URL could itself contain a comma inside
// quotes, which is exactly what csvEscape() above produces.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // skip — handled by the following \n
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Parses backup CSV text into an array of plain objects keyed by the
// header row's column names.
function parseCsvToObjects(text) {
  const rows = parseCsvRows(text.trim());
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx] : '';
    });
    return obj;
  });
}

// Two-way sync of favourite artists with Drive's favorite-artists.csv.
// Every artist ever favourited is listed with favorite 1 or 0 and when
// that last changed; for each artist, whichever side changed it more
// recently wins (so un-favouriting on one phone isn't undone by an
// older "favourite" in Drive). Drive then gets the merged list.
export function mergeArtistFavorites(localRows, remoteCsvText) {
  const keyOf = (row) => `${row.media_type}\u0000${row.name}`;
  const merged = new Map(localRows.map((row) => [keyOf(row), { ...row }]));
  const newerFromDrive = [];
  if (remoteCsvText) {
    parseCsvToObjects(remoteCsvText).forEach((row) => {
      if (!row.media_type || !row.name) return;
      const remote = {
        media_type: row.media_type,
        name: row.name,
        favorite: row.favorite === '1' ? 1 : 0,
        updated_at: Number(row.updated_at) || 0,
      };
      const local = merged.get(keyOf(remote));
      if (!local || remote.updated_at > local.updated_at) {
        merged.set(keyOf(remote), remote);
        newerFromDrive.push(remote);
      }
    });
  }
  return { rows: Array.from(merged.values()), newerFromDrive };
}

// ---------- Two-way sync of entries ----------

// What a type's file in Drive changes here, by updated_at / deleted_at
// (ISO times, so they compare as text; a missing one counts as oldest):
// - a deletion newer than the entry's last change deletes it;
// - an entry not here is added, unless it was deleted here after its
//   last change;
// - an entry changed in Drive more recently than here takes Drive's
//   details.
// local: this type's entries; tombstones: its deletions; remoteRows:
// the parsed file. Returns { add, update, remove, forget }: rows to add,
// rows to take, { source_id, deleted_at } to delete, and deletions to
// remember for entries that aren't here anyway.
export function planEntryMerge(local, tombstones, remoteRows) {
  const byId = new Map(local.map((e) => [e.source_id, e]));
  const deletedAt = new Map(tombstones.map((t) => [t.source_id, t.deleted_at]));
  const plan = { add: [], update: [], remove: [], forget: [] };
  remoteRows.forEach((row) => {
    const id = row.source_id;
    if (!id) return;
    const here = byId.get(id);
    if (row.deleted_at) {
      if (here && (here.updated_at || '') < row.deleted_at) {
        plan.remove.push({ source_id: id, deleted_at: row.deleted_at });
      } else if (!here && (deletedAt.get(id) || '') < row.deleted_at) {
        plan.forget.push({ source_id: id, deleted_at: row.deleted_at });
      }
      return;
    }
    if (!here) {
      if (deletedAt.has(id) && deletedAt.get(id) >= (row.updated_at || '')) return;
      plan.add.push(row);
    } else if ((row.updated_at || '') > (here.updated_at || '')) {
      plan.update.push(row);
    }
  });
  return plan;
}

// A CSV row's values as entry columns ('' becomes null, numbers become
// numbers).
function rowColumns(row) {
  const columns = {};
  [...EDITABLE_COLUMNS, 'title', 'alt_title', 'author', 'source_url'].forEach((col) => {
    if (!(col in row)) return;
    const value = row[col];
    columns[col] = value === '' ? null : NUMBER_COLUMNS.includes(col) ? Number(value) : value;
  });
  return columns;
}

// Listeners told when entries changed because of Drive (App.js reloads
// the Library).
const driveChangeListeners = new Set();
export function onLibraryChangedFromDrive(listener) {
  driveChangeListeners.add(listener);
  return () => driveChangeListeners.delete(listener);
}

// Brings one type's file from Drive into the library (planEntryMerge).
// New entries get their cover from Drive when there is one. Returns how
// many entries changed.
async function mergeTypeFromDrive(mediaType, csvText) {
  const rows = parseCsvToObjects(csvText).filter((r) => !r.media_type || r.media_type === mediaType);
  const plan = planEntryMerge(getAllEntries(mediaType), getEntryTombstones(mediaType), rows);
  for (const t of plan.remove) {
    const entry = getEntry(t.source_id, mediaType);
    deleteEntry(t.source_id, mediaType);
    putEntryTombstone(t.source_id, mediaType, t.deleted_at, { exact: true });
    if (entry && entry.local_image_path) {
      FileSystem.deleteAsync(entry.local_image_path, { idempotent: true }).catch(() => {});
    }
  }
  plan.forget.forEach((t) => putEntryTombstone(t.source_id, mediaType, t.deleted_at));
  plan.update.forEach((row) => applySyncedFields(row.source_id, mediaType, rowColumns(row)));
  for (const row of plan.add) {
    let localImagePath = null;
    try {
      localImagePath = await downloadCoverForRestore(
        mediaType,
        row.source_id,
        `${FileSystem.documentDirectory}${mediaType}-covers/`
      );
    } catch (err) {
      // Added without a cover; a later restore can pick it up.
    }
    const { title, alt_title, author, source_url, mal_id, mal_data, ...columns } = rowColumns(row);
    restoreEntry({
      ...columns,
      sourceId: row.source_id,
      mediaType,
      title,
      altTitle: alt_title,
      author,
      sourceUrl: source_url,
      localImagePath,
      syncStatus: localImagePath ? 'synced' : 'pending',
      createdAt: row.created_at || null,
      malId: mal_id || null,
      malData: mal_data || null,
    });
  }
  return plan.add.length + plan.update.length + plan.remove.length;
}

async function syncArtistFavorites() {
  const remoteCsvText = await fetchBackupCsvContent(ARTIST_FAVORITES_FILE);
  const { rows, newerFromDrive } = mergeArtistFavorites(getArtistFavorites(), remoteCsvText);
  newerFromDrive.forEach((row) => setArtistFavorite(row.media_type, row.name, row.favorite, row.updated_at));
  if (rows.length > 0 || remoteCsvText) {
    await backupCsvToDrive(rowsToCsv(rows, ARTIST_FAVORITE_COLUMNS), ARTIST_FAVORITES_FILE);
  }
  return newerFromDrive.length;
}

// Call this after any change (new entry, rating, etc). Returns a result
// object rather than throwing/swallowing silently, so callers (e.g. the
// debug log in MediaWebView.js) can actually show what happened instead
// of this failing invisibly with no way to tell auto-backup apart from
// "nothing changed yet". Backs up each media type to its own file
// (e.g. "manga-backup.csv") rather than one combined file.
// force: true for the Backup Now / Connect buttons, which run even when
// Settings → Data saver holds automatic sync for Wi-Fi. It also shows the
// status pill; an automatic backup only shows it if it fails
// (syncStatus.js).
export async function maybeBackupLibraryToDrive({ force = false } = {}) {
  if (!isDriveConnected()) {
    return { attempted: false, success: false, error: null };
  }
  if (!force && !driveSyncAllowed()) {
    markDriveSyncDeferred();
    return { attempted: false, success: false, error: null, deferred: true };
  }
  const errors = [];
  let changedFromDrive = 0;
  const job = beginSync('backup', { show: force, total: MEDIA_TYPE_LIST.length });
  for (const mediaConfig of MEDIA_TYPE_LIST) {
    try {
      // Changes made elsewhere (the browser extension, another phone)
      // come in first, so writing the file doesn't undo them; the file is
      // only written when it would change.
      const fileName = backupFileNameFor(mediaConfig.key);
      const remote = await fetchBackupCsvContent(fileName);
      if (remote) changedFromDrive += await mergeTypeFromDrive(mediaConfig.key, remote);
      const csv = entriesToCsv(mediaConfig.key);
      if (csv !== (remote || '').trim()) await backupCsvToDrive(csv, fileName);
    } catch (err) {
      console.warn(`Drive backup failed for ${mediaConfig.key}:`, err.message);
      errors.push(`${mediaConfig.label}: ${err.message}`);
    }
    job.step();
  }
  try {
    await syncArtistFavorites();
  } catch (err) {
    console.warn('Drive backup failed for favourite artists:', err.message);
    errors.push(`Favourite artists: ${err.message}`);
  }
  job.end({ ok: errors.length === 0, error: errors.join('\n') });
  if (changedFromDrive > 0) driveChangeListeners.forEach((listener) => listener(changedFromDrive));
  return {
    attempted: true,
    changedFromDrive,
    success: errors.length === 0,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

// How many covers uploadPendingImages has to upload.
export function countPendingImages() {
  return getPendingSyncEntries().filter((e) => e.local_image_path).length;
}

// Uploads cover images for any entry that was recorded before Drive got
// connected (or whose last upload attempt failed). The CSV backup
// covers every entry retroactively on its own, but per-entry image
// uploads only ever ran at the moment that specific entry was first
// saved — this is what catches the rest up. Returns how many it
// actually uploaded, so callers can show a useful count.
// job: a status-pill job (syncStatus.js) to report to, one step per
// cover, instead of its own — Backup Now counts the covers in its total
// up front so the bar never goes back.
export async function uploadPendingImages({ force = false, job: outerJob = null } = {}) {
  if (!isDriveConnected()) return 0;
  if (!force && !driveSyncAllowed()) {
    markDriveSyncDeferred();
    return 0;
  }

  const pending = getPendingSyncEntries().filter((e) => e.local_image_path);
  let uploaded = 0;
  let failed = 0;
  if (!pending.length) return 0;
  // Uploading covers is the slow part of a backup, so it shows the pill.
  const job = outerJob || beginSync('backup', { show: true, total: pending.length });

  for (const entry of pending) {
    try {
      const driveFileId = await uploadImageToDrive(
        entry.media_type,
        buildDriveDisplayName(entry.source_id, entry.title),
        entry.local_image_path
      );
      markSynced(entry.source_id, entry.media_type, driveFileId);
      uploaded++;
    } catch (err) {
      markSyncFailed(entry.source_id, entry.media_type);
      console.warn(`Pending image upload failed for ${entry.source_id}:`, err.message);
      failed++;
    }
    job.step();
  }

  const error = `${failed} of ${pending.length} cover${pending.length === 1 ? '' : 's'} didn't upload. They're tried again at the next backup.`;
  if (outerJob) {
    if (failed) outerJob.fail(error);
  } else {
    job.end({ ok: failed === 0, error });
  }
  return uploaded;
}

// Downloads each media type's own Drive CSV backup and restores any
// entries not already present locally — used to rebuild a library on a
// fresh install, a reset phone, or after a "Clear All". Existing local
// entries are never touched or overwritten (restoreEntry uses INSERT OR
// IGNORE). Attempts to also re-download each restored entry's cover
// image from Drive; when no matching cover is found, the entry still
// gets restored, just without a thumbnail until you revisit that page
// in-app.
//
// onProgress, if given, is called as (processed, total) after each row,
// counted cumulatively across all media types' files.
export async function restoreFromDriveBackup(onProgress) {
  if (!isDriveConnected()) {
    throw new Error('Connect Google Drive first.');
  }
  const job = beginSync('restore', { show: true });
  try {
    const result = await runRestore(onProgress, job);
    job.end({ summary: result.restored ? `Restored ${result.restored}` : 'Nothing new to restore' });
    return result;
  } catch (err) {
    job.end({ ok: false, error: `Restore failed: ${err.message}` });
    throw err;
  }
}

async function runRestore(onProgress, job) {
  let restored = 0;
  let skipped = 0;
  let imagesRestored = 0;
  let processed = 0;

  // Every type's file first, so the status pill knows how many rows there
  // are in all (one step each).
  const files = [];
  for (const mediaConfig of MEDIA_TYPE_LIST) {
    const csvText = await fetchBackupCsvContent(backupFileNameFor(mediaConfig.key));
    if (!csvText) continue; // nothing backed up yet for this type
    files.push({ mediaConfig, rows: parseCsvToObjects(csvText) });
  }
  job.addTotal(files.reduce((n, f) => n + f.rows.length, 0));

  for (const { mediaConfig, rows } of files) {
    // Backups made before the MyAnimeList fields (no start_date column)
    // hold scores on the old 1-5 scale.
    const oldScoreScale = rows.length > 0 && !('start_date' in rows[0]);

    for (const row of rows) {
      const sourceId = row.source_id;
      const mediaType = row.media_type || mediaConfig.key;
      processed++;
      job.step();

      // Deletion rows (deleted_at), and entries deleted here since their
      // last change.
      const tombstone = sourceId ? getEntryTombstone(sourceId, mediaType) : null;
      if (
        !sourceId ||
        row.deleted_at ||
        entryExists(sourceId, mediaType) ||
        (tombstone && tombstone.deleted_at >= (row.updated_at || ''))
      ) {
        skipped++;
        if (onProgress) onProgress(processed, processed);
        continue;
      }

      let localImagePath = null;
      try {
        const dir = `${FileSystem.documentDirectory}${mediaType}-covers/`;
        localImagePath = await downloadCoverForRestore(mediaType, sourceId, dir);
        if (localImagePath) imagesRestored++;
      } catch (err) {
        // No matching cover found, or download failed — restore the
        // entry's data anyway rather than losing it over a missing image.
        console.warn(`Cover restore failed for ${sourceId}:`, err.message);
      }

      const columns = {};
      EDITABLE_COLUMNS.forEach((col) => {
        if (row[col] === undefined || row[col] === '') return;
        columns[col] = NUMBER_COLUMNS.includes(col) ? Number(row[col]) : row[col];
      });
      if (oldScoreScale && columns.score) columns.score *= 2;

      restoreEntry({
        ...columns,
        sourceId,
        mediaType,
        title: row.title,
        altTitle: row.alt_title,
        author: row.author,
        sourceUrl: row.source_url,
        localImagePath,
        syncStatus: localImagePath ? 'synced' : 'pending',
        createdAt: row.created_at,
        malId: columns.mal_id || null,
        malData: columns.mal_data || null,
      });
      restored++;
      if (onProgress) onProgress(processed, processed);
    }
  }

  // Favourite artists too (newest change wins, see mergeArtistFavorites).
  // A failure here doesn't undo the entries restored above.
  try {
    await syncArtistFavorites();
  } catch (err) {
    console.warn('Restoring favourite artists failed:', err.message);
  }

  return { restored, skipped, imagesRestored };
}
