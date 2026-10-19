// Background worker: keeps the page script running on your sites, and
// does what a visit means to the library in Drive — the same files the
// app backs up to (MangaTracker/<type>-backup.csv), which the app merges
// in on its next sync (src/backup.js). Every change stamps the row's
// updated_at, so the newer change wins on both sides.
//
// Saving is instant: a change is decided on the extension's own copy of
// the library, put in an outbox (chrome.storage.local, so it survives
// the browser closing) and answered straight away. The outbox is then
// written to Drive in the background: a fresh read of the file, the
// waiting changes applied to it, one write. A failed write stays in the
// outbox and is retried (5 s, 15 s, 60 s while the worker is awake, then
// every minute by alarm, and when the browser starts or Drive is
// connected); the badge shows changes still waiting.
/* global chrome, self */
import './sites.generated.js';
import './rules.js';
import { parseCsv, toCsv } from './csv.js';
import { connect, disconnect, isConnected, readTextFile, writeTextFile, uploadCover, NotSignedInError } from './drive.js';
import { findRow, findImported, progressDecision, recordProgress, hasAdultGenre, applyChange } from './library.js';

const CONTENT_SCRIPT_ID = 'manga-tracker-pages';
const FLUSH_ALARM = 'manga-tracker-flush';

// ---------- Timing (background console) ----------

// timer('details 123').mark('read') … .end(): how long each step took.
function timer(label) {
  const start = performance.now();
  let last = start;
  const parts = [];
  return {
    mark(step) {
      const now = performance.now();
      parts.push(`${step} ${Math.round(now - last)}ms`);
      last = now;
    },
    end(step = 'done') {
      this.mark(step);
      console.log(`[AniManga Tracker] ${label}: ${parts.join(', ')} — total ${Math.round(performance.now() - start)}ms`);
    },
  };
}

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

chrome.runtime.onInstalled.addListener(() => {
  registerPageScript().catch(console.warn);
  flushSoon(0);
});
chrome.runtime.onStartup.addListener(() => {
  registerPageScript().catch(console.warn);
  flushSoon(0);
});

// ---------- The outbox ----------

async function outbox() {
  const { outbox: list } = await chrome.storage.local.get('outbox');
  return list || [];
}

async function setOutbox(list) {
  await chrome.storage.local.set({ outbox: list });
  await showSyncState();
}

// Changes are added and removed one at a time, so two at once can't lose
// one another.
let outboxLock = Promise.resolve();
function withOutbox(fn) {
  const run = outboxLock.then(async () => {
    const list = await outbox();
    const next = await fn(list);
    if (next) await setOutbox(next);
  });
  outboxLock = run.catch(() => {});
  return run;
}

let nextChangeId = Date.now();
async function enqueue(mediaType, ...changes) {
  await withOutbox((list) => [...list, ...changes.map((c) => ({ ...c, mediaType, id: nextChangeId++ }))]);
  flushSoon(0);
}

// The badge: "…" while changes wait, "!" when writing them failed.
let lastError = null;
async function showSyncState() {
  const list = await outbox();
  const waiting = list.length;
  await chrome.action.setBadgeText({ text: waiting ? (lastError ? '!' : '…') : '' }).catch(() => {});
  await chrome.action
    .setBadgeBackgroundColor({ color: lastError ? '#e94560' : '#667085' })
    .catch(() => {});
  await chrome.action
    .setTitle({
      title: waiting
        ? `AniManga Tracker — ${waiting} change${waiting === 1 ? '' : 's'} waiting to sync${lastError ? ` (${lastError})` : ''}`
        : 'AniManga Tracker',
    })
    .catch(() => {});
}

// ---------- The library files ----------

const fileName = (mediaType) => `${mediaType}-backup.csv`;

// The last copy read from (or written to) Drive per type.
const files = new Map(); // mediaType -> { fileId, header, rows, at }
const FILE_MS = 30 * 1000;

async function readFile(mediaType) {
  const { fileId, text } = await readTextFile(fileName(mediaType));
  const { header, rows } = parseCsv(text);
  const file = { fileId, header, rows, at: Date.now() };
  files.set(mediaType, file);
  return file;
}

const clone = (rows) => rows.map((r) => ({ ...r }));

// The extension's view of a type's rows: the last copy from Drive with
// the changes still in the outbox on top. What every answer is decided
// on. A copy older than 30 s is read again in the background (answers
// don't wait for it); one older than 5 minutes, or none, is waited for.
// The write to Drive always starts from a fresh read, so a slightly old
// copy here never overwrites anything.
const STALE_MS = 5 * 60 * 1000;
const refreshing = new Map();
function refresh(mediaType) {
  if (!refreshing.has(mediaType)) {
    refreshing.set(mediaType, readFile(mediaType).finally(() => refreshing.delete(mediaType)));
  }
  return refreshing.get(mediaType);
}

