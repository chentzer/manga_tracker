// The Browser tab's bookmarks in Drive: bookmarks.json in the app's Drive
// folder, next to the backups, holding every bookmark of every device:
//   { "version": 1, "bookmarks": [{ uid, title, url, created_at, updated_at, deleted_at }] }
// Each sync merges Drive's list with this phone's by uid — the newer
// updated_at wins, and a removal (deleted_at) is a change like any other,
// so a bookmark removed on one device goes on the others too — then
// writes the result to both. Removals older than 180 days are forgotten.
import {
  getAllBookmarkRows,
  putBookmarkRow,
  forgetOldRemovedBookmarks,
  addBookmark as addRow,
  renameBookmark as renameRow,
  setBookmarkRemoved,
} from './db';
import { uploadTextFileToDrive, fetchBackupCsvContent, isDriveConnected } from './GoogleDriveService';
import { driveSyncAllowed, markDriveSyncDeferred } from './dataSaver';

const BOOKMARKS_JSON = 'bookmarks.json';
const FORGET_MS = 180 * 24 * 60 * 60 * 1000;
const SYNC_DELAY_MS = 3000; // after a change, so a few in a row are one sync

// The merged list: for each uid, the newer of the two.
export function mergeBookmarks(remote, local) {
  const byUid = new Map();
  [...remote, ...local].forEach((b) => {
    if (!b || !b.uid || !b.url) return;
    const have = byUid.get(b.uid);
    if (!have || (b.updated_at || '') > (have.updated_at || '')) byUid.set(b.uid, b);
  });
  return [...byUid.values()];
}

function parse(text) {
  if (!text) return [];
  const doc = JSON.parse(text);
  if (!doc || !Array.isArray(doc.bookmarks)) {
    throw new Error('bookmarks.json in Drive is not in the expected format — not overwriting it.');
  }
  return doc.bookmarks;
}

const listeners = new Set();
// Told when a sync changed this phone's bookmarks (the Browser reloads them).
export function onBookmarksSynced(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let chain = Promise.resolve();
// force: Backup Now / Connect, which run even when Data saver holds
// automatic sync for Wi-Fi.
export function syncBookmarksToDrive({ force = false } = {}) {
  const run = async () => {
    if (!isDriveConnected()) return false;
    if (!force && !driveSyncAllowed()) {
      markDriveSyncDeferred();
      return false;
    }
    try {
      const local = getAllBookmarkRows();
      const remote = parse(await fetchBackupCsvContent(BOOKMARKS_JSON));
      const cutoff = new Date(Date.now() - FORGET_MS).toISOString();
      const merged = mergeBookmarks(remote, local).filter((b) => !b.deleted_at || b.deleted_at >= cutoff);

      const localByUid = new Map(local.map((b) => [b.uid, b]));
      let changedHere = false;
      merged.forEach((b) => {
        const mine = localByUid.get(b.uid);
        if (!mine || mine.updated_at !== b.updated_at) {
          putBookmarkRow(b);
          changedHere = true;
        }
      });
      forgetOldRemovedBookmarks(cutoff);

      const doc = { version: 1, bookmarks: merged };
      const text = JSON.stringify(doc, null, 2);
      if (text !== JSON.stringify({ version: 1, bookmarks: remote }, null, 2)) {
        await uploadTextFileToDrive(text, BOOKMARKS_JSON, 'application/json');
      }
      if (changedHere) listeners.forEach((l) => l());
      return true;
    } catch (err) {
      console.warn('Bookmarks Drive sync failed:', err.message);
      return false;
    }
  };
  chain = chain.then(run, run);
  return chain;
}

let timer = null;
function syncSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => syncBookmarksToDrive().catch(() => {}), SYNC_DELAY_MS);
}

// Changes from the Browser tab: saved here, then synced a moment later.
export function addBookmark(title, url) {
  const uid = addRow(title, url);
  syncSoon();
  return uid;
}

export function renameBookmark(uid, title) {
  renameRow(uid, title);
  syncSoon();
}

// removed false: Undo.
export function removeBookmark(uid, removed = true) {
  setBookmarkRemoved(uid, removed);
  syncSoon();
}
