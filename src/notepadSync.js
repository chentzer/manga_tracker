import * as Crypto from 'expo-crypto';
import Constants from 'expo-constants';
import {
  INBOX_TITLE,
  getNotes,
  getNotebooks,
  getSetting,
  setSetting,
  createNotebook,
  deleteNotebook,
  getNotebookTombstones,
  clearNotebookTombstones,
  getNoteItemTombstones,
  clearNoteItemTombstones,
} from './db';
import { uploadTextFileToDrive, fetchBackupCsvContent, isDriveConnected } from './GoogleDriveService';
import { driveSyncAllowed, markDriveSyncDeferred } from './dataSaver';

// Drive layout (both files live in the MangaTracker folder, next to the
// library CSVs):
//   notepad.json — the source of truth:
//     {
//       version: 2,
//       notebooks: { <lowercase title>: { title, deleted, updated_at } },
//       devices: { <deviceId>: { label, updated_at,
//         notebooks: [{ title, items: [{ id, content, created_at }] }] } }
//     }
//   Notepad.txt  — plain-text rendering of everything, regenerated on
//     every sync. The one to open in Drive; nothing reads it back.
//
// Two different sharing rules:
//
// 1. Note NAMES are shared by every device. `notebooks` is one list for
//    all devices: creating "Grocery list" on device A makes an empty
//    "Grocery list" appear on B at its next sync, and deleting it on one
//    device deletes it on the others (their items in it move to their
//    Inbox — nothing is deleted on a device that didn't ask). Each name
//    keeps whichever create/delete happened last, by timestamp.
//
// 2. Note CONTENTS are never shared. Each device writes only its own
//    `devices` section and never reads anyone else's, so A only sees what
//    A added. Deleting a single item here removes it from Drive too;
//    deleting a whole note keeps that note and all its items in Drive
//    (marked "(deleted)" in Notepad.txt). Items carry a stable id, so
//    moving one to another note updates it in place in Drive rather
//    than leaving a duplicate behind.
//
// Known limitations: this is a read-modify-write of one shared file, so
// two devices syncing at the exact same moment can drop the other's
// latest change from Drive until that device next syncs. "Which happened
// last" uses each phone's clock, so a phone with a badly wrong clock can
// win or lose a create/delete it shouldn't. Fine for personal use.
const NOTEPAD_JSON = 'notepad.json';
const NOTEPAD_TXT = 'Notepad.txt';
const INBOX_KEY = INBOX_TITLE.toLowerCase();

// Generated once per install and kept in the settings table. A reinstall
// gets a new id; the old install's section just stays in Drive as-is.
export function getOrCreateDeviceId() {
  let id = getSetting('deviceId');
  if (!id) {
    id = Crypto.randomUUID();
    setSetting('deviceId', id);
  }
  return id;
}

function getDeviceLabel(deviceId) {
  const name = Constants.deviceName || 'Unknown device';
  return `${name} (${deviceId.slice(0, 8)})`;
}

// ---- Pure helpers (no DB/Drive access), kept separate so they can be
// tested on their own. ----

// SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
export function sqliteToIso(value) {
  if (!value) return new Date(0).toISOString();
  if (value.includes('T')) return value;
  const t = Date.parse(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

function toMs(value) {
  const t = Date.parse(sqliteToIso(value));
  return Number.isNaN(t) ? 0 : t;
}

// Throws on a file that isn't notepad JSON rather than letting the sync
// overwrite it — that would wipe every other device's notes.
export function parseDoc(remoteText) {
  if (!remoteText || !remoteText.trim()) return { version: 2, notebooks: {}, devices: {} };
  const parsed = JSON.parse(remoteText);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.devices !== 'object' || parsed.devices === null) {
    throw new Error('notepad.json in Drive is not in the expected format — not overwriting it.');
  }
  return {
    ...parsed,
    // Files from the first notepad version have no shared name list.
    notebooks: parsed.notebooks && typeof parsed.notebooks === 'object' ? parsed.notebooks : {},
  };
}

// localFacts: [{ key, title, deleted, updated_at }] — this device's
// current notes plus pending deletes. For each name, the newer of Drive's
// entry and this device's fact wins (this device on a tie).
export function mergeRegistry(remoteRegistry, localFacts) {
  const result = { ...remoteRegistry };
  for (const f of localFacts) {
    const r = result[f.key];
    if (!r || toMs(f.updated_at) >= toMs(r.updated_at)) {
      result[f.key] = { title: f.title, deleted: f.deleted, updated_at: f.updated_at };
    }
  }
  return result;
}

// What this device must change to match the shared name list.
export function planLocalChanges(registry, localNotebooks) {
  const local = new Map(localNotebooks.map((b) => [b.title.toLowerCase(), b]));
  const toCreate = [];
  const toDelete = [];
  for (const [key, entry] of Object.entries(registry)) {
    if (key === INBOX_KEY) continue;
    if (!entry.deleted && !local.has(key)) toCreate.push({ title: entry.title, updated_at: entry.updated_at });
    if (entry.deleted && local.has(key)) toDelete.push(local.get(key).id);
  }
  return { toCreate, toDelete };
}

// A device section's notebooks. Sections written by the first notepad
// version had a flat `notes` list and no named notes — read as Inbox.
function sectionNotebooks(section) {
  if (!section) return [];
  if (Array.isArray(section.notebooks)) return section.notebooks;
  return [{ title: INBOX_TITLE, items: Array.isArray(section.notes) ? section.notes : [] }];
}

// This device's Drive section after a sync: everything it has now, plus
// every item from its previous Drive copy that no longer exists here,
// left where it last was — EXCEPT items deleted one by one on this
// device (deletedItemIds), which are dropped. What's left over is items
// that went away with a whole deleted note, which Drive keeps. Items
// match by id; older items without one match by content + creation time.
export function mergeSection(remoteSection, localSection, deletedItemIds = []) {
  const deleted = new Set(deletedItemIds);
  const books = new Map(); // lowercase title -> { title, items }
  const bookFor = (title) => {
    const key = title.toLowerCase();
    if (!books.has(key)) books.set(key, { title, items: [] });
    return books.get(key);
  };
  const localIds = new Set();
  const localSigs = new Set();
  for (const nb of localSection.notebooks) {
    const book = bookFor(nb.title);
    for (const item of nb.items) {
      book.items.push(item);
      localIds.add(item.id);
      localSigs.add(`${item.created_at}\u0000${item.content}`);
    }
  }
  for (const nb of sectionNotebooks(remoteSection)) {
    for (const item of nb.items || []) {
      if (item.id && deleted.has(item.id)) continue;
      if (item.id ? localIds.has(item.id) : localSigs.has(`${item.created_at}\u0000${item.content}`)) continue;
      bookFor(nb.title).items.push(item);
    }
  }
  for (const book of books.values()) {
    book.items.sort((a, b) => toMs(b.created_at) - toMs(a.created_at));
  }
  return { ...localSection, notebooks: [...books.values()] };
}

export function renderNotepadText(doc) {
  const registry = doc.notebooks || {};
  const blocks = Object.values(doc.devices).map((device) => {
    const notes = sectionNotebooks(device).map((nb) => {
      const deleted = registry[nb.title.toLowerCase()]?.deleted ? ' (deleted)' : '';
      // Stored newest first; reversed so each note reads top-to-bottom.
      const lines = [...(nb.items || [])].reverse().map((n) => `- ${n.content}  [${n.created_at}]`);
      return `--- ${nb.title}${deleted} ---\n${lines.join('\n') || '(empty)'}`;
    });
    return `===== ${device.label} =====\n\n${notes.join('\n\n')}`;
  });
  return blocks.join('\n\n\n');
}

// ---- DB/Drive side ----

function buildLocalSection(deviceId) {
  const toItems = (rows) => rows.map((n) => ({ id: n.uid, content: n.content, created_at: n.created_at }));
  return {
    label: getDeviceLabel(deviceId),
    updated_at: new Date().toISOString(),
    notebooks: [{ title: INBOX_TITLE, items: toItems(getNotes(null)) }].concat(
      getNotebooks().map((b) => ({ title: b.title, items: toItems(getNotes(b.id)) }))
    ),
  };
}

// Lets an open Notepad reload when a sync added/removed notes locally.
const listeners = new Set();
export function onNotepadSynced(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Serializes syncs so rapid taps never interleave two read-modify-write
// cycles from this same device.
let syncChain = Promise.resolve();

// force: true for the Backup Now / Connect buttons, which run even when
// Settings → Data saver holds automatic sync for Wi-Fi.
export function syncNotepadToDrive({ force = false } = {}) {
  const run = async () => {
    if (!isDriveConnected()) return { attempted: false, success: false, error: null };
    if (!force && !driveSyncAllowed()) {
      markDriveSyncDeferred();
      return { attempted: false, success: false, error: null, deferred: true };
    }
    try {
      const deviceId = getOrCreateDeviceId();
      const remote = parseDoc(await fetchBackupCsvContent(NOTEPAD_JSON));

      // 1. Agree on note names with the other devices.
      const tombstones = getNotebookTombstones();
      const localFacts = getNotebooks()
        .map((b) => ({
          key: b.title.toLowerCase(),
          title: b.title,
          deleted: false,
          updated_at: b.updated_at || sqliteToIso(b.created_at),
        }))
        .concat(tombstones.map((t) => ({ key: t.title_key, title: t.title, deleted: true, updated_at: t.deleted_at })));
      const registry = mergeRegistry(remote.notebooks, localFacts);
      const plan = planLocalChanges(registry, getNotebooks());
      for (const c of plan.toCreate) {
        try {
          createNotebook(c.title, c.updated_at); // empty — contents never come from Drive
        } catch (err) {
          console.warn(`Couldn't add note "${c.title}" from Drive:`, err.message);
        }
      }
      for (const id of plan.toDelete) {
        deleteNotebook(id, true, true); // keep this device's items, in its Inbox
      }

      // 2. Write this device's contents (after step 1, so items moved to
      // the Inbox by a delete are recorded there).
      const deletedItemIds = getNoteItemTombstones();
      const section = mergeSection(remote.devices[deviceId], buildLocalSection(deviceId), deletedItemIds);
      const doc = { ...remote, version: 2, notebooks: registry, devices: { ...remote.devices, [deviceId]: section } };
      await uploadTextFileToDrive(JSON.stringify(doc, null, 2), NOTEPAD_JSON, 'application/json');
      await uploadTextFileToDrive(renderNotepadText(doc), NOTEPAD_TXT, 'text/plain');
      clearNotebookTombstones(tombstones);
      clearNoteItemTombstones(deletedItemIds);

      const localChanged = plan.toCreate.length + plan.toDelete.length > 0;
      if (localChanged) listeners.forEach((l) => l());
      return { attempted: true, success: true, error: null, localChanged };
    } catch (err) {
      console.warn('Notepad Drive sync failed:', err.message);
      return { attempted: true, success: false, error: err.message };
    }
  };
  syncChain = syncChain.then(run, run);
  return syncChain;
}