async function view(mediaType) {
  let file = files.get(mediaType);
  const age = file ? Date.now() - file.at : Infinity;
  if (age > STALE_MS) file = await refresh(mediaType);
  else if (age > FILE_MS) refresh(mediaType).catch(() => {});
  const rows = clone(file.rows);
  (await outbox()).filter((c) => c.mediaType === mediaType).forEach((c) => applyChange(rows, mediaType, c));
  return rows;
}

// Writes the outbox to Drive: per type, a fresh read, the changes applied,
// one write; then those changes leave the outbox. One run at a time.
let flushing = null;
let retryTimer = null;
let failures = 0;
const RETRY_MS = [5000, 15000, 60000];

function flushSoon(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => flush().catch(() => {}), ms);
}

async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    const list = await outbox();
    if (!list.length) {
      chrome.alarms.clear(FLUSH_ALARM);
      return;
    }
    if (!(await isConnected())) {
      lastError = 'not connected to Drive';
      await showSyncState();
      return;
    }
    const done = new Set();
    try {
      for (const mediaType of [...new Set(list.map((c) => c.mediaType))]) {
        const changes = list.filter((c) => c.mediaType === mediaType);
        const t = timer(`sync ${mediaType} (${changes.length} change${changes.length === 1 ? '' : 's'})`);
        const file = await readFile(mediaType);
        t.mark('read');
        const covers = changes.filter((c) => c.kind === 'cover');
        const rowChanges = changes.filter((c) => c.kind !== 'cover');
        const changed = rowChanges.map((c) => applyChange(file.rows, mediaType, c)).some(Boolean);
        if (changed) {
          file.fileId = await writeTextFile(fileName(mediaType), file.fileId, toCsv(file.header, file.rows));
          file.at = Date.now();
          t.mark('write');
        }
        rowChanges.forEach((c) => done.add(c.id));
        for (const c of covers) {
          await uploadCoverNow(c);
          done.add(c.id);
        }
        if (covers.length) t.mark('covers');
        t.end();
      }
      failures = 0;
      lastError = null;
    } catch (err) {
      failures++;
      lastError = err instanceof NotSignedInError ? 'not connected to Drive' : err.message || String(err);
      console.warn('[AniManga Tracker] sync failed, will retry:', lastError);
    }
    // The pages the changes came from hear about a failed write once
    // ("Not in Drive yet"), and again when it's in ("Now in Drive").
    const delayed = lastError ? list.filter((c) => !done.has(c.id) && c.tabId != null && !c.told) : [];
    notifyTabs(delayed, { type: 'saveDelayed', error: lastError });
    notifyTabs(list.filter((c) => done.has(c.id) && c.told), { type: 'saveDone' });
    const told = new Set(delayed.map((c) => c.id));
    await withOutbox((current) =>
      current.filter((c) => !done.has(c.id)).map((c) => (told.has(c.id) ? { ...c, told: true } : c))
    );
    const left = (await outbox()).length;
    if (left) {
      // Retried while the worker is awake; the alarm wakes it otherwise.
      chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
      if (lastError) flushSoon(RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
      else flushSoon(0); // added while this run was writing
    } else {
      chrome.alarms.clear(FLUSH_ALARM);
    }
    await showSyncState();
  })();
  try {
    return await flushing;
  } finally {
    flushing = null;
  }
}

// One message per page and title.
function notifyTabs(changes, message) {
  const seen = new Set();
  changes.forEach((c) => {
    const key = `${c.tabId}:${c.title}`;
    if (!c.title || seen.has(key)) return;
    seen.add(key);
    // A page that's gone, or has no content script, can't be told.
    Promise.resolve()
      .then(() => chrome.tabs.sendMessage(c.tabId, { ...message, title: c.title }))
      .catch(() => {});
  });
}

// A change with the page and title it came from (for notifyTabs).
const from = (change, tabId, title) => ({ ...change, tabId: tabId ?? null, title: title || change.sourceId });

// "Chapter 12 recorded: …" when a visit moved the progress on, else a
// short "Already in …" so it's clear the extension saw the page.
function seenToast(mediaType, title, progress, recorded) {
  const { unit } = labels(mediaType);
  return recorded
    ? { toast: `${unit[0].toUpperCase()}${unit.slice(1)} ${progress} recorded: ${title}` }
    : { toast: `Already in AniManga Tracker: ${title}`, brief: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flush().catch(() => {});
});

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

