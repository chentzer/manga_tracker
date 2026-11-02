// The first-launch tour: steps through the app on its real screens, each
// step dimming everything but one control (a spotlight) with a short card
// under or over it — "3 of 18", Back, Skip and Next. It runs once (the
// `tourDone` setting) and Settings → App → Show the tour plays it again.
//
// Controls take part by key: `ref={tourTarget('library.random')}` on the
// control wherever it's drawn (App.js, MediaWebView.js, EntryList.js,
// BrowserTab.js, Notepad.js). A step names its target and, if needed, the
// tab to show first (App.js switches to it). A step whose control isn't on
// screen (turned off in Settings, or a site list with one site) is skipped
// when it's marked optional; otherwise its card shows in the middle.
//
// When a tab, button or feature is added, moved or removed, update
// tourSteps() below in the same change.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const targets = new Map();

// A ref for a control the tour can point at. The same key from several
// places (e.g. one per site tab) is fine as long as each is unique.
export function tourTarget(key) {
  return (ref) => {
    if (ref) targets.set(key, ref);
    else if (targets.get(key)) targets.delete(key);
  };
}

// The control's place in the window, or null when it isn't on screen.
function measure(key) {
  return new Promise((resolve) => {
    const ref = targets.get(key);
    const host = ref && (ref.measureInWindow ? ref : ref.getNativeScrollRef ? ref.getNativeScrollRef() : null);
    if (!host || !host.measureInWindow) {
      resolve(null);
      return;
    }
    host.measureInWindow((x, y, w, h) => resolve(w > 0 && h > 0 ? { x, y, w, h } : null));
  });
}

// The steps, in order. siteTab: the first Browse tab; siteTabs: all of
// them ({ key, label }), for the per-tab notes.
export function tourSteps({ siteTab, siteTabs }) {
  const anime = siteTabs.find((t) => t.key === 'anime');
  return [
    {
      text: 'Welcome to AniManga Tracker. Manga, manhwa and anime you open in its tabs are saved to your Library by themselves — this tour shows where everything is.',
    },
    { tab: siteTab, target: 'bottom.browse', text: 'Browse holds your reading and watching sites.' },
    { tab: siteTab, target: 'siteTabs', text: `Switch between ${siteTabs.map((t) => t.label).join(', ')} here. Each keeps its own page.` },
    { tab: siteTab, target: `site.${siteTab}.menu`, optional: true, text: 'This list switches between the tab’s sites.' },
    {
      tab: siteTab,
      target: `site.${siteTab}.search`,
      optional: true,
      text: 'Search a title here. Next › then tries the same title on the tab’s other sites.',
    },
    {
      tab: siteTab,
      target: `page.${siteTab}`,
      text: 'Open a title and it’s saved, with the chapter you’re on. View in Library then jumps to it.',
    },
    {
      tab: siteTab,
      target: `page.${siteTab}`,
      text: 'Hold a picture to save it, pull down at the top to reload, and pull up at the bottom of a page to open the Library.',
    },
    {
      tab: siteTab,
      target: 'header.title',
      text: 'The bars hide while you read. Tap the app name, or pull down at the top of the page, to bring them back.',
    },
    ...(anime
      ? [
          {
            tab: siteTab,
            target: `siteTab.${anime.key}`,
            text: 'On Anime, double-tap the left or right side of a video to skip back or forward. The screen stays on while it plays.',
          },
        ]
      : []),
    { tab: 'library', target: 'bottom.library', text: 'The Library lists everything you’ve opened, with progress, scores and notes.' },
    {
      tab: 'library',
      target: 'library.types',
      text: 'Show one kind at a time. Titles, Artists and Groups then give different views of it.',
    },
    {
      tab: 'library',
      target: 'library.filters',
      optional: true,
      text: 'Filters: sort (last updated first), status, score, favourites, tags and artist.',
    },
    { tab: 'library', target: 'library.random', text: 'Random picks something to read or watch next.' },
    {
      tab: 'library',
      target: 'library.list',
      text: 'Tap a title for its details and Continue. Hold one to select several, and pull down to sync.',
    },
    { tab: 'browser', target: 'bottom.browser', text: 'Browser opens any website. Nothing here is saved to the Library.' },
    { tab: 'browser', target: 'browser.address', optional: true, text: 'Type an address, or words to search the web.' },
    { tab: 'notepad', target: 'bottom.notepad', text: 'The Notepad keeps quick lists. Text shared from other apps lands in its Inbox.' },
    {
      tab: 'notepad',
      target: 'notepad.notes',
      text: 'Your notes. A category note’s magnifier searches that tab for an item.',
    },
    { target: 'header.sync', optional: true, text: 'This shows Google Drive backup and sync, with how far it has got. Tap it while it runs for the details.' },
    {
      target: 'header.settings',
      text: 'Settings: Google Drive backup, MyAnimeList import and export, your own Sites, App lock, Block ads, Data saver — and this tour again.',
    },
  ];
}

const PAD = 6;
const GAP = 12;

