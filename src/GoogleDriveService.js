import * as FileSystem from 'expo-file-system/legacy';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import Constants from 'expo-constants';

// drive.file scope only: the app can only see/manage files IT creates,
// not the user's whole Drive. Safer default, and Google's verification
// process for this scope is much lighter than full drive access.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// Every Drive request gives up after a while instead of waiting forever: on a
// weak connection one stuck request held a whole sync or restore. Uploads get
// longer.
const REQUEST_TIMEOUT_MS = 45 * 1000;
const UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;
function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const limit = String(url).includes('/upload/') ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), limit);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((err) => {
      throw controller.signal.aborted ? new Error('Google Drive took too long to answer') : err;
    })
    .finally(() => clearTimeout(timer));
}

let signedIn = false;
let cachedRootFolderId = null;
const cachedTypeFolderIds = {}; // e.g. { manga: 'abc123', anime: 'def456' }
let configured = false;

// expo-auth-session's generic browser-redirect flow is no longer a
// reliable way to do Google sign-in — Expo itself stopped maintaining
// Google OAuth support in that library, and Google's policies for what
// counts as a valid mobile redirect kept tightening (see the various
// "doesn't comply with Google's OAuth 2.0 policy" errors that flow used
// to produce). This uses Google's own native Sign-In SDK instead: no
// browser, no redirect URI to register, just the platform's native
// account picker. The webClientId (not the Android one) is required
// here even on Android — the SDK uses it to obtain a token that Google
// APIs will actually accept.
function ensureConfigured() {
  if (configured) return;
  const extra = Constants.expoConfig.extra;
  GoogleSignin.configure({
    webClientId: extra.googleClientIdWeb,
    scopes: SCOPES,
  });
  configured = true;
}

export async function signInToGoogle() {
  ensureConfigured();
  await GoogleSignin.hasPlayServices();
  await GoogleSignin.signIn();
  signedIn = true;
  return getToken();
}

// Attempts to restore the last signed-in session without showing any UI
// — call this once on app startup. Returns true if it worked (so the
// caller can update isSignedInToGoogle), false if there's no previous
// session or it couldn't be silently restored (e.g. the user revoked
// access), in which case they'll need to tap Connect Drive normally.
export async function restoreGoogleSession() {
  ensureConfigured();
  try {
    const hasPrevious = await GoogleSignin.hasPreviousSignIn();
    if (!hasPrevious) return false;

    await GoogleSignin.signInSilently();
    signedIn = true;
    return true;
  } catch (err) {
    console.warn('Silent Google sign-in restore failed:', err.message);
    return false;
  }
}

// Fetches a fresh access token on every call rather than reusing one
// cached at sign-in time. Google access tokens expire after about an
// hour — caching a single token for the whole app session meant a long
// session (browse for a while, then back up later) could silently fail
// with an expired token. GoogleSignin.getTokens() handles refreshing
// under the hood cheaply, so there's no real cost to just always asking.
let inFlightTokenPromise = null;
async function getToken() {
  if (!signedIn) {
    throw new Error('Not signed in to Google. Call signInToGoogle() first.');
  }
  // GoogleSignin.getTokens() can't handle overlapping calls — firing a
  // second one before the first resolves throws "previous promise did
  // not settle and was overwritten" from the native module itself. This
  // was the actual cause of auto-backup failing while manual Backup Now
  // worked fine: saving an entry fires the CSV backup and the per-image
  // Drive upload at nearly the same moment, and both independently need
  // a token. Sharing a single in-flight promise means a second caller
  // just waits for the first's result instead of racing it.
  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }
  inFlightTokenPromise = GoogleSignin.getTokens()
    .then((tokens) => tokens.accessToken)
    .finally(() => {
      inFlightTokenPromise = null;
    });
  return inFlightTokenPromise;
}

// Lets other modules check sign-in state without threading a prop through
// every component — used to make backups opportunistic/best-effort.
export function isDriveConnected() {
  return signedIn;
}

