// Settings → Dark mode: every screen and bar turns dark. Coral and the other
// status colours stay; a filled button or chosen chip turns a mid grey.
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

// Light colour → dark colour, by what it colours. True neutrals, one tone
// step apart, so the covers and the coral are the only colour on screen.
const SURFACE = '#121212'; // pages, cards, sheets
const RAISED = '#1e1e1e'; // bars, inputs, chips
const LINE = '#333333';
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
  '#e3ecfa': RAISED, // light blue
  '#eee': '#2a2a2a',
  '#eeeeee': '#2a2a2a',
  '#ececec': '#2c2c2c', // a selected card
  '#e0e0e0': LINE,
  '#ddd': LINE,
  '#ccc': '#444444',
  '#1d1f20': '#5a5a5a', // filled buttons and chosen chips, white text on them
  '#fde2e2': '#4a2026', // light red
  '#fdecea': '#4a2026',
  '#fff3cd': '#4a3b12', // light yellow / orange
  '#fff4e5': '#4a3b12',
  '#fdf2d8': '#4a3b12',
  '#fdf6e3': '#4a3b12',
  '#e8f5e9': '#1f3b25', // light green
};
const TEXTS = {
  '#000': '#ececec',
  '#000000': '#ececec',
  '#111': '#ececec',
  '#222': '#ececec',
  '#333': '#e2e2e2',
  '#444': '#c8c8c8',
  '#555': '#b8b8b8',
  '#666': '#a8a8a8',
  '#777': '#9e9e9e',
  '#888': '#9e9e9e',
  '#999': '#9e9e9e',
  '#aaa': '#a8a8a8',
  '#1d1f20': '#ececec', // ink text
  '#1a73e8': '#6ea8ff',
  '#c0392b': '#ff7468', // red text (Delete, errors)
  '#b26a00': '#f5a623', // scores and favourite stars
  '#c2184b': '#ff7a93', // the active tab, the Favourite label
  '#b3261e': '#ff8a80', // the Super Want label
  '#7a4b00': '#ffd479', // text on the yellow banners
  '#664d03': '#ffd479',
  '#4a5578': '#b8b8b8',
};
const BORDERS = {
  '#eee': LINE,
  '#eeeeee': LINE,
  '#e0e0e0': LINE,
  '#ddd': LINE,
  '#ccc': '#444444',
  '#bbb': '#555555',
  '#f0d9a8': '#6b5520',
  '#1d1f20': '#aaaaaa', // ink outlines (Edit button)
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
