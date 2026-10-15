import { getAllEntries, getPendingSyncEntries, markSynced, markSyncFailed, entryExists, restoreEntry } from './db';
import * as FileSystem from 'expo-file-system/legacy';
import { MEDIA_TYPE_LIST } from './mediaTypes';
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
];

// Each media type gets its own backup file (e.g. "manga-backup.csv",
// "anime-backup.csv") rather than one combined "library-backup.csv" —
// keeps them separate and easy to browse/open individually in Drive.
function backupFileNameFor(mediaType) {
  return `${mediaType}-backup.csv`;
}

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

export function entriesToCsv(mediaType = null) {
  const entries = getAllEntries(mediaType);
  const rows = [COLUMNS.join(',')];
  entries.forEach((entry) => {
    rows.push(COLUMNS.map((col) => csvEscape(entry[col])).join(','));
  });
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

// Call this after any change (new entry, rating, etc). Returns a result
// object rather than throwing/swallowing silently, so callers (e.g. the
// debug log in MediaWebView.js) can actually show what happened instead
// of this failing invisibly with no way to tell auto-backup apart from
// "nothing changed yet". Backs up each media type to its own file
// (e.g. "manga-backup.csv") rather than one combined file.
export async function maybeBackupLibraryToDrive() {
  if (!isDriveConnected()) {
    return { attempted: false, success: false, error: null };
  }
  const errors = [];
  for (const mediaConfig of MEDIA_TYPE_LIST) {
    try {
      await backupCsvToDrive(entriesToCsv(mediaConfig.key), backupFileNameFor(mediaConfig.key));
    } catch (err) {
      console.warn(`Drive backup failed for ${mediaConfig.key}:`, err.message);
      errors.push(`${mediaConfig.label}: ${err.message}`);
    }
  }
  return {
    attempted: true,
    success: errors.length === 0,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
}

// Uploads cover images for any entry that was recorded before Drive got
// connected (or whose last upload attempt failed). The CSV backup
// covers every entry retroactively on its own, but per-entry image
// uploads only ever ran at the moment that specific entry was first
// saved — this is what catches the rest up. Returns how many it
// actually uploaded, so callers can show a useful count.
export async function uploadPendingImages() {
  if (!isDriveConnected()) return 0;

  const pending = getPendingSyncEntries().filter((e) => e.local_image_path);
  let uploaded = 0;

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
    }
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

  let restored = 0;
  let skipped = 0;
  let imagesRestored = 0;
  let processed = 0;

  for (const mediaConfig of MEDIA_TYPE_LIST) {
    const csvText = await fetchBackupCsvContent(backupFileNameFor(mediaConfig.key));
    if (!csvText) continue; // nothing backed up yet for this type

    const rows = parseCsvToObjects(csvText);

    for (const row of rows) {
      const sourceId = row.source_id;
      const mediaType = row.media_type || mediaConfig.key;
      processed++;

      if (!sourceId || entryExists(sourceId, mediaType)) {
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

      restoreEntry({
        sourceId,
        mediaType,
        title: row.title,
        altTitle: row.alt_title,
        author: row.author,
        score: row.score ? Number(row.score) : null,
        tags: row.tags,
        readStatus: row.read_status,
        sourceUrl: row.source_url,
        localImagePath,
        syncStatus: localImagePath ? 'synced' : 'pending',
        createdAt: row.created_at,
      });
      restored++;
      if (onProgress) onProgress(processed, processed);
    }
  }

  return { restored, skipped, imagesRestored };
}
