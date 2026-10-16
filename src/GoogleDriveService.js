import * as FileSystem from 'expo-file-system/legacy';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import Constants from 'expo-constants';

// drive.file scope only: the app can only see/manage files IT creates,
// not the user's whole Drive. Safer default, and Google's verification
// process for this scope is much lighter than full drive access.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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

// Finds (or creates) a folder by name under an optional parent.
async function findOrCreateFolder(name, parentId = null) {
  const token = await getToken();
  let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
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
  const created = await createRes.json();
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

// Finds a non-folder file by exact name under a parent, or null.
async function findFile(name, parentId) {
  const token = await getToken();
  const query = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

// Creates or overwrites a CSV file at the root of the MangaTracker Drive
// folder — one file per fileName, always up to date, rather than a
// growing pile of dated backups. Called once per media type (e.g.
// "manga-backup.csv", "anime-backup.csv") so each type's data lives in
// its own file rather than one combined one. Returns the file id.
export function backupCsvToDrive(csvContent, fileName = 'library-backup.csv') {
  return uploadTextFileToDrive(csvContent, fileName, 'text/csv');
}

// Creates or overwrites a text file (by name) at the root of the
// MangaTracker Drive folder. Returns the file id.
export async function uploadTextFileToDrive(content, fileName, mimeType) {
  const token = await getToken();
  if (!cachedRootFolderId) {
    cachedRootFolderId = await findOrCreateFolder('MangaTracker');
  }

  const existingId = await findFile(fileName, cachedRootFolderId);

  if (existingId) {
    // Content-only update — no need to touch metadata, so a simple
    // media upload is enough (cheaper than the multipart create path).
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
        body: content,
      }
    );
    if (!res.ok) throw new Error(`Drive update of ${fileName} failed: ${res.status}`);
    return existingId;
  }

  const boundary = 'manga_tracker_backup_' + Date.now();
  const metadata = { name: fileName, parents: [cachedRootFolderId] };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive upload of ${fileName} failed: ${res.status}`);
  const data = await res.json();
  return data.id;
}

// Builds the "code - title" filename format used for cover uploads,
// e.g. "12345 - Some Manga Title". Falls back to just the code when no
// title was extracted, avoiding an awkward "12345 - 12345".
export function buildDriveDisplayName(sourceId, title) {
  return title ? `${sourceId} - ${title}` : sourceId;
}

// Downloads the raw text content of a backup CSV file, or null if it
// doesn't exist yet (e.g. never backed up from this account before).
export async function fetchBackupCsvContent(fileName = 'library-backup.csv') {
  const token = await getToken();
  if (!cachedRootFolderId) {
    cachedRootFolderId = await findOrCreateFolder('MangaTracker');
  }
  const fileId = await findFile(fileName, cachedRootFolderId);
  if (!fileId) return null;

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to download backup CSV: ${res.status}`);
  return res.text();
}

// Finds a cover image in MangaTracker/<mediaType>/ whose filename starts
// with the given source id (filenames are "code - title.jpg" or just
// "code.jpg"), or null if none is found.
async function findCoverFileId(mediaType, sourceId) {
  const token = await getToken();
  const folderId = await getOrCreateTypeFolder(mediaType);
  const query = `'${folderId}' in parents and trashed=false and name contains '${sourceId}'`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
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
// thumbnail until the page is browsed again).
export async function downloadCoverForRestore(mediaType, sourceId, localDir) {
  const fileId = await findCoverFileId(mediaType, sourceId);
  if (!fileId) return null;

  const token = await getToken();
  const dirInfo = await FileSystem.getInfoAsync(localDir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(localDir, { intermediates: true });
  }
  const localPath = `${localDir}${sourceId}.jpg`;
  await FileSystem.downloadAsync(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    localPath,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return localPath;
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

  const res = await fetch(
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