// Makes text safe inside a quoted Drive search value: ' ends a value and \
// escapes, so a name containing either could break the search.
function q(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Drive's reply as JSON. An error reply throws: read as "nothing there", one
// failed search would make a sync overwrite Drive without merging it first.
async function okJson(res, what) {
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return res.json();
}

// Finds (or creates) a folder by name under an optional parent. The oldest of
// any duplicates, so every device uses the same one.
async function findOrCreateFolder(name, parentId = null) {
  const token = await getToken();
  let query = `name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${q(parentId)}' in parents`;

  const searchRes = await timedFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await okJson(searchRes, 'Drive folder search');
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createRes = await timedFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  const created = await okJson(createRes, 'Drive folder create');
  return created.id;
}

// Root "MangaTracker" folder, with one subfolder per media type
// (e.g. MangaTracker/manga, MangaTracker/anime) so covers stay organized.
async function getOrCreateTypeFolder(mediaType) {
  if (cachedTypeFolderIds[mediaType]) return cachedTypeFolderIds[mediaType];

  if (!cachedRootFolderId) {
    cachedRootFolderId = await findOrCreateFolder('MangaTracker');
  }
  const typeFolderId = await findOrCreateFolder(mediaType, cachedRootFolderId);
  cachedTypeFolderIds[mediaType] = typeFolderId;
  return typeFolderId;
}

// Backup files read or written this session: name -> { id, modifiedTime, text }.
// A sync asks only whether a file changed, and downloads it only if it did.
const knownFiles = {};

// A file's { id, modifiedTime } by exact name under a parent, or null. The
// oldest of any duplicates, so every device uses the same one.
async function fileInfo(name, parentId) {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };
  const known = knownFiles[name];
  if (known) {
    const res = await timedFetch(
      `https://www.googleapis.com/drive/v3/files/${known.id}?fields=id,modifiedTime,trashed`,
      { headers }
    );
    if (res.ok) {
      const file = await res.json();
      if (!file.trashed) return file;
    } else if (res.status !== 404) {
      throw new Error(`Drive file check failed: ${res.status}`);
    }
    delete knownFiles[name];
  }
  const query = `name='${q(name)}' and '${q(parentId)}' in parents and trashed=false`;
  const res = await timedFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,modifiedTime)&orderBy=createdTime`,
    { headers }
  );
  const data = await okJson(res, 'Drive file search');
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function backupRootId() {
  if (!cachedRootFolderId) {
    cachedRootFolderId = await findOrCreateFolder('MangaTracker');
  }
  return cachedRootFolderId;
}

// Creates or overwrites a CSV file at the root of the MangaTracker Drive
// folder — one file per fileName, always up to date, rather than a
// growing pile of dated backups. Called once per media type (e.g.
// "manga-backup.csv", "anime-backup.csv") so each type's data lives in
// its own file rather than one combined one. Returns the file id.
export function backupCsvToDrive(csvContent, fileName) {
  return uploadTextFileToDrive(csvContent, fileName, 'text/csv');
}

// Creates or overwrites a text file (by name) at the root of the
// MangaTracker Drive folder. Returns the file id.
export async function uploadTextFileToDrive(content, fileName, mimeType) {
  const token = await getToken();
  const rootId = await backupRootId();
  const existing = await fileInfo(fileName, rootId);
  const written = (file) => {
    knownFiles[fileName] = { id: file.id, modifiedTime: file.modifiedTime, text: content };
    return file.id;
  };

  if (existing) {
    // Content-only update — no need to touch metadata, so a simple
    // media upload is enough (cheaper than the multipart create path).
    const res = await timedFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,modifiedTime`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
        body: content,
      }
    );
    return written(await okJson(res, `Drive update of ${fileName}`));
  }

  const boundary = 'manga_tracker_backup_' + Date.now();
  const metadata = { name: fileName, parents: [rootId] };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await timedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  return written(await okJson(res, `Drive upload of ${fileName}`));
}

// Builds the "code - title" filename format used for cover uploads,
// e.g. "12345 - Some Manga Title". Falls back to just the code when no
// title was extracted, avoiding an awkward "12345 - 12345".
export function buildDriveDisplayName(sourceId, title) {
  return title ? `${sourceId} - ${title}` : sourceId;
}

// A backup file's { text, modifiedTime }, or null if it doesn't exist yet
// (e.g. never backed up from this account before). Throws if Drive can't
// say, so nothing is written without knowing what's there.
export async function fetchBackupFile(fileName) {
  const token = await getToken();
  const info = await fileInfo(fileName, await backupRootId());
  if (!info) return null;
  const known = knownFiles[fileName];
  if (known && known.id === info.id && known.modifiedTime === info.modifiedTime) {
    return { text: known.text, modifiedTime: info.modifiedTime };
  }
  const res = await timedFetch(`https://www.googleapis.com/drive/v3/files/${info.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to download backup CSV: ${res.status}`);
  const text = await res.text();
  knownFiles[fileName] = { id: info.id, modifiedTime: info.modifiedTime, text };
  return { text, modifiedTime: info.modifiedTime };
}

// Its text alone, or null.
export async function fetchBackupCsvContent(fileName) {
  const file = await fetchBackupFile(fileName);
  return file ? file.text : null;
}

