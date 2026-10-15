// Some actions (native permission dialogs, system pickers) briefly make
// the app register as "inactive"/"background" in React Native's
// AppState, even though nothing actually left the app and no one else
// could have picked up the phone in that moment. AppLock's re-lock-on-
// resume logic can't tell that apart from a genuine backgrounding, so
// this lets specific actions (like saving an image, which triggers a
// permission prompt) mark themselves as "don't treat what's about to
// happen as leaving the app."
let suppressUntil = 0;

// Call right before an action that might cause a brief, benign AppState
// transition. Defaults to a 5 second window, which comfortably covers a
// permission dialog or system picker without accidentally suppressing a
// real backgrounding that happens to follow shortly after.
export function suppressNextRelock(durationMs = 5000) {
  suppressUntil = Date.now() + durationMs;
}

export function isRelockSuppressed() {
  return Date.now() < suppressUntil;
}