async function coverBlob({ image, imageUrl }) {
  let blob = image ? await (await fetch(image)).blob() : null;
  if (!blob && imageUrl) {
    const res = await fetch(imageUrl);
    if (res.ok) blob = await res.blob();
  }
  return blob && blob.size ? blob : null;
}

// Uploads a queued cover; one that can't be fetched at all is dropped
// (throws only for Drive errors, which are retried).
async function uploadCoverNow(change) {
  let blob = null;
  try {
    blob = await coverBlob(change);
  } catch (err) {
    blob = null;
  }
  if (!blob) return;
  await uploadCover(change.mediaType, change.sourceId, change.title, blob);
}

// A new title's cover: uploaded right away alongside the entry's write;
// if that fails it goes in the outbox to be retried.
function saveCoverSoon(mediaType, sourceId, title, image, imageUrl) {
  const change = { kind: 'cover', mediaType, sourceId, title, image: image || null, imageUrl: imageUrl || null };
  uploadCoverNow(change).catch(() => enqueue(mediaType, change));
}

// ---------- What a visit does ----------

const labels = (mediaType) =>
  mediaType === 'anime' ? { unit: 'episode', verb: 'rewatching' } : { unit: 'chapter', verb: 'rereading' };

// Asked once per series and chapter while the worker runs; "Not now" on
// a reread question stops it for an hour (as the app's "Just looking").
const asked = new Set();

async function repeatSnoozed(key) {
  const name = `repeatSnooze:${key}`;
  const stored = await chrome.storage.local.get(name);
  return Date.now() < (stored[name] || 0);
}