// Whether a file changed in Drive since fetchBackupFile saw this modifiedTime
// (null: it wasn't there), e.g. a save from the browser extension.
export async function backupFileChangedSince(fileName, modifiedTime) {
  const info = await fileInfo(fileName, await backupRootId());
  return (info ? info.modifiedTime : null) !== (modifiedTime || null);
}

// Finds a cover image in MangaTracker/<mediaType>/ whose filename starts
// with the given source id (filenames are "code - title.jpg" or just
// "code.jpg"), or null if none is found.
export async function findCoverFileId(mediaType, sourceId) {
  const token = await getToken();
  const folderId = await getOrCreateTypeFolder(mediaType);
  const query = `'${q(folderId)}' in parents and trashed=false and name contains '${q(sourceId)}'`;
  // Newest first: if an old cover is still there, the new one wins.
  const res = await timedFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await okJson(res, 'Cover lookup');
  // "contains" is a substring match, not "starts with" — Drive's query
  // language doesn't support anchoring, so double-check here to avoid
  // e.g. source id "123" matching a file actually named "9123 - X.jpg",
  // and that what follows the id isn't more of an id ("mal-12" must not
  // match "mal-123 - X.jpg").
  const match = (data.files || []).find((f) => {
    if (!f.name.startsWith(sourceId)) return false;
    const rest = f.name.slice(sourceId.length);
    return rest === '' || rest.startsWith(' ') || rest.startsWith('.');
  });
  return match ? match.id : null;
}

// Downloads a Drive cover image to local storage for a restored entry.
// Returns the local file path, or null if no matching cover was found
// in Drive (the entry still gets restored either way — just without a
// thumbnail until the page is browsed again). fileName: the local file's
// name, if not "<id>.jpg" (fetchMissingCovers uses a new one, so a
// broken picture isn't shown from cache).
export async function downloadCoverForRestore(mediaType, sourceId, localDir, fileName = null) {
  const fileId = await findCoverFileId(mediaType, sourceId);
  if (!fileId) return null;

  const token = await getToken();
  const dirInfo = await FileSystem.getInfoAsync(localDir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(localDir, { intermediates: true });
  }
  const localPath = `${localDir}${fileName || `${sourceId}.jpg`}`;
  // Stopped after a while, so one stuck cover doesn't hold the rest.
  const download = FileSystem.createDownloadResumable(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    localPath,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  let timer;
  const result = await Promise.race([
    download.downloadAsync(),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        download.pauseAsync().catch(() => {});
        reject(new Error('Cover download took too long'));
      }, REQUEST_TIMEOUT_MS);
    }),
  ])
    .catch(async (err) => {
      await FileSystem.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      throw err;
    })
    .finally(() => clearTimeout(timer));
  if (!result) throw new Error('Cover download stopped');
  // downloadAsync doesn't fail on an error reply: it saves the error
  // message as the file, which showed as a blank cover. Only a real
  // picture is kept.
  if (result.status !== 200 || !(await isImageFile(localPath))) {
    await FileSystem.deleteAsync(localPath, { idempotent: true }).catch(() => {});
    throw new Error(`Cover download failed: ${result.status}`);
  }
  return localPath;
}

// Whether a local file starts like a JPEG, PNG, GIF, WebP or AVIF picture.
export async function isImageFile(path) {
  try {
    const head = atob(
      await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 12 })
    );
    const bytes = Array.from(head, (c) => c.charCodeAt(0));
    const starts = (...b) => b.every((v, i) => bytes[i] === v);
    return (
      starts(0xff, 0xd8) || // JPEG
      starts(0x89, 0x50, 0x4e, 0x47) || // PNG
      starts(0x47, 0x49, 0x46) || // GIF
      (starts(0x52, 0x49, 0x46, 0x46) && head.slice(8, 12) === 'WEBP') ||
      head.slice(4, 8) === 'ftyp' // AVIF, HEIC
    );
  } catch (e) {
    return false;
  }
}

// Uploads a local image file to MangaTracker/<mediaType>/ in Drive.
// Returns the Drive file id.
export async function uploadImageToDrive(mediaType, displayName, localImagePath) {
  const token = await getToken();
  const folderId = await getOrCreateTypeFolder(mediaType);

  const base64Data = await FileSystem.readAsStringAsync(localImagePath, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Titles can contain characters that are awkward in filenames; strip
  // anything outside common safe characters and cap the length.
  const safeName = String(displayName).replace(/[\\/:*?"<>|]/g, '').slice(0, 100) || 'untitled';

  const boundary = 'manga_tracker_boundary_' + Date.now();
  const metadata = { name: `${safeName}.jpg`, parents: [folderId] };

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: image/jpeg\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${base64Data}\r\n` +
    `--${boundary}--`;

  const res = await timedFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive upload failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.id;
}
