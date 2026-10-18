// The toolbar popup: the entry for the page you're on, with its status,
// score and progress to change (saved to Drive like the app's detail
// sheet; the app picks it up on its next sync).
/* global chrome */

const main = document.getElementById('main');
document.getElementById('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

const send = (message) => chrome.runtime.sendMessage(message);

const STATUSES = (anime) => [
  ['reading', anime ? 'Watching' : 'Reading'],
  ['read', anime ? 'Watched' : 'Read'],
  ['on_hold', 'On Hold'],
  ['dropped', 'Dropped'],
  ['want_to_read', anime ? 'Want to Watch' : 'Want to Read'],
];
const SCORES = [
  ['', '—'],
  ['10', '10 Masterpiece'],
  ['9', '9 Great'],
  ['8', '8 Very Good'],
  ['7', '7 Good'],
  ['6', '6 Fine'],
  ['5', '5 Average'],
  ['4', '4 Bad'],
  ['3', '3 Very Bad'],
  ['2', '2 Horrible'],
  ['1', '1 Appalling'],
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => node.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return node;
}

function message(text, button) {
  main.replaceChildren(el('p', { class: 'hint' }, text), ...(button ? [button] : []));
}

function select(options, value) {
  const s = el('select');
  options.forEach(([v, label]) => {
    const o = el('option', { value: v }, label);
    if (String(value || '') === v) o.selected = true;
    s.append(o);
  });
  return s;
}

function render(where, entry) {
  const anime = where.mediaType === 'anime';
  const unit = anime ? 'Episodes' : 'Chapters';
  const repeating = entry.read_status === 'read' && entry.repeating === '1';
  const status = select(STATUSES(anime), entry.read_status);
  const score = select(SCORES, entry.score);
  const progress = el('input', { type: 'number', min: '0', value: entry.progress || '0' });
  const repeat = el('input', { type: 'checkbox' });
  repeat.checked = repeating;
  const repeatProgress = el('input', { type: 'number', min: '0', value: entry.repeat_progress || '0' });
  const saved = el('span', { class: 'saved' });

  const save = async () => {
    saved.textContent = 'Saving…';
    const fields = {
      read_status: status.value,
      score: score.value || null,
      progress: progress.value,
      repeating: repeat.checked ? 1 : 0,
      repeat_progress: repeat.checked ? repeatProgress.value : 0,
    };
    const result = await send({ type: 'edit', mediaType: where.mediaType, sourceId: where.sourceId, fields });
    saved.textContent = result && result.error ? `Not saved: ${result.error}` : 'Saved — syncing to Drive';
  };

  const total = entry.total ? ` / ${entry.total}` : '';
  main.replaceChildren(
    el('h1', {}, entry.title || entry.source_id),
    entry.alt_title ? el('p', { class: 'alt' }, entry.alt_title) : '',
    el('p', { class: 'meta' }, `${where.mediaType} · ${entry.source_id}`),
    el('label', {}, 'Status', status),
    el('label', {}, 'Score', score),
    el('label', {}, `${unit}${total}`, progress),
    el('label', { class: 'check' }, repeat, anime ? 'Rewatching' : 'Rereading'),
    el('label', {}, anime ? 'Rewatch: episodes so far' : 'Reread: chapters so far', repeatProgress),
    el('div', { class: 'actions' }, saved, el('button', { onclick: save }, 'Save')),
    entry.mal_id
      ? el(
          'a',
          { class: 'link', href: `https://myanimelist.net/${anime ? 'anime' : 'manga'}/${entry.mal_id}`, target: '_blank' },
          'Open on MyAnimeList'
        )
      : ''
  );
}

// Changes saved here but not in Drive yet (written in the background,
// retried if that fails).
function syncNote(sync) {
  if (!sync || !sync.waiting) return null;
  const note = el(
    'p',
    { class: sync.error ? 'note warn' : 'note' },
    `${sync.waiting} change${sync.waiting === 1 ? '' : 's'} waiting to sync to Drive${sync.error ? ` — ${sync.error}. Retrying.` : '.'} `
  );
  const button = el('button', { class: 'plain small' }, 'Sync now');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Syncing…';
    const r = await send({ type: 'syncNow' });
    note.replaceWith(syncNote(r) || el('p', { class: 'note' }, 'All synced to Drive.'));
  });
  note.append(button);
  return note;
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await send({ type: 'tabEntry', tabId: tab && tab.id });
  const note = syncNote(result.sync);
  if (note) document.body.insertBefore(note, main);
  if (!result.connected) {
    message(
      'Not connected to Google Drive.',
      el('button', { onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings')
    );
  } else if (result.error) {
    message(`Couldn't read your library: ${result.error}`);
  } else if (!result.where) {
    message('Open a title on one of your sites and it shows here.');
  } else if (!result.entry) {
    message('This title isn’t in your library yet.');
  } else {
    render(result.where, result.entry);
  }
})();
