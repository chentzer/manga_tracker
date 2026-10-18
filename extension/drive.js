// Google sign-in and Drive, for the background worker. Signs in with the
// Google client set on the options page (the app's web client works:
// same Cloud project, so the drive.file scope sees the app's MangaTracker
// folder). Brave has no chrome.identity.getAuthToken, so this uses the
// web sign-in window (launchWebAuthFlow); its redirect address
// (chrome.identity.getRedirectURL()) has to be added to the client.
/* global chrome */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// A Drive request that failed, with its HTTP status.
class DriveError extends Error {
  constructor(status) {
    super(`Drive request failed (${status}).`);
    this.status = status;
  }
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not connected to Google Drive. Open the extension settings and press Connect.');
  }
}

async function clientId() {
  const { googleClientId } = await chrome.storage.local.get('googleClientId');
  if (!googleClientId) throw new Error('Set your Google client ID in the extension settings first.');
  return googleClientId;
}

// Asks Google for a token; interactive shows the account window.
async function requestToken(interactive) {
  const params = new URLSearchParams({
    client_id: await clientId(),
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    prompt: interactive ? 'select_account' : 'none',
  });
  const { loginHint } = await chrome.storage.local.get('loginHint');
  if (loginHint) params.set('login_hint', loginHint);
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive,
    });
  } catch (err) {
    if (!interactive) throw new NotSignedInError();
    throw err;
  }
  const answer = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = answer.get('access_token');
  if (!token) {
    if (!interactive) throw new NotSignedInError();
    throw new Error(answer.get('error') || 'Google sign-in failed.');
  }
  const expiresAt = Date.now() + (Number(answer.get('expires_in')) || 3600) * 1000 - 60000;
  await chrome.storage.session.set({ driveToken: token, driveTokenExpiresAt: expiresAt });
  await chrome.storage.local.set({ driveConnected: true });
  return token;
}

export async function connect() {
  const token = await requestToken(true);
  // Remembered so later silent sign-ins pick the same account.
  try {
    const res = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.user && data.user.emailAddress) await chrome.storage.local.set({ loginHint: data.user.emailAddress });
  } catch (err) {
    // Not needed to work.
  }
  await forgetAllIds();
}

export async function disconnect() {
  await chrome.storage.session.remove(['driveToken', 'driveTokenExpiresAt']);
  await chrome.storage.local.set({ driveConnected: false });
  await forgetAllIds();
}

export async function isConnected() {
  const { driveConnected } = await chrome.storage.local.get('driveConnected');
  return !!driveConnected;
}

async function token() {
  const { driveToken, driveTokenExpiresAt } = await chrome.storage.session.get(['driveToken', 'driveTokenExpiresAt']);
  if (driveToken && Date.now() < driveTokenExpiresAt) return driveToken;
  if (!(await isConnected())) throw new NotSignedInError();
  return requestToken(false);
}

// fetch with the token; a rejected token gets one fresh try.
async function api(url, options = {}, retry = true) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${await token()}` },
  });
  if (res.status === 401 && retry) {
    await chrome.storage.session.remove(['driveToken', 'driveTokenExpiresAt']);
    return api(url, options, false);
  }
  if (!res.ok) throw new DriveError(res.status);
  return res;
}

// ---------- Remembered ids ----------
// Folder and file ids are kept in session storage (driveId:<name>), so a
// save doesn't search Drive for the MangaTracker folder and the CSV every
// time, even after the browser puts the worker to sleep. An id is looked
// up again only when Drive says it's gone.

async function rememberedId(name) {
  const key = `driveId:${name}`;
  return (await chrome.storage.session.get(key))[key] || null;
}

async function rememberId(name, id) {
  if (id) await chrome.storage.session.set({ [`driveId:${name}`]: id });
}

async function forgetId(name) {
  await chrome.storage.session.remove(`driveId:${name}`);
}

async function forgetAllIds() {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('driveId:')));
}

const gone = (err) => err instanceof DriveError && (err.status === 404 || err.status === 410);

async function findOne(query) {
  const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=createdTime`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function findOrCreateFolder(name, parentId = null) {
  const key = `folder:${parentId || ''}/${name}`;
  const known = await rememberedId(key);
  if (known) return known;
  let query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  let id = await findOne(query);
  if (!id) {
    const res = await api(`${API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    id = (await res.json()).id;
  }
  await rememberId(key, id);
  return id;
}

// The app's folder: MangaTracker, with covers in MangaTracker/<type>/.
const rootFolder = () => findOrCreateFolder('MangaTracker');

// A file at the top of MangaTracker, by name (remembered), or null.
async function fileId(name, { lookUp = false } = {}) {
  const key = `file:${name}`;
  if (!lookUp) {
    const known = await rememberedId(key);
    if (known) return known;
  }
  const root = await rootFolder();
  const id = await findOne(`name='${name}' and '${root}' in parents and trashed=false`);
  if (id) await rememberId(key, id);
  else await forgetId(key);
  return id;
}

// { fileId, text } of a file at the top of MangaTracker (text '' and
// fileId null when it doesn't exist yet).
export async function readTextFile(name) {
  let id = await fileId(name);
  if (!id) return { fileId: null, text: '' };
  try {
    const res = await api(`${API}/files/${id}?alt=media`);
    return { fileId: id, text: await res.text() };
  } catch (err) {
    if (!gone(err)) throw err;
    // Replaced or removed since: find it again.
    id = await fileId(name, { lookUp: true });
    if (!id) return { fileId: null, text: '' };
    const res = await api(`${API}/files/${id}?alt=media`);
    return { fileId: id, text: await res.text() };
  }
}

function multipart(metadata, body, contentType) {
  const boundary = `manga_tracker_ext_${Date.now()}`;
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      body,
      `\r\n--${boundary}--`,
    ]),
  };
}

// Writes a file at the top of MangaTracker (fileId from readTextFile, or
// null to create it). Returns its id.
export async function writeTextFile(name, knownId, text, contentType = 'text/csv') {
  let id = knownId;
  if (id) {
    try {
      await api(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': contentType },
        body: text,
      });
      return id;
    } catch (err) {
      if (!gone(err)) throw err;
      id = await fileId(name, { lookUp: true });
      if (id) return writeTextFile(name, id, text, contentType);
    }
  }
  const root = await rootFolder();
  const { contentType: type, body } = multipart({ name, parents: [root] }, text, contentType);
  const res = await api(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
  id = (await res.json()).id;
  await rememberId(`file:${name}`, id);
  return id;
}

// A cover in MangaTracker/<type>/, named like the app's ("<code> - <title>.jpg").
export async function uploadCover(mediaType, sourceId, title, blob, retry = true) {
  try {
    return await postCover(mediaType, sourceId, title, blob);
  } catch (err) {
    if (!retry || !gone(err)) throw err;
    // A remembered folder is gone: find (or make) the folders again.
    await forgetAllIds();
    return uploadCover(mediaType, sourceId, title, blob, false);
  }
}

async function postCover(mediaType, sourceId, title, blob) {
  const folder = await findOrCreateFolder(mediaType, await rootFolder());
  const display = title ? `${sourceId} - ${title}` : sourceId;
  const safeName = String(display).replace(/[\\/:*?"<>|]/g, '').slice(0, 100) || 'untitled';
  const { contentType, body } = multipart(
    { name: `${safeName}.jpg`, parents: [folder] },
    blob,
    blob.type || 'image/jpeg'
  );
  const res = await api(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  return (await res.json()).id;
}
