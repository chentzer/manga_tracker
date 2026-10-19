import { getSetting, setSetting } from './db';

// How long the browsing tabs' chapter questions stay quiet after you
// snooze one (MediaWebView.js): "Just looking" on "Start rereading?",
// "Keep N" on "Ahead of your record" (that title only) and "Snooze" on
// "Volumes read not updated". Settings → Library → Snooze chapter
// questions; 1 hour unless changed.
export const SNOOZE_CHOICES = [
  { minutes: 15, label: '15 minutes', short: '15 min' },
  { minutes: 60, label: '1 hour', short: '1 hour' },
  { minutes: 6 * 60, label: '6 hours', short: '6 hours' },
  { minutes: 24 * 60, label: '1 day', short: '1 day' },
  { minutes: 7 * 24 * 60, label: '1 week', short: '1 week' },
];

const DEFAULT_MINUTES = 60;

export function snoozeMinutes() {
  const minutes = Number(getSetting('chapterSnoozeMinutes', String(DEFAULT_MINUTES)));
  return SNOOZE_CHOICES.some((c) => c.minutes === minutes) ? minutes : DEFAULT_MINUTES;
}

export function setSnoozeMinutes(minutes) {
  setSetting('chapterSnoozeMinutes', String(minutes));
}

// When a snooze started now ends (ms since 1970), and its length in words.
export const snoozeUntil = () => Date.now() + snoozeMinutes() * 60 * 1000;
export const snoozeLabel = () => SNOOZE_CHOICES.find((c) => c.minutes === snoozeMinutes()).label;
