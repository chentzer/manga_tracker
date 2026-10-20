// Runs on the sites set on the options page (registered by background.js).
// Watches the address (sites change pages without reloading), and on a
// title's page reads it with the app's own page script for that site
// (sites.generated.js), then tells the background worker. Shows its
// answers in a small card at the bottom right: what was recorded, and
// questions such as "Start rereading?".
/* global chrome, MTRules */
(function () {
  if (window.__mangaTrackerPage) return;
  window.__mangaTrackerPage = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response || {});
        });
      } catch (err) {
        resolve({ error: String(err) }); // the extension was reloaded
      }
    });
  }

  // ---------- The card ----------

  // A card without buttons goes after 4 seconds (2.5 when brief), or when
  // clicked; one with buttons stays until one is pressed.
  let card = null;
  function showCard(text, buttons = [], onAnswer = null, brief = false) {
    if (!card) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .card { font: 14px/1.4 system-ui, sans-serif; background: #16213e; color: #fff; border-radius: 10px;
            padding: 12px 14px; max-width: 320px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
          .name { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #8892b0; margin-bottom: 4px; }
          .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
          button { font: inherit; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; background: #2a3a5e; color: #fff; }
          button.main { background: #e94560; }
        </style>
        <div class="card"><div class="name">AniManga Tracker</div><div class="text"></div><div class="row"></div></div>`;
      document.documentElement.appendChild(host);
      card = { host, root, timer: null, buttons: false };
      root.querySelector('.card').addEventListener('click', () => {
        if (!card.buttons) card.host.style.display = 'none';
      });
    }
    clearTimeout(card.timer);
    card.host.style.display = '';
    card.root.querySelector('.text').textContent = text;
    const row = card.root.querySelector('.row');
    row.innerHTML = '';
    buttons.forEach((b, i) => {
      const button = document.createElement('button');
      button.textContent = b.label;
      if (i === buttons.length - 1) button.className = 'main';
      button.addEventListener('click', () => {
        card.host.style.display = 'none';
        if (onAnswer) onAnswer(b.answer);
      });
      row.appendChild(button);
    });
    card.buttons = buttons.length > 0;
    if (!buttons.length) card.timer = setTimeout(() => (card.host.style.display = 'none'), brief ? 2500 : 4000);
  }

  // Shows what the background worker said about this page.
  function show(result, context) {
    if (!result) return;
    if (result.error && result.error !== 'notConnected') console.warn('AniManga Tracker:', result.error);
    if (result.question) {
      showCard(result.question.text, result.question.buttons, (answer) =>
        send({ type: 'answer', ...context, answer }).then((r) => show(r, context))
      );
    } else if (result.toast) {
      showCard(result.toast, [], null, !!result.brief);
    }
  }

  // A save is written to Drive after the card shows; only a delay says so,
  // and then again once it's in.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'saveDelayed') {
      showCard(`Not in Drive yet: ${message.title}. AniManga Tracker keeps trying (${message.error}).`);
    } else if (message.type === 'saveDone') {
      showCard(`Now in Drive: ${message.title}`, [], null, true);
    }
  });

  // ---------- Reading a page ----------

  // Runs the app's page script for the site; it reports through
  // window.ReactNativeWebView.postMessage, as in the app's webview.
  function readPage(source) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ skip: 'the page took too long' }), 20000);
      window.ReactNativeWebView = {
        postMessage(text) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            resolve({ skip: 'unreadable answer' });
          }
        },
      };
      try {
        source.extractMetadata();
      } catch (err) {
        clearTimeout(timer);
        resolve({ skip: `page script failed: ${err.message}` });
      }
    });
  }

  // The cover as a data: URL, when the page can read it (same site, or a
  // host that allows it); otherwise the background worker tries.
  async function coverData(url) {
    if (!url) return null;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size > 5 * 1024 * 1024) return null;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (err) {
      return null;
    }
  }

  // ---------- Following the address ----------

  let types = [];
  let lastUrl = null;
  const reading = new Set();

  async function onPage(url) {
    const all = MTRules.resolveAll(types, url);
    if (!all.length) {
      send({ type: 'leftPage' });
      return;
    }
    const { type, source, match } = all[0];
    // A site in more than one tab (the Manga tab's second site is in
    // Manhwa's too): the background worker uses the tab the title is
    // already saved under, else the first.
    const otherTypes = all.slice(1).map((r) => r.type.key);
    let mediaType = type.key;
    if (source.interstitialKeywords && source.interstitialKeywords.some((k) => url.includes(k))) return;
    const sourceId = source.extractId(match);
    const progress = source.extractProgress ? source.extractProgress(match, url) : null;
    if (!sourceId && !source.seriesFromPage) return;

    if (reading.has(url)) return;
    reading.add(url);
    try {
      // The page is read straight away (after a moment to settle), while
      // the library is checked; its details are only sent if needed. The
      // site's page scripts wait for details that load later themselves.
      const started = performance.now();
      const ms = () => `${Math.round(performance.now() - started)}ms`;
      const read = sleep(300).then(() => readPage(source)).then((p) => {
        console.debug(`[AniManga Tracker] page read at ${ms()}`);
        return p;
      });
      let visit = { need: 'details', isNew: true };
      if (sourceId) {
        visit = await send({ type: 'visit', mediaType, otherTypes, sourceId, url, progress });
        if (visit.mediaType) mediaType = visit.mediaType;
        console.debug(`[AniManga Tracker] library checked at ${ms()}`);
        show(visit, { mediaType, sourceId, url });
      }
      if (visit.notConnected || visit.error || visit.need !== 'details') return;
      const payload = await read;
      const id = payload.sourceId ? String(payload.sourceId) : sourceId;
      if (!id) return;
      const pageUrl = payload.pageUrl || url;
      const pageProgress =
        payload.progress !== undefined && payload.progress !== null ? payload.progress : progress;
      const image = visit.isNew && !payload.skip ? await coverData(payload.imageUrl) : null;
      const context = { mediaType, sourceId: id, url: pageUrl };
      const result = await send({
        type: 'details',
        ...context,
        progress: pageProgress,
        payload,
        image,
        fromPage: !sourceId,
      });
      console.debug(`[AniManga Tracker] saved at ${ms()}`);
      show(result, context);
    } finally {
      reading.delete(url);
    }
  }

  function check() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onPage(lastUrl);
  }

  chrome.storage.local.get('sites', ({ sites }) => {
    types = MTRules.build(sites || {});
    check();
    setInterval(check, 700);
  });
})();
