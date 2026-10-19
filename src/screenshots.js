import * as FileSystem from 'expo-file-system/legacy';
import { Query, AssetField, MediaType, getPermissionsAsync } from 'expo-media-library';
import { safeFileName, saveFileToGallery } from './gallery';
import { suppressNextRelock } from './relockGuard';

// Files phone screenshots taken in the app into the gallery:
//   a browsing tab (Manga, Anime, ...) -> Pictures/AniManga Tracker/<tab>/
//   Library tab (incl. Notepad)        -> Pictures/AniManga Tracker/
// An app can't change where Android saves a screenshot, so this reacts
// after the fact (App.js listens for the screenshot): it finds the image
// Android just saved in its Screenshots folder, copies it into the
// folder above under a descriptive name, then deletes the original —
// Android asks "Allow AniManga Tracker to delete…?" each time, since the
// app didn't create that file, unless "Media management" access is on
// (Settings → Delete screenshots without asking). Declining just leaves
// both copies.

// "1h02m03s" / "12m34s" — no ':' since file names can't contain it.
export function formatVideoTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h${pad(m)}m${pad(s)}s` : `${pad(m)}m${pad(s)}s`;
}

// Spaces become underscores, so saved names have no spaces.
function noSpaces(text) {
  return text.replace(/ /g, '_');
}

// File name (no extension) for a screenshot of a tab's page, or null to
// keep Android's own name (e.g. on a page that isn't a specific title,
// like the site's home page). No spaces:
//   reading:  "12345--3_Some_Title"        (code--page, then title)
//   watching: "12m34s_12345_Some_Title"    (video position, code, title)
// Parts that aren't known are left out, e.g. "12345_Some_Title".
export function buildGalleryFileName(info) {
  if (!info || !info.code) return null;
  const parts = [];
  if (typeof info.currentTime === 'number') parts.push(formatVideoTime(info.currentTime));
  parts.push(info.pageNumber ? `${info.code}--${info.pageNumber}` : info.code);
  if (info.title) parts.push(info.title);
  return noSpaces(safeFileName(parts.join(' ')));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The number at the end of an asset's content:// id (e.g. …/media/1234),
// which Android assigns in increasing order as media is added.
function mediaStoreNumber(id) {
  const m = /(\d+)\D*$/.exec(id || '');
  return m ? Number(m[1]) : 0;
}

// A screenshot: in a "Screenshots" folder (DCIM/Screenshots on Samsung,
// Pictures/Screenshots on most others) or named "Screenshot_…" — and
// never one of this app's own filed copies (in AniManga Tracker/, or
// Manga Tracker/ from before the rename).
function isScreenshot(uri, filename) {
  if (/\/(Ani)?Manga Tracker\//i.test(uri || '')) return false;
  return /\/screenshots\//i.test(uri || '') || /^screenshot/i.test(filename || '');
}

// The screenshot callback can fire before Android has finished saving
// the file, so this polls for up to ~10s for a not-yet-handled
// screenshot written around the time it was taken. Of those, it takes
// the OLDEST: with two quick screenshots, the first event gets the first
// file, so each keeps the name (video time) of its own moment.
//
// Sorted and dated by MODIFICATION time (when the file was written), not
// creation time: creation time is Android's "date taken" field, which
// screenshots often leave empty — sorting by it put a brand-new
// screenshot at the very bottom, so it was never found.
// Returns { asset, seen }: asset is null if nothing was found; seen
// describes the newest images on the last look, for the debug log.
async function findNewScreenshot(takenAt, handledIds) {
  const deadline = Date.now() + 10000;
  let seen = [];
  while (Date.now() < deadline) {
    const newest = await new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .orderBy({ key: AssetField.MODIFICATION_TIME, ascending: false })
      .limit(10)
      .exe();
    let oldest = null;
    let oldestKey = null;
    seen = [];
    for (const asset of newest) {
      if (handledIds.has(asset.id)) continue;
      const written = (await asset.getModificationTime()) ?? (await asset.getCreationTime());
      // Newest first, so once one is too old, the rest are too.
      const uri = await asset.getUri();
      const filename = await asset.getFilename();
      if (seen.length < 5) {
        const age = written != null ? `${Math.round((takenAt - written) / 1000)}s before` : 'no time';
        seen.push(`${filename} (${age}, in ${(uri || '').replace(/^file:\/\/\/storage\/emulated\/0\//, '').replace(/[^/]*$/, '') || '?'})`);
      }
      if (written != null && written < takenAt - 15000) break;
      if (!isScreenshot(uri, filename)) continue;
      // Modification time is only whole seconds, so two screenshots in the
      // same second tie; Android numbers media in the order it's added
      // (the number at the end of the asset's content:// id), which
      // breaks the tie.
      const key = [written ?? 0, mediaStoreNumber(asset.id)];
      if (!oldestKey || key[0] < oldestKey[0] || (key[0] === oldestKey[0] && key[1] < oldestKey[1])) {
        oldest = asset;
        oldestKey = key;
      }
    }
    if (oldest) return { asset: oldest, seen };
    await sleep(500);
  }
  return { asset: null, seen };
}

