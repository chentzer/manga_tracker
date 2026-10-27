import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

// Undo instead of "Are you sure?" (Shneiderman: easy reversal). A delete
// hides the thing straight away and offers Undo in a bar at the bottom
// (UndoBar.js) for UNDO_MS; only then is it really deleted (commit).
// Undo puts it back (undo). A newer offer commits the one before it, and
// so does the app going to the background, so a delete is never lost
// halfway — if the app is killed inside those seconds, nothing was
// deleted.

const UNDO_MS = 5000;
let pending = null; // { message, commit, undo, timer }
const listeners = new Set();

function changed() {
  listeners.forEach((l) => l(pending ? pending.message : null));
}

function finish(run) {
  const p = pending;
  if (!p) return;
  clearTimeout(p.timer);
  pending = null;
  changed();
  try {
    run(p);
  } catch (e) {}
}

export function commitPending() {
  finish((p) => p.commit());
}

// message: what the bar says ("Entry deleted"). commit: really delete.
// undo: show it again.
export function offerUndo({ message, commit, undo }) {
  commitPending();
  pending = { message, commit, undo, timer: setTimeout(commitPending, UNDO_MS) };
  changed();
}

export function undoPending() {
  finish((p) => p.undo());
}

AppState.addEventListener('change', (state) => {
  if (state !== 'active') commitPending();
});

// The message of the offer being shown, or null.
export function useUndoMessage() {
  const [message, setMessage] = useState(pending ? pending.message : null);
  useEffect(() => {
    listeners.add(setMessage);
    return () => listeners.delete(setMessage);
  }, []);
  return message;
}
