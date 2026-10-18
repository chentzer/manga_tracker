// Background worker: keeps the page script running on your sites, and
// does what a visit means to the library in Drive — the same files the
// app backs up to (MangaTracker/<type>-backup.csv), which the app merges
// in on its next sync (src/backup.js). Every change stamps the row's
// updated_at, so the newer change wins on both sides.
/* global chrome, self */
import './sites.generated.js';
import './rules.js';
import { parseCsv, toCsv } from './csv.js';
import { connect, disconnect, isConnected, readTextFile, writeTextFile, uploadCover, NotSignedInError } from './drive.js';
import {
  findRow,
  findImported,
  recordProgress,
  progressDecision,
  newRow,
  adoptImported,
  hasAdultGenre,
  touch,
  today,
} from './library.js';

const CONTENT_SCRIPT_ID = 'manga-tracker-pages';

// ---------- Where the page script runs ----------

async function getSites() {
  const { sites } = await chrome.storage.local.get('sites');
  return sites || {};
}

// Runs the page script on every site set on the options page (whose
// access was granted there).
async function registerPageScript() {
  const origins = self.MTRules.origins(await getSites());
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (err) {
    // Not registered yet.
  }
  if (!origins.length) return;
  const granted = await chrome.permissions.contains({ origins });
  if (!granted) return;
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      matches: origins,
      js: ['sites.generated.js', 'rules.js', 'content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => registerPageScript().catch(console.warn));
chrome.runtime.onStartup.addListener(() => registerPageScript().catch(console.warn));

// ---------- The library files ----------

const fileName = (mediaType) => `${mediaType}-backup.csv`;

// Recently read files, so looking things up on every page doesn't
// download them each time. Writes always start from a fresh copy.
const cache = new Map(); // mediaType -> { fileId, header, rows, at }
const CACHE_MS = 30 * 1000;

async function load(mediaType, { fresh = false } = {}) {
  const cached = cache.get(mediaType);
  if (cached && !fresh && Date.now() - cached.at < CACHE_MS) return cached;
  const { fileId, text } = await readTextFile(fileName(mediaType));
  const { header, rows } = parseCsv(text);
  const file = { fileId, header, rows, at: Date.now() };
  cache.set(mediaType, file);
  return file;
}

// One change at a time: each reads the file fresh, changes its rows
// (change returns false to leave it alone) and writes it back.
let queue = Promise.resolve();
function mutate(mediaType, change) {
  const run = queue.then(async () => {
    const file = await load(mediaType, { fresh: true });
    const result = await change(file.rows);
    if (result === false || (result && result.unchanged)) return result;
    file.fileId = await writeTextFile(fileName(mediaType), file.fileId, toCsv(file.header, file.rows));
    file.at = Date.now();
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- AniList (18+ check, genres, totals) ----------

async function aniListInfo(malId, mediaType) {
  if (!malId) return null;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query:
          'query ($id: Int, $type: MediaType) { Media(idMal: $id, type: $type) { isAdult genres episodes chapters volumes } }',
        variables: { id: Number(malId), type: mediaType === 'anime' ? 'ANIME' : 'MANGA' },
      }),
    });
    return (await res.json()).data?.Media || null;
  } catch (err) {
    return null;
  }
}

// ---------- Covers ----------

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

// The page sends the cover it could read (dataUrl); otherwise it's
// fetched from here, which works for sites whose access was granted.
async function saveCover(mediaType, sourceId, title, { image, imageUrl }) {
  try {
    let blob = image ? await dataUrlToBlob(image) : null;
    if (!blob && imageUrl) {
      const res = await fetch(imageUrl);
      if (res.ok) blob = await res.blob();
    }
    if (!blob || !blob.size) return false;
    await uploadCover(mediaType, sourceId, title, blob);
    return true;
  } catch (err) {
    console.warn('Cover upload failed:', err);
    return false;
  }
}

// ---------- What a visit does ----------

const labels = (mediaType) =>
  mediaType === 'anime'
    ? { unit: 'episode', verb: 'rewatching', short: 'ep' }
    : { unit: 'chapter', verb: 'rereading', short: 'ch' };

// Asked once per series and chapter while the worker runs; "Not now" on
// a reread question stops it for an hour (as the app's "Just looking").
const asked = new Set();

async function repeatSnoozed(key) {
  const name = `repeatSnooze:${key}`;
  const stored = await chrome.storage.local.get(name);
  return Date.now() < (stored[name] || 0);
}