export default function Tour({ steps, visible, onShowTab, onClose }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const [measured, setMeasured] = useState(false);
  const [frame, setFrame] = useState(null); // the overlay's own place in the window
  const [cardHeight, setCardHeight] = useState(0);
  const overlayRef = useRef(null);
  const direction = useRef(1);

  useEffect(() => {
    if (visible) {
      direction.current = 1;
      setIndex(0);
    }
  }, [visible]);

  const step = visible ? steps[index] : null;

  // Shows the step's tab, then finds its control (tabs take a moment to
  // draw). A missing optional control skips the step.
  useEffect(() => {
    if (!step) return undefined;
    let cancelled = false;
    setMeasured(false);
    setRect(null);
    if (step.tab) onShowTab(step.tab);
    AccessibilityInfo.announceForAccessibility?.(step.text);
    if (!step.target) {
      setMeasured(true);
      return undefined;
    }
    let tries = 0;
    const attempt = async () => {
      const found = await measure(step.target);
      if (cancelled) return;
      if (found) {
        setRect(found);
        setMeasured(true);
      } else if (++tries < 8) {
        setTimeout(attempt, 150);
      } else if (step.optional) {
        const next = index + direction.current;
        if (next >= 0 && next < steps.length) setIndex(next);
        else onClose();
      } else {
        setMeasured(true);
      }
    };
    const timer = setTimeout(attempt, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, index, steps.length, onShowTab, onClose]);

  const go = useCallback(
    (delta) => {
      direction.current = delta;
      const next = index + delta;
      if (next < 0) return;
      if (next >= steps.length) onClose();
      else setIndex(next);
    },
    [index, steps.length, onClose]
  );

  // Android's back button steps back (or closes on the first step).
  useEffect(() => {
    if (!visible) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (index > 0) go(-1);
      else onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, index, go, onClose]);

  if (!step) return null;

  const width = frame ? frame.w : 0;
  const height = frame ? frame.h : 0;
  const hole =
    rect && frame
      ? {
          left: Math.max(0, rect.x - frame.x - PAD),
          top: Math.max(0, rect.y - frame.y - PAD),
          right: Math.min(width, rect.x - frame.x + rect.w + PAD),
          bottom: Math.min(height, rect.y - frame.y + rect.h + PAD),
        }
      : null;

  // The card goes under the control if it fits, else over it, else in
  // the middle (a control taller than the screen allows).
  let cardTop = Math.max(GAP, (height - cardHeight) / 2);
  let pointer = null; // 'up' (card under the control) or 'down' (over it)
  if (hole) {
    if (hole.bottom + GAP + cardHeight <= height - GAP) {
      cardTop = hole.bottom + GAP;
      pointer = 'up';
    } else if (hole.top - GAP - cardHeight >= GAP) {
      cardTop = hole.top - GAP - cardHeight;
      pointer = 'down';
    }
  }
  // The pointer sits under the control's middle, kept on the card.
  const pointerLeft = hole ? Math.min(width - 16 - 28, Math.max(16 + 14, (hole.left + hole.right) / 2 - 8)) : 0;
  const last = index === steps.length - 1;

  return (
    <View
      ref={overlayRef}
      style={StyleSheet.absoluteFill}
      onLayout={() =>
        overlayRef.current?.measureInWindow((x, y, w, h) => setFrame({ x, y, w, h }))
      }
      accessibilityViewIsModal
    >
      {hole ? (
        <>
          <View style={[styles.dim, { left: 0, top: 0, width, height: hole.top }]} />
          <View style={[styles.dim, { left: 0, top: hole.bottom, width, height: height - hole.bottom }]} />
          <View style={[styles.dim, { left: 0, top: hole.top, width: hole.left, height: hole.bottom - hole.top }]} />
          <View
            style={[
              styles.dim,
              { left: hole.right, top: hole.top, width: width - hole.right, height: hole.bottom - hole.top },
            ]}
          />
          {/* The spotlight: outlined, and holding taps so the tour stays in charge. */}
          <View
            style={[
              styles.ring,
              { left: hole.left, top: hole.top, width: hole.right - hole.left, height: hole.bottom - hole.top },
            ]}
          />
        </>
      ) : (
        <View style={[styles.dim, StyleSheet.absoluteFill]} />
      )}
      {frame && measured ? (
        <View
          style={[styles.card, { top: cardTop }]}
          onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
        >
          {pointer ? (
            <View
              style={[
                styles.pointer,
                { left: pointerLeft - 16 },
                pointer === 'up' ? { top: -8 } : { bottom: -8, transform: [{ rotate: '225deg' }] },
              ]}
            />
          ) : null}
          <Text style={styles.progress}>
            {index + 1} of {steps.length}
          </Text>
          <Text style={styles.text}>{step.text}</Text>
          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.button, styles.quiet]}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Skip the tour"
            >
              <Text style={styles.quietText}>Skip</Text>
            </TouchableOpacity>
            <View style={styles.spacer} />
            {index > 0 ? (
              <TouchableOpacity style={[styles.button, styles.quiet]} onPress={() => go(-1)} accessibilityRole="button">
                <Text style={styles.quietText}>Back</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={[styles.button, styles.primary]} onPress={() => go(1)} accessibilityRole="button">
              <Text style={styles.primaryText}>{last ? 'Done' : 'Next'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { position: 'absolute', backgroundColor: 'rgba(5, 8, 20, 0.78)' },
  ring: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: '#ffd166',
    borderRadius: 10,
  },
  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: '#16213e',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2c3a66',
    shadowColor: '#000000',
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  // A small turned square peeking out of the card's edge, towards the control.
  pointer: {
    position: 'absolute',
    width: 16,
    height: 16,
    backgroundColor: '#16213e',
    borderColor: '#2c3a66',
    borderLeftWidth: 1,
    borderTopWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  progress: { color: '#c8c8d8', fontSize: 13, marginBottom: 6 },
  text: { color: '#ffffff', fontSize: 16, lineHeight: 22 },
  buttons: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 14, gap: 8 },
  spacer: { flex: 1 },
  button: { minHeight: 48, minWidth: 64, paddingHorizontal: 16, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  primary: { backgroundColor: '#c62f4c' },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  quiet: { backgroundColor: 'transparent' },
  quietText: { color: '#e0e0ee', fontSize: 15, fontWeight: '600' },
});