const handledIds = new Set();
let chain = Promise.resolve();

// folder: gallery folder from galleryFolderFor().
// getName: optional () => Promise<string|null> — called immediately (so
// a video's position is read as close to the screenshot as possible);
// null keeps Android's own file name.
// onLog: optional (message) => void, called with step-by-step details for
// the debug log (Settings → Show debug tools).
// Resolves to { ok, folder, name, movedOriginal } or { ok: false, reason }.
export function fileScreenshot({ folder, getName, onLog }) {
  const takenAt = Date.now();
  const log = (message) => {
    try {
      if (onLog) onLog(`Screenshot: ${message}`);
    } catch (e) {
      // logging must never break filing
    }
  };
  log(`detected, filing to ${folder}`);
  const namePromise = getName ? getName().catch(() => null) : Promise.resolve(null);

  const run = async () => {
    // Which step was running, so a failure can say what went wrong.
    let step = 'checking photo access';
    try {
      const permission = await getPermissionsAsync();
      if (permission.status !== 'granted' || permission.accessPrivileges === 'limited') {
        log(`no full photo access (status: ${permission.status}, access: ${permission.accessPrivileges || 'unknown'}) — left in Screenshots`);
        return { ok: false, reason: 'permission' };
      }
      step = 'finding the screenshot';
      const { asset: original, seen } = await findNewScreenshot(takenAt, handledIds);
      if (!original) {
        log(`couldn't find it within 10s. Newest images seen: ${seen.length ? seen.join('; ') : 'none'}`);
        return { ok: false, reason: 'not-found' };
      }
      handledIds.add(original.id);

      const originalName = await original.getFilename();
      const ext = (originalName.match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0];
      const base = (await namePromise) || noSpaces(safeFileName(originalName.replace(/\.[^.]+$/, '')));
      log(`found ${originalName} (${await original.getUri()}), naming it "${base}${ext}"`);

      // Copy under the new name (the gallery item takes the file's name),
      // then add that copy to the folder.
      step = 'copying it';
      const tempDir = `${FileSystem.cacheDirectory}screenshots/`;
      await FileSystem.makeDirectoryAsync(tempDir, { intermediates: true }).catch(() => {});
      const tempPath = `${tempDir}${base}${ext}`;
      await FileSystem.deleteAsync(tempPath, { idempotent: true });
      await FileSystem.copyAsync({ from: original.id, to: tempPath });
      step = `saving to ${folder}`;
      try {
        await saveFileToGallery(tempPath, folder);
      } finally {
        FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
      }

      // Remove the original from Screenshots. Android shows a system
      // "allow delete?" dialog, which briefly takes the app out of the
      // foreground — without suppressing, AppLock would re-lock on return.
      suppressNextRelock(30000);
      log(`saved to ${folder}; asking to remove the original`);
      let movedOriginal = true;
      try {
        await original.delete();
        log('original removed from Screenshots');
      } catch (err) {
        movedOriginal = false; // declined (or failed): both copies stay
        log(`original kept in Screenshots (${err.message})`);
      }
      return { ok: true, folder, name: base, movedOriginal };
    } catch (err) {
      console.warn(`Screenshot filing failed while ${step}:`, err.message);
      log(`FAILED while ${step}: ${err.message}`);
      return { ok: false, reason: 'error', step, error: err.message };
    }
  };

  chain = chain.then(run, run);
  return chain;
}