// Progress for a recorded series: records it, or returns a question for
// the page to show. Runs inside mutate (row is changed in place).
async function applyProgress(mediaType, row, chapter, url, { fresh = false } = {}) {
  const decision = progressDecision(row, chapter, { fresh });
  if (!decision) return { unchanged: true };
  const key = `${mediaType}:${row.source_id}`;
  const title = row.title || row.source_id;
  const { unit, verb } = labels(mediaType);
  if (decision.ask === 'repeat') {
    if (asked.has(`${key}:repeat`) || (await repeatSnoozed(key))) return { unchanged: true };
    asked.add(`${key}:repeat`);
    return {
      unchanged: true,
      question: {
        text: `You've completed "${title}". Start ${verb} it from ${unit} ${chapter}?`,
        buttons: [
          { label: 'Not now', answer: { kind: 'snooze' } },
          { label: `Start ${verb}`, answer: { kind: 'repeat', number: decision.number } },
        ],
      },
    };
  }
  if (decision.ask === 'ahead') {
    if (asked.has(`${key}:${decision.number}`)) return { unchanged: true };
    asked.add(`${key}:${decision.number}`);
    const where = decision.current
      ? `Your record for "${title}" says you stopped at ${unit} ${decision.current}`
      : `Your record says you haven't started "${title}"`;
    return {
      unchanged: true,
      question: {
        text: `${where}, but this is ${unit} ${decision.number}.`,
        buttons: [
          { label: `Keep ${decision.current}`, answer: { kind: 'keep' } },
          { label: `Record ${decision.number}`, answer: { kind: 'record', number: decision.number } },
        ],
      },
    };
  }
  const done = recordProgress(row, decision.record, url);
  if (!done) return { unchanged: true };
  return done.finishedRepeat
    ? { toast: `"${title}": ${verb} counted (${row.times_repeated} times).` }
    : {};
}

