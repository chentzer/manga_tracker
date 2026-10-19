// Settings → Dark mode: the white screens (Library, Notepad, Settings,
// the Browser tab, sheets and pop-ups) turn dark. The header, tab row and
// coloured buttons are already dark and stay as they are.
//
// Each file keeps its light styles as written, wrapped in themed(): while
// Dark mode is on, a style's background, text and border colours are
// swapped for their dark ones below (a colour not listed stays — the
// accent reds, blues and button colours). Colours written in JSX go
// through themeColor(). Components that show themed styles call
// useDarkMode(), so they redraw when it's switched.

import { useSyncExternalStore } from 'react';
import { getSetting, setSetting } from './db';

let dark = null;
const listeners = new Set();

export function isDarkMode() {
  if (dark === null) {
    try {
      dark = getSetting('darkMode', '0') === '1';
    } catch (e) {
      return false; // the database isn't open yet (the lock screen)
    }
  }
  return dark;
}

export function setDarkMode(on) {
  dark = !!on;
  setSetting('darkMode', on ? '1' : '0');
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDarkMode() {
  return useSyncExternalStore(subscribe, isDarkMode);
}

// Light colour → dark colour, by what it colours.
const SURFACE = '#1c1c2b'; // pages, cards, sheets
const RAISED = '#26263a'; // bars, inputs, chips
const LINE = '#34344a';
const BACKGROUNDS = {
  '#fff': SURFACE,
  '#ffffff': SURFACE,
  '#fafafa': SURFACE,
  '#f9f9f9': SURFACE,
  '#f6f7fb': RAISED,
  '#f5f5f5': RAISED,
  '#f4f4f4': RAISED,
  '#f2f3f7': RAISED,
  '#f2f2f2': RAISED,
  '#f0f0f0': RAISED,
  '#eef1f8': RAISED,
  '#eef0f5': RAISED,
  '#e8edf5': RAISED,
  '#eee': '#2e2e44',
  '#eeeeee': '#2e2e44',
  '#e0e0e0': '#34344a',
  '#ddd': '#34344a',
  '#ccc': '#44445a',
  '#fde2e2': '#4a2026', // light red
  '#fdecea': '#4a2026',
  '#fff3cd': '#4a3b12', // light yellow / orange
  '#fff4e5': '#4a3b12',
  '#fdf2d8': '#4a3b12',
  '#fdf6e3': '#4a3b12',
  '#e3ecfa': RAISED, // light blue
  '#e8f5e9': '#1f3b25', // light green
};
const TEXTS = {
  '#000': '#f0f0f5',
  '#000000': '#f0f0f5',
  '#111': '#ececf1',
  '#222': '#ececf1',
  '#333': '#e2e2ea',
  '#444': '#c8c8d4',
  '#555': '#b8b8c6',
  '#666': '#a8a8b8',
  '#777': '#9a9aac',
  '#888': '#8e8ea0',
  '#999': '#80809a',
  '#aaa': '#74748c',
  '#0f3460': '#8fb3ff', // navy text
  '#16213e': '#c9d4ff',
  '#1a73e8': '#6ea8ff',
  '#c0392b': '#ff7468', // red text (Delete, errors)
  '#7a4b00': '#ffd479', // text on the yellow banners
  '#664d03': '#ffd479',
  '#4a5578': '#b8c2e0',
};
const BORDERS = {
  '#eee': LINE,
  '#eeeeee': LINE,
  '#e0e0e0': LINE,
  '#ddd': LINE,
  '#ccc': '#44445a',
  '#bbb': '#4e4e66',
  '#f0d9a8': '#6b5520',
  '#0f3460': '#8fb3ff', // navy outlines (Edit button)
};
const BY_PROP = {
  backgroundColor: BACKGROUNDS,
  color: TEXTS,
  borderColor: BORDERS,
  borderTopColor: BORDERS,
  borderBottomColor: BORDERS,
  borderLeftColor: BORDERS,
  borderRightColor: BORDERS,
};

// Text with no colour of its own is drawn black by Android — unreadable
// on the dark screens — so a text style (one with font settings) or a
// text box's style (input, address, …) gets the light text colour.
const TEXT_BOX = /input|address|textbox/i;
const FONT_PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'fontFamily', 'fontStyle'];

function darkStyle(name, style) {
  const out = {};
  Object.entries(style).forEach(([prop, value]) => {
    const map = BY_PROP[prop];
    const swapped = map && typeof value === 'string' ? map[value.toLowerCase()] : undefined;
    out[prop] = swapped || value;
  });
  if (!('color' in style) && (TEXT_BOX.test(name) || FONT_PROPS.some((p) => p in style))) {
    out.color = TEXTS['#333'];
  }
  return out;
}

// A file's StyleSheet, read in the current mode: styles.x is the light
// style, or its dark version while Dark mode is on.
export function themed(styles) {
  const darkStyles = {};
  // An empty target: the styles object may be frozen, and a proxy may not
  // answer differently for a frozen object's own properties.
  return new Proxy({}, {
    get(target, name) {
      const style = styles[name];
      if (!isDarkMode() || !style || typeof style !== 'object') return style;
      if (!(name in darkStyles)) darkStyles[name] = darkStyle(String(name), style);
      return darkStyles[name];
    },
  });
}

// A colour written in JSX (placeholderTextColor, an inline style).
// kind: 'text' (default), 'background' or 'border'.
export function themeColor(color, kind = 'text') {
  if (!isDarkMode() || typeof color !== 'string') return color;
  const map = kind === 'background' ? BACKGROUNDS : kind === 'border' ? BORDERS : TEXTS;
  return map[color.toLowerCase()] || color;
}
