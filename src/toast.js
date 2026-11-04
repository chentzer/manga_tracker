// Short messages that go away by themselves, shown as a Material snackbar
// (Snackbar.js). Two lines at most, so keep them short: say what happened and
// no more. Anything longer is cut with "…"; use a dialog if it must be read.
const SHORT_MS = 4000;
const LONG_MS = 7000;

let current = null;
let timer = null;
const listeners = new Set();

function changed() {
  listeners.forEach((l) => l(current));
}

// long: leaves it up longer, for something you need to act on.
export function showToast(message, long = false) {
  clearTimeout(timer);
  current = message;
  changed();
  timer = setTimeout(() => {
    current = null;
    changed();
  }, long ? LONG_MS : SHORT_MS);
}

export function currentToast() {
  return current;
}

export function onToast(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