// The tab each page belongs to (for the popup).
async function rememberTab(tabId, mediaType, sourceId) {
  if (tabId === undefined || tabId === null) return;
  await chrome.storage.session.set({ [`tab:${tabId}`]: { mediaType, sourceId } });
  chrome.action.setBadgeText({ tabId, text: '✓' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a7a4c' }).catch(() => {});
}

async function forgetTab(tabId) {
  if (tabId === undefined || tabId === null) return;
  await chrome.storage.session.remove(`tab:${tabId}`);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

// A page with its series in the address: { need: 'details' } when the page
// has to be read (series not recorded, or still missing its MAL id).
async function handleVisit({ mediaType, sourceId, url, progress }, tabId) {
  if (!(await isConnected())) return { notConnected: true };
  const { rows } = await load(mediaType);
  const row = findRow(rows, sourceId);
  if (!row) return { need: 'details', isNew: true };
  await rememberTab(tabId, mediaType, sourceId);
  const result =
    progress === null || progress === undefined
      ? {}
      : await mutate(mediaType, async (fresh) => {
          const current = findRow(fresh, sourceId);
          return current ? applyProgress(mediaType, current, progress, url) : { unchanged: true };
        });
  return row.mal_id ? result : { ...result, need: 'details', isNew: false };
}

// The page's details (title, cover, author, MAL id; and for pages without
// their series in the address, the series and chapter).
async function handleDetails({ mediaType, sourceId, url, progress, payload, image }, tabId) {
  if (!(await isConnected())) return { notConnected: true };
  const { rows } = await load(mediaType, { fresh: true });
  const existing = findRow(rows, sourceId);
  if (existing) {
    await rememberTab(tabId, mediaType, sourceId);
    return mutate(mediaType, async (fresh) => {
      const row = findRow(fresh, sourceId);
      if (!row) return { unchanged: true };
      let changed = false;
      if (!row.mal_id && payload.malId) {
        row.mal_id = String(payload.malId);
        touch(row);
        changed = true;
      }
      const result =
        progress === null || progress === undefined ? { unchanged: true } : await applyProgress(mediaType, row, progress, url);
      return changed ? { ...result, unchanged: false } : result;
    });
  }
  if (payload.skip) return {};

  // 18+ titles aren't recorded (the site's genres, or AniList by MAL id).
  const info = await aniListInfo(payload.malId, mediaType);
  if (hasAdultGenre(payload.genre) || (info && (info.isAdult || hasAdultGenre(info.genres)))) {
    return { toast: `NSFW (18+): "${payload.title || sourceId}" wasn't added to the library.` };
  }

  const coverSaved = await saveCover(mediaType, sourceId, payload.title, { image, imageUrl: payload.imageUrl });
  const details = {
    title: payload.title,
    altTitle: payload.altTitle,
    author: payload.author,
    sourceUrl: payload.sourceUrl || url,
    malId: payload.malId,
    coverSaved,
  };
  const result = await mutate(mediaType, async (fresh) => {
    if (findRow(fresh, sourceId)) return { unchanged: true }; // recorded meanwhile
    const imported = findImported(fresh, payload.malId, [payload.title, payload.altTitle]);
    let row;
    if (imported) {
      adoptImported(fresh, mediaType, imported, sourceId, details);
      row = imported;
    } else {
      row = newRow(mediaType, sourceId, details);
      fresh.push(row);
    }
    if (info) {
      row.genres = (info.genres || []).join(',');
      row.is_adult = info.isAdult ? '1' : '0';
      row.anilist_checked = today();
      const total = mediaType === 'anime' ? info.episodes : info.chapters;
      if (!Number(row.total) && total) row.total = String(total);
      if (mediaType !== 'anime' && !Number(row.total_volumes) && info.volumes) row.total_volumes = String(info.volumes);
    }
    const progressResult =
      progress === null || progress === undefined
        ? {}
        : await applyProgress(mediaType, row, progress, url, { fresh: !imported });
    const title = row.title || sourceId;
    return {
      ...progressResult,
      unchanged: false,
      toast:
        progressResult.toast ||
        (imported ? `Linked "${title}" to your MyAnimeList entry.` : `Added "${title}" to Manga Tracker.`),
    };
  });
  await rememberTab(tabId, mediaType, sourceId);
  return result;
}

// An answer to a question shown on the page.
async function handleAnswer({ mediaType, sourceId, url, answer }) {
  const key = `${mediaType}:${sourceId}`;
  if (answer.kind === 'snooze') {
    await chrome.storage.local.set({ [`repeatSnooze:${key}`]: Date.now() + 60 * 60 * 1000 });
    return {};
  }
  if (answer.kind === 'keep') return {};
  return mutate(mediaType, async (rows) => {
    const row = findRow(rows, sourceId);
    if (!row) return { unchanged: true };
    if (answer.kind === 'repeat') {
      row.repeating = '1';
      row.repeat_progress = '0';
      touch(row);
    }
    const done = recordProgress(row, answer.number, url);
    if (!done && answer.kind !== 'repeat') return { unchanged: true };
    return done && done.finishedRepeat ? { toast: 'Reread counted.' } : {};
  });
}

// ---------- Popup ----------

const EDITABLE = ['read_status', 'score', 'progress', 'progress_volumes', 'repeating', 'repeat_progress', 'favorite'];

async function handleTabEntry({ tabId }) {
  const connected = await isConnected();
  const stored = await chrome.storage.session.get(`tab:${tabId}`);
  const where = stored[`tab:${tabId}`];
  if (!where) return { connected, entry: null };
  if (!connected) return { connected, entry: null, where };
  const { rows } = await load(where.mediaType);
  return { connected, where, entry: findRow(rows, where.sourceId) };
}

async function handleEdit({ mediaType, sourceId, fields }) {
  return mutate(mediaType, async (rows) => {
    const row = findRow(rows, sourceId);
    if (!row) return { unchanged: true };
    Object.keys(fields)
      .filter((k) => EDITABLE.includes(k))
      .forEach((k) => {
        row[k] = fields[k] === null || fields[k] === undefined ? '' : String(fields[k]);
      });
    // As in the app: Reading fills an empty start date, Completed an empty
    // finish date and the progress up to the total.
    if (fields.read_status === 'reading' && !row.start_date) row.start_date = today();
    if (fields.read_status === 'read') {
      if (!row.finish_date) row.finish_date = today();
      if (Number(row.total) && Number(row.progress) < Number(row.total)) row.progress = row.total;
    }
    touch(row);
    return { entry: { ...row } };
  });
}

// ---------- Messages ----------

const handlers = {
  visit: (msg, sender) => handleVisit(msg, sender.tab && sender.tab.id),
  details: (msg, sender) => handleDetails(msg, sender.tab && sender.tab.id),
  answer: (msg) => handleAnswer(msg),
  leftPage: (msg, sender) => forgetTab(sender.tab && sender.tab.id).then(() => ({})),
  tabEntry: (msg) => handleTabEntry(msg),
  edit: (msg) => handleEdit(msg),
  connect: () => connect().then(() => ({ ok: true })),
  disconnect: () => disconnect().then(() => ({ ok: true })),
  status: async () => ({ connected: await isConnected() }),
  sitesChanged: () => registerPageScript().then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => sendResponse(result || {}))
    .catch((err) =>
      sendResponse({ error: err instanceof NotSignedInError ? 'notConnected' : err.message || String(err) })
    );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));