// Progress for a recorded series: { change } to queue, or a question for
// the page to show.
async function progressAnswer(mediaType, row, chapter, url, { fresh = false } = {}) {
  const decision = progressDecision(row, chapter, { fresh });
  if (!decision) return {};
  const key = `${mediaType}:${row.source_id}`;
  const title = row.title || row.source_id;
  const { unit, verb } = labels(mediaType);
  if (decision.ask === 'repeat') {
    if (asked.has(`${key}:repeat`) || (await repeatSnoozed(key))) return {};
    asked.add(`${key}:repeat`);
    return {
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
    if (asked.has(`${key}:${decision.number}`)) return {};
    asked.add(`${key}:${decision.number}`);
    const where = decision.current
      ? `Your record for "${title}" says you stopped at ${unit} ${decision.current}`
      : `Your record says you haven't started "${title}"`;
    return {
      question: {
        text: `${where}, but this is ${unit} ${decision.number}.`,
        buttons: [
          { label: `Keep ${decision.current}`, answer: { kind: 'keep' } },
          { label: `Record ${decision.number}`, answer: { kind: 'record', number: decision.number } },
        ],
      },
    };
  }
  return { change: { kind: 'record', sourceId: row.source_id, number: decision.record, url } };
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
  const t = timer(`visit ${mediaType} ${sourceId}`);
  const row = findRow(await view(mediaType), sourceId);
  t.mark('library');
  if (!row) {
    t.end('new title');
    return { need: 'details', isNew: true };
  }
  await rememberTab(tabId, mediaType, sourceId);
  const title = row.title || sourceId;
  let result = {};
  let recorded = false;
  if (progress !== null && progress !== undefined) {
    const a = await progressAnswer(mediaType, row, progress, url);
    if (a.change) {
      recorded = !!recordProgress({ ...row }, a.change.number, null);
      await enqueue(mediaType, from(a.change, tabId, title));
    }
    result = a.question ? { question: a.question } : {};
  }
  if (!result.question) result = seenToast(mediaType, title, progress, recorded);
  t.end(outcome(result));
  return row.mal_id ? result : { ...result, need: 'details', isNew: false };
}

const outcome = (result) => (result.question ? 'asked' : 'answered');

// The page's details (title, cover, author, MAL id; and for pages without
// their series in the address, the series and chapter).
async function handleDetails({ mediaType, sourceId, url, progress, payload, image, fromPage }, tabId) {
  if (!(await isConnected())) return { notConnected: true };
  const t = timer(`details ${mediaType} ${sourceId}`);
  const rows = await view(mediaType);
  t.mark('library');
  const existing = findRow(rows, sourceId);
  if (existing) {
    await rememberTab(tabId, mediaType, sourceId);
    const title = existing.title || sourceId;
    const changes = [];
    if (!existing.mal_id && payload.malId) changes.push({ kind: 'malId', sourceId, malId: payload.malId });
    let result = {};
    let recorded = false;
    if (progress !== null && progress !== undefined) {
      const a = await progressAnswer(mediaType, existing, progress, url);
      if (a.change) {
        recorded = !!recordProgress({ ...existing }, a.change.number, null);
        changes.push(a.change);
      }
      if (a.question) result = { question: a.question };
    }
    if (changes.length) await enqueue(mediaType, ...changes.map((c) => from(c, tabId, title)));
    // Pages that name their series themselves had no visit answer, so
    // they're told here.
    if (fromPage && !result.question) result = seenToast(mediaType, title, progress, recorded);
    t.end(outcome(result));
    return result;
  }
  if (payload.skip) {
    t.end('skipped');
    return {};
  }

  // 18+ titles aren't recorded (the site's genres, or AniList by MAL id).
  const info = await aniListInfo(payload.malId, mediaType);
  t.mark('anilist');
  if (hasAdultGenre(payload.genre) || (info && (info.isAdult || hasAdultGenre(info.genres)))) {
    t.end('nsfw');
    return { toast: `NSFW (18+): "${payload.title || sourceId}" wasn't added to the library.` };
  }

  const imported = findImported(rows, payload.malId, [payload.title, payload.altTitle]);
  const details = {
    title: payload.title,
    altTitle: payload.altTitle,
    author: payload.author,
    sourceUrl: payload.sourceUrl || url,
    malId: payload.malId,
    coverSaved: false,
  };
  const add = { kind: 'add', sourceId, importedId: imported ? imported.source_id : null, details, info };
  // Progress is decided on the title as it will be once added.
  const after = clone(rows);
  applyChange(after, mediaType, add);
  const row = findRow(after, sourceId);
  const a =
    progress === null || progress === undefined
      ? {}
      : await progressAnswer(mediaType, row, progress, url, { fresh: !imported });
  const added = payload.title || sourceId;
  await enqueue(mediaType, ...[add, ...(a.change ? [a.change] : [])].map((c) => from(c, tabId, added)));
  saveCoverSoon(mediaType, sourceId, payload.title, image, payload.imageUrl);
  await rememberTab(tabId, mediaType, sourceId);
  const title = row.title || sourceId;
  t.end('queued');
  return {
    ...(a.question ? { question: a.question } : {}),
    toast: imported ? `Linked "${title}" to your MyAnimeList entry.` : `Added "${title}" to AniManga Tracker.`,
  };
}

// An answer to a question shown on the page.
async function handleAnswer({ mediaType, sourceId, url, answer: reply }, tabId) {
  const key = `${mediaType}:${sourceId}`;
  if (reply.kind === 'snooze') {
    await chrome.storage.local.set({ [`repeatSnooze:${key}`]: Date.now() + 60 * 60 * 1000 });
    return {};
  }
  if (reply.kind === 'keep') return {};
  const change = { kind: reply.kind === 'repeat' ? 'repeat' : 'record', sourceId, number: reply.number, url };
  const row = findRow(await view(mediaType), sourceId);
  await enqueue(mediaType, from(change, tabId, row && row.title));
  return {};
}

// ---------- Popup ----------

async function handleTabEntry({ tabId }) {
  const connected = await isConnected();
  const waiting = (await outbox()).length;
  const sync = { waiting, error: lastError };
  const stored = await chrome.storage.session.get(`tab:${tabId}`);
  const where = stored[`tab:${tabId}`];
  if (!where) return { connected, sync, entry: null };
  if (!connected) return { connected, sync, entry: null, where };
  return { connected, sync, where, entry: findRow(await view(where.mediaType), where.sourceId) };
}

async function handleEdit({ mediaType, sourceId, fields }) {
  const t = timer(`edit ${mediaType} ${sourceId}`);
  await enqueue(mediaType, { kind: 'edit', sourceId, fields });
  const entry = findRow(await view(mediaType), sourceId);
  t.end('queued');
  return { entry };
}

// ---------- Messages ----------

const handlers = {
  visit: (msg, sender) => handleVisit(msg, sender.tab && sender.tab.id),
  details: (msg, sender) => handleDetails(msg, sender.tab && sender.tab.id),
  answer: (msg, sender) => handleAnswer(msg, sender.tab && sender.tab.id),
  leftPage: (msg, sender) => forgetTab(sender.tab && sender.tab.id).then(() => ({})),
  tabEntry: (msg) => handleTabEntry(msg),
  edit: (msg) => handleEdit(msg),
  connect: () =>
    connect().then(() => {
      flushSoon(0);
      return { ok: true };
    }),
  disconnect: () => disconnect().then(() => ({ ok: true })),
  status: async () => ({ connected: await isConnected(), waiting: (await outbox()).length, error: lastError }),
  syncNow: () => flush().then(async () => ({ waiting: (await outbox()).length, error: lastError })),
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

// Whatever was waiting when the worker last stopped.
flushSoon(1000);
