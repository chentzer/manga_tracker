import React, { forwardRef, useImperativeHandle, useRef, useCallback, useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Text,
  Modal,
  ScrollView,
  Alert,
  Platform,
  ToastAndroid,
  Keyboard,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
// SDK 57: saveToLibraryAsync only works from the legacy entry point.
import * as MediaLibrary from 'expo-media-library/legacy';
import {
  getEntry,
  getEntryByMalId,
  insertEntry,
  adoptImportedEntry,
  setMalId,
  updateEntryFields,
  getSetting,
  setSetting,
  markSynced,
  markSyncFailed,
  fillMissingEntryFields,
} from './db';
import { isImportedSourceId, refreshFromAniList, findImportedByTitle, isAdultTitle } from './malList';
import { todayString } from './malFormat';
import { uploadImageToDrive, buildDriveDisplayName } from './GoogleDriveService';
import { maybeBackupLibraryToDrive } from './backup';
import { suppressNextRelock } from './relockGuard';
import { snoozeUntil, snoozeLabel } from './snooze';
import RatePrompt from './RatePrompt';
import { TAB_BAR_WATCH_JS } from './tabBarWatch';
import { IMAGE_HOLD_JS, saveHeldPicture as saveHeldPictureToGallery } from './imageHold';
import { driveSyncAllowed, markDriveSyncDeferred } from './dataSaver';
import { AD_BLOCK_JS, isAdUrl } from './adBlock';
import { galleryFolderFor, safeFileName } from './gallery';
import { TAP_SLOP } from './touch';
import { themed, themeColor, useDarkMode } from './theme';

// Asks the page for what a screenshot's file name needs (App.js →
// getScreenshotInfo): its URL, the page title, and the current position
// of the video being watched — the one that's playing, or else the
// largest one on the page. Only sees videos in the page itself; a player
// embedded from another site (an iframe) reports no position, and the
// name just leaves it out.
function buildScreenshotInfoJs(requestId) {
  return `
    (function() {
      var vids = document.querySelectorAll('video');
      var video = null;
      for (var i = 0; i < vids.length; i++) {
        if (!vids[i].paused && !vids[i].ended) { video = vids[i]; break; }
      }
      if (!video) {
        var bestArea = 0;
        for (var j = 0; j < vids.length; j++) {
          var r = vids[j].getBoundingClientRect();
          if (r.width * r.height > bestArea) { bestArea = r.width * r.height; video = vids[j]; }
        }
      }
      var ogTitle = document.querySelector('meta[property="og:title"]');
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'screenshotInfo',
        requestId: ${JSON.stringify(requestId)},
        url: location.href,
        title: (ogTitle && ogTitle.content) || document.title || null,
        currentTime: video && isFinite(video.currentTime) ? video.currentTime : null,
      }));
    })();
    true;
  `;
}

// Pauses every video/audio on the page, including inside same-site
// frames (players hosted on another site can't be reached from here).
export const PAUSE_MEDIA_JS = `
  (function () {
    function pauseIn(doc) {
      try {
        var media = doc.querySelectorAll('video, audio');
        for (var i = 0; i < media.length; i++) {
          try { media[i].pause(); } catch (e) {}
        }
        var frames = doc.querySelectorAll('iframe');
        for (var j = 0; j < frames.length; j++) {
          try { if (frames[j].contentDocument) pauseIn(frames[j].contentDocument); } catch (e) {}
        }
      } catch (e) {}
    }
    pauseIn(document);
  })();
  true;
`;

// Which optional controls to show (Settings → Buttons). Each also needs
// the type to support it: several sites for the site list, savePageImage
// in mediaTypes.js.
const ALL_BUTTONS = { searchBox: true, siteMenu: true, savePageImage: true };

// Finds the largest image currently rendered on the page — for a manga
// reader this is almost always the actual page being read, not a logo
// or icon. Distinct from extractMetadataJs (which targets the cover via
// og:image) since this is about whatever's on screen right now.
const GRAB_LARGEST_IMAGE_JS = `
  (function() {
    var imgs = document.querySelectorAll('img');
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      var area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'pageImage',
      imageUrl: best ? best.src : null,
    }));
  })();
  true;
`;

// Grabs the current page's rendered HTML so it can be inspected directly
// from the phone — useful when PC-based inspection (or emulation) can't
// reproduce something that only shows up on the real mobile page/app.
// Truncated to a reasonable size since the debug modal isn't meant for
// huge dumps. Hidden behind the showDebugTools setting since it's a
// troubleshooting tool, not something needed in everyday use.
const GRAB_PAGE_HTML_JS = `
  (function() {
    var html = document.documentElement.outerHTML || '';
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'pageHtml',
      html: html.length > 20000 ? html.slice(0, 20000) + '\\n\\n...[truncated]' : html,
    }));
  })();
  true;
`;

// Whether the entry's saved cover file is really on the phone.
async function hasCoverFile(entry) {
  if (!entry.local_image_path) return false;
  try {
    return (await FileSystem.getInfoAsync(entry.local_image_path)).exists;
  } catch {
    return false;
  }
}

// What an entry already in the Library is missing that its page can give
// (MediaWebView reads the page again for it): its cover, title or author.
// An alt title is filled too if the page has one, but isn't a reason on
// its own, since most pages don't.
async function missingDetails(entry) {
  const empty = (v) => v === null || v === undefined || String(v).trim() === '';
  const missing = [];
  if (!(await hasCoverFile(entry))) missing.push('cover');
  if (empty(entry.title)) missing.push('title');
  if (empty(entry.author)) missing.push('author');
  return missing;
}

async function downloadImageLocally(imageUrl, mediaType, sourceId, refererUrl) {
  const dir = `${FileSystem.documentDirectory}${mediaType}-covers/`;
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  const localPath = `${dir}${sourceId}.jpg`;
  // Many CDNs (e.g. signed/token-based image URLs) reject direct downloads
  // that don't carry a Referer matching the page the image was linked
  // from — this is standard hotlink protection. Without it, the download
  // fails with a 403 and (previously) silently blocked the whole entry
  // from being saved.
  const result = await FileSystem.downloadAsync(imageUrl, localPath, {
    headers: refererUrl ? { Referer: refererUrl } : undefined,
  });
  return result.uri;
}

// Double-tap the left half of a <video> to rewind, right half to fast-
// forward — YouTube-style, since most players' own controls aren't
// designed for touch-friendly seeking. Opt-in per media type via
// `doubleTapSeekSeconds` in mediaTypes.js (a number, or omit/0 to
// disable) — harmless to include on a type with no <video> element
// (manga pages), since there'd just be nothing for a click to land on.
//
// The site's player must not see a double tap as well: it would show
// its controls (or run its own double-tap seek) on top of ours. So a tap over a <video> is held back, listening on
// window in the capturing phase (this runs before the page's own
// scripts, so it's first): pointerdown and touchstart go through, but
// the tap's ending (pointerup, touchend and the mouse/click events the
// browser makes from it) waits up to DOUBLE_TAP_MS. A second tap in
// that time seeks: the first tap is cancelled for the player
// (pointercancel / touchcancel) and the second one never reaches it.
// Otherwise the held events are sent on to where they were going,
// unchanged, so a single tap still shows the controls, just 300 ms
// later. A drag (the seek bar, scrolling), a long press, a second
// finger and taps on a link (video previews on list pages) aren't held.
//
// The player's own "dblclick" handler (commonly for toggling
// fullscreen) is blocked too,
// for the same "landed over a video" area.
function buildDoubleTapSeekJs(seconds) {
  return `
    (function() {
      if (window.__mangaTrackerSeekInstalled) return;
      window.__mangaTrackerSeekInstalled = true;

      var DOUBLE_TAP_MS = 300;
      var SEEK_SECONDS = ${seconds};
      var replayed = new WeakSet(); // events this script sent itself
      var tap = null; // the tap being held: { x, y, start, target, pointerId, pointerType, touch, held, ended }
      var timer = null; // after a held tap ends: sends it on unless a second tap comes
      var swallowing = false; // the second tap of a double tap: hidden from the page

      // Finds whichever <video> the tap actually landed within,
      // even if its real target was an overlay/controls element
      // layered on top of it rather than the <video> itself.
      function findVideoUnderPoint(x, y) {
        var videos = document.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) {
          var rect = videos[i].getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return videos[i];
          }
        }
        return null;
      }

      function seek(video, x) {
        var rect = video.getBoundingClientRect();
        var duration = video.duration || Infinity;
        if (x - rect.left < rect.width / 2) {
          video.currentTime = Math.max(0, video.currentTime - SEEK_SECONDS);
        } else {
          video.currentTime = Math.min(duration, video.currentTime + SEEK_SECONDS);
        }
      }

      function send(target, e) {
        replayed.add(e);
        try { target.dispatchEvent(e); } catch (err) {}
      }

      // A copy of a held event (an event can't be sent twice).
      function copyOf(e) {
        var init = {};
        for (var k in e) init[k] = e[k];
        ['touches', 'targetTouches', 'changedTouches'].forEach(function(k) {
          if (e[k]) init[k] = Array.prototype.slice.call(e[k]);
        });
        return new e.constructor(e.type, init);
      }

      // Sends the held tap on, as it was.
      function release() {
        clearTimeout(timer);
        timer = null;
        var t = tap;
        tap = null;
        if (!t) return;
        t.held.forEach(function(e) {
          try { send(e.target, copyOf(e)); } catch (err) {}
        });
      }

      // The player saw the first tap start; tell it the tap was called off.
      function cancel(t) {
        try {
          send(t.target, new PointerEvent('pointercancel', {
            bubbles: true, pointerId: t.pointerId, pointerType: t.pointerType, isPrimary: true
          }));
        } catch (err) {}
        if (t.touch) {
          try {
            send(t.target, new TouchEvent('touchcancel', {
              bubbles: true, touches: [], targetTouches: [], changedTouches: [t.touch]
            }));
          } catch (err) {}
        }
      }

      window.addEventListener('pointerdown', function(e) {
        if (replayed.has(e) || !e.isPrimary) return;
        var video = findVideoUnderPoint(e.clientX, e.clientY);
        if (tap && tap.ended && video) {
          // The second tap: seek, and keep both taps from the player.
          clearTimeout(timer);
          timer = null;
          cancel(tap);
          tap = null;
          swallowing = true;
          e.stopPropagation();
          seek(video, e.clientX);
          return;
        }
        release();
        swallowing = false;
        if (!video || (e.target.closest && e.target.closest('a[href]'))) return;
        tap = {
          x: e.clientX, y: e.clientY, start: Date.now(), target: e.target,
          pointerId: e.pointerId, pointerType: e.pointerType, touch: null, held: [], ended: false
        };
      }, true);

      window.addEventListener('touchstart', function(e) {
        if (replayed.has(e)) return;
        if (swallowing) return e.stopPropagation();
        if (e.touches.length > 1) return release();
        if (tap && !tap.ended && !tap.touch) tap.touch = e.changedTouches[0];
      }, true);

      window.addEventListener('pointermove', function(e) {
        if (replayed.has(e)) return;
        if (swallowing) return e.stopPropagation();
        if (tap && !tap.ended && Math.abs(e.clientX - tap.x) + Math.abs(e.clientY - tap.y) > 10) release();
      }, true);

      window.addEventListener('touchmove', function(e) {
        if (swallowing && !replayed.has(e)) e.stopPropagation();
      }, true);

      ['pointerup', 'touchend', 'mousedown', 'mouseup', 'click'].forEach(function(type) {
        window.addEventListener(type, function(e) {
          if (replayed.has(e)) return;
          if (swallowing) {
            e.stopPropagation();
            // No mouse events or click from it either.
            if (type === 'touchend' && e.cancelable) e.preventDefault();
            if (type === 'click') e.preventDefault();
            return;
          }
          if (!tap) return;
          if (!tap.ended && Date.now() - tap.start > 500) return release(); // a long press
          e.stopPropagation();
          if (type === 'click') e.preventDefault(); // its copy does what it would have
          tap.held.push(e);
          if (type === 'pointerup') {
            tap.ended = true;
            timer = setTimeout(release, DOUBLE_TAP_MS);
          }
        }, true);
      });

      document.addEventListener(
        'dblclick',
        function(e) {
          if (findVideoUnderPoint(e.clientX, e.clientY)) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        true
      );
    })();
    true;
  `;
}

// Runs once when the page first loads. Polls location.href so that
// single-page-app sites — which change the URL via history.pushState
// instead of a full navigation — still get detected, since
// onNavigationStateChange only fires for real page loads.
const URL_WATCHER_JS = `
  (function() {
    if (window.__mangaTrackerWatcherInstalled) return;
    window.__mangaTrackerWatcherInstalled = true;
    var lastHref = location.href;
    setInterval(function() {
      if (location.href !== lastHref) {
        lastHref = location.href;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'urlchange', url: location.href }));
      }
    }, 800);
  })();
  true;
`;

// Some sites show an interstitial ("Continue", age-gate, ad interstitial,
// etc.) that requires a manual click before the real page loads — since
// this happens on a different URL than the final content, our
// URL-pattern matching correctly ignores it, but it means extraction
// can't start until the click actually happens. Rather than waiting on
// the user's timing (which was producing wrong/stale title/thumbnail —
// the page was still mid-transition when extraction ran), this
// auto-clicks any button/link whose visible text exactly matches the
// configured string, the moment it appears. Opt-in per media type/source
// via `autoConfirmButtonText` in mediaTypes.js — most sites don't need
// this.
//
// domainButtonMap maps hostname -> button text, since a multi-source
// type (one spanning several sites) can have a different
// interstitial on some sources and none at all on others — the script
// checks its own location.hostname to pick the right one (or do
// nothing) rather than a single fixed button text for the whole type.
function buildAutoConfirmJs(domainButtonMap) {
  return `
    (function() {
      if (window.__mangaTrackerAutoConfirmInstalled) return;
      window.__mangaTrackerAutoConfirmInstalled = true;

      var map = ${JSON.stringify(domainButtonMap)};
      var host = location.hostname.replace(/^www\\./, '');
      var targetText = null;
      for (var key in map) {
        if (host === key || host.slice(-(key.length + 1)) === ('.' + key)) {
          targetText = map[key];
          break;
        }
      }
      if (!targetText) return;
      targetText = targetText.trim().toLowerCase();

      function tryClick() {
        var candidates = document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]'
        );
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          var text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
          // "Contains" rather than an exact match — the real button
          // text can differ slightly from the configured word (e.g.
          // "Continue Watching" instead of just "Continue"), and an
          // exact-match requirement would silently never click at all
          // in that case.
          if (text && text.indexOf(targetText) !== -1) {
            el.click();
            return true;
          }
        }
        return false;
      }

      // Checked periodically rather than once, since the prompt can
      // appear at any point after load, not necessarily immediately.
      var interval = setInterval(tryClick, 500);
      // Stop checking after a while so this doesn't run forever in the
      // background once dismissed (or if it never appears at all).
      setTimeout(function() { clearInterval(interval); }, 15000);
    })();
    true;
  `;
}

// Extracts the hostname from a URL string without relying on the global
// URL class (not guaranteed available in every JS engine/RN version) —
// a plain regex is simpler and works everywhere.
// Schemes a page may load in place. Anything else (market:, intent:,
// whatsapp:, tg: …) would hand the page to another app, so it's blocked.
const IN_PAGE_SCHEME = /^(https?|about|data|blob):/i;

function getHostname(url) {
  if (!url) return null;
  const match = url.match(/^https?:\/\/([^/]+)/i);
  return match ? match[1].toLowerCase().replace(/^www\./, '') : null;
}

// The sites a tab can switch between with its site list (the ▾ button in
// the search bar): the type's own site and its `extraSources`, or each of
// `sources`. Each has a name, a domain and a home page (the type's
// startUrl for the first site, otherwise the site's front page). Empty
// for one-site tabs.
function getTabSites(config) {
  if (config.sources) {
    return config.sources.map((s, i) => ({
      name: s.name,
      domain: s.domain,
      homeUrl: i === 0 ? config.startUrl : `https://${s.domain}/`,
    }));
  }
  // The tab's own site is named after its siteName or title search's first
  // site, or after the tab when it has neither.
  const mainName = config.siteName || config.titleSearch?.[0]?.name || config.label;
  if (!config.extraSources || !config.extraSources.length) return [];
  return [
    { name: mainName, domain: getHostname(config.startUrl), homeUrl: config.startUrl },
    ...config.extraSources.map((s) => ({ name: s.name, domain: s.domain, homeUrl: `https://${s.domain}/` })),
  ];
}

// 18+ titles you chose not to add (`type:code`), so they aren't asked
// about again on every page until the app restarts.
const declinedAdult = new Set();

// Index into `sites` of the site `url` is on, or -1.
function siteIndexFor(sites, url) {
  const host = getHostname(url);
  if (!host) return -1;
  return sites.findIndex((s) => host === s.domain || host.endsWith(`.${s.domain}`));
}

// A media type is either single-source (manga, anime — url pattern,
// extraction, etc live directly on the config) or multi-source (e.g. otherCategory —
// a `sources` array, one entry per site, since different sites carry
// overlapping-but-not-identical catalogs and need their own extraction
// logic). This normalizes both into the same shape so the rest of the
// component doesn't need to care which kind of type it's dealing with:
// resolves which source (if any) a given URL belongs to, returning
// { source, match } or null.
function resolveSource(config, url) {
  if (config.sources) {
    for (const source of config.sources) {
      const match = url.match(source.urlRegex);
      if (match) return { source, match };
    }
    return null;
  }
  const match = url.match(config.urlRegex);
  if (match) return { source: config, match };
  // A single-site type can also save pages from `extraSources` (e.g. the
  // Manhwa tab's second site), each with its own pattern and script.
  for (const source of config.extraSources || []) {
    const extraMatch = url.match(source.urlRegex);
    if (extraMatch) return { source, match: extraMatch };
  }
  return null;
}

// All domains considered "safe to navigate to" for this type — every
// source's domain for a multi-source type, or just the single
// startUrl's domain otherwise. Used by the external-navigation blocker.
function getAllowedDomains(config) {
  if (config.sources) {
    return config.sources.map((s) => s.domain);
  }
  const host = getHostname(config.startUrl);
  return [...(host ? [host] : []), ...(config.extraSources || []).map((s) => s.domain)];
}

// Each site's own script to run before its pages load (e.g. keeping a
// site's Family Mode on), from `beforeLoadJs` on the type or any of its
// sources. Each script checks the hostname itself.
function getBeforeLoadJs(config) {
  return [config, ...(config.sources || []), ...(config.extraSources || [])]
    .map((s) => s.beforeLoadJs || '')
    .join('');
}

// Collects { domain: buttonText } across every source that defines an
// autoConfirmButtonText, for the auto-confirm script to pick from based
// on which site is actually loaded.
function getDomainButtonMap(config) {
  const map = {};
  if (config.sources) {
    config.sources.forEach((s) => {
      if (s.autoConfirmButtonText) map[s.domain] = s.autoConfirmButtonText;
    });
  } else if (config.autoConfirmButtonText) {
    const host = getHostname(config.startUrl);
    if (host) map[host] = config.autoConfirmButtonText;
  }
  return map;
}

// Renders a webview for ONE media type, driven entirely by its config
// (see src/mediaTypes.js). Adding a new trackable type never touches
// this file — just add an entry to MEDIA_TYPES.
//
// Exposes goBackIfPossible() via ref rather than registering its own
// hardwareBackPress listener — App.js owns the single back handler
// (needed to ask "Exit app?" instead of closing outright) and calls into
// whichever tab is on screen. A listener per webview would go back in
// whichever tab registered last, not the visible one, since every loaded
// tab's webview stays mounted.
const MediaWebView = forwardRef(function MediaWebView({
  config,
  isSignedInToGoogle,
  showDebugTools,
  onViewInLibrary,
  buttons = ALL_BUTTONS,
  onTabBarActivity,
  initialUrl = null,
  onPageChange,
  openRequest = null,
  onOpenHandled,
  blockAds = true,
}, ref) {
  useDarkMode(); // redraws in the other colours when Dark mode is switched
  const webviewRef = useRef(null);
  // Pending getScreenshotInfo() calls, keyed by request id, resolved when
  // the page answers with a 'screenshotInfo' message.
  const screenshotRequests = useRef(new Map());
  const screenshotRequestCounter = useRef(0);
  // "Watch next" / "Read next" from the Library (App.js passes it as
  // openRequest: { id, url, checkJs, expect }): the page to open, and a
  // script to run once it has loaded — on the page whose URL contains
  // `expect` — that moves on to the wanted episode/chapter or reports it
  // doesn't exist yet (see openNext in mediaTypes.js).
  // The sites a title is searched on, one at a time (the "Next ›" bar):
  // the type's titleSearch, else its own search page. A request with
  // `search` (a title highlighted in another app, or an imported title
  // from the Library) opens the first one's results.
  const [searchSites] = useState(() =>
    config.titleSearch ||
    (config.buildSearchUrl
      ? [{ name: config.siteName || getHostname(config.startUrl), buildSearchUrl: config.buildSearchUrl }]
      : null)
  );
  const requestUrl = (request) =>
    request.search && searchSites ? searchSites[0].buildSearchUrl(request.search) : request.url;
  // The title search being shown: { query, index } into searchSites, or
  // null. Kept until closed or another search starts.
  // What's typed in the search bar (showSearchBox below).
  const [searchText, setSearchText] = useState('');
  const [titleSearch, setTitleSearch] = useState(() =>
    openRequest?.search && searchSites ? { query: openRequest.search, index: 0 } : null
  );
  const handledOpenId = useRef(openRequest ? openRequest.id : null);
  const pendingOpenCheck = useRef(
    openRequest?.checkJs ? { js: openRequest.checkJs, expect: openRequest.expect } : null
  );
  const viewInLibraryRef = useRef(onViewInLibrary);
  viewInLibraryRef.current = onViewInLibrary;
  // The site list (multi-site tabs): its sites, whether it's open, and the
  // page's URL (for which site is ticked; set on every navigation).
  const [sites] = useState(() => getTabSites(config));
  const [siteMenuVisible, setSiteMenuVisible] = useState(false);
  const [pageUrl, setPageUrl] = useState(null);
  // First page: initialUrl (the page this tab was on before Data saver
  // unloaded it — App.js) or the type's start page. Fixed at mount; a new
  // source would reload the page.
  const [startSource] = useState(() => ({
    uri: (openRequest && requestUrl(openRequest)) || initialUrl || config.startUrl,
  }));
  // Latest onPageChange, for the navigation handler below.
  const pageChangeRef = useRef(onPageChange);
  pageChangeRef.current = onPageChange;
  // Latest onTabBarActivity, for handleMessage (which isn't re-created
  // every time App.js passes a new function).
  const tabBarActivityRef = useRef(onTabBarActivity);
  tabBarActivityRef.current = onTabBarActivity;
  const pendingSourceId = useRef(null);
  // Set while waiting for a page that has to name its own series
  // (seriesFromPage), with pendingSourceId null meanwhile.
  const pendingFromPage = useRef(false);
  const pendingPageUrl = useRef(null);
  const currentUrlRef = useRef(null); // updated on every navigation, unlike pendingPageUrl
  // Tracks sourceIds currently being extracted/downloaded/uploaded, not
  // yet committed to the DB. entryExists() alone isn't enough to prevent
  // duplicates: native navigation events and the URL_WATCHER_JS poll can
  // both fire for the same page load within milliseconds of each other,
  // and both would pass the entryExists() check before either finishes
  // its async download+upload — resulting in two separate Drive uploads
  // of the same image. This in-memory guard closes that gap.
  const inFlightSourceIds = useRef(new Set());
  const [debugLog, setDebugLog] = useState([]);
  const [logVisible, setLogVisible] = useState(false);
  // Tracks whether the currently-loaded page corresponds to an entry
  // already in the library (as `${mediaType}:${sourceId}`, matching
  // EntryList's selection key format) — null when it doesn't, powering
  // the "View in Library" button below.
  const [currentEntryKey, setCurrentEntryKey] = useState(null);
  const savingImageRef = useRef(false);
  const [savingImage, setSavingImage] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [capturedHtml, setCapturedHtml] = useState('');
  const [htmlModalVisible, setHtmlModalVisible] = useState(false);

  // Keeps the most recent 100 lines, newest first, each timestamped so
  // it's clear which webview load a given message belongs to.
  const logDebug = useCallback((message) => {
    const line = `${new Date().toLocaleTimeString()}  ${message}`;
    setDebugLog((prev) => [line, ...prev].slice(0, 100));
  }, []);

  const handleCapturePageHtml = useCallback(() => {
    webviewRef.current?.injectJavaScript(GRAB_PAGE_HTML_JS);
  }, []);

  const handleSaveCurrentImage = useCallback(() => {
    // Guards with a ref, not just the `savingImage` state — state
    // updates aren't synchronous, so a fast double-tap can fire this
    // twice before React re-renders with the button disabled, causing
    // two identical downloads/gallery saves.
    if (savingImageRef.current) return;
    savingImageRef.current = true;
    setSavingImage(true);
    webviewRef.current?.injectJavaScript(GRAB_LARGEST_IMAGE_JS);
  }, []);

  // After a chapter update on a site whose pages don't show volume
  // numbers (promptForVolumes in mediaTypes.js): says volumes read wasn't
  // changed, unless snoozed (for Settings → Snooze chapter questions).
  const promptVolumes = useCallback((entry, chapter) => {
    if (Date.now() < Number(getSetting('volumePromptSnoozedUntil', '0'))) return;
    const volumes = entry.total_volumes
      ? `${entry.progress_volumes || 0} of ${entry.total_volumes}`
      : `${entry.progress_volumes || 0}`;
    Alert.alert(
      'Volumes read not updated',
      `"${entry.title || entry.source_id}" is now at chapter ${chapter}. This site doesn't show volume numbers, so volumes read (${volumes}) wasn't changed. Update it in the Library if needed.`,
      [
        {
          text: `Snooze ${snoozeLabel()}`,
          onPress: () => setSetting('volumePromptSnoozedUntil', String(snoozeUntil())),
        },
        {
          text: 'Edit',
          onPress: () => viewInLibraryRef.current?.(`${entry.media_type}:${entry.source_id}`),
        },
        { text: 'OK', style: 'cancel' },
      ]
    );
  }, []);

  // Opens a page in this tab and runs its check script once there (the
  // same as a "Watch next" request from the Library).
  const openInThisTab = useCallback((request, expect) => {
    pendingOpenCheck.current = request.checkJs ? { js: request.checkJs, expect } : null;
    webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(request.url)}; true;`);
  }, []);

  // Questions already asked on this visit ("<type>:<id>:<what>"), so a
  // page reported more than once doesn't ask twice.
  const askedRef = useRef(new Set());

  // The score question shown when a title is finished (RatePrompt.js):
  // { entry, heading, message, score, complete, closeLabel } or null.
  const [ratePrompt, setRatePrompt] = useState(null);

  // Records `number` as how far you are: the rewatch/reread position while
  // repeating a completed series, otherwise its progress (setting it to
  // Reading/Watching and filling an empty start date). Only moves forward.
  const recordProgress = useCallback(
    (entry, number, url) => {
      const repeating = entry.read_status === 'read' && !!entry.repeating;
      const current = (repeating ? entry.repeat_progress : entry.progress) || 0;
      const fields = {};
      if (!repeating && entry.read_status !== 'reading') {
        fields.read_status = 'reading';
        if (!entry.start_date) fields.start_date = todayString();
      }
      if (number > current) fields[repeating ? 'repeat_progress' : 'progress'] = number;
      if (number >= current && url !== entry.last_progress_url) fields.last_progress_url = url;
      if (Object.keys(fields).length === 0) return;

      const unit = config.key === 'anime' ? 'episode' : 'chapter';
      // The last episode/chapter of a rewatch/reread finishes it.
      const finishesRepeat = repeating && entry.total > 0 && number >= entry.total;
      if (finishesRepeat) {
        fields.repeating = 0;
        fields.repeat_progress = 0;
        fields.times_repeated = (entry.times_repeated || 0) + 1;
      }
      updateEntryFields(entry.source_id, entry.media_type, fields);
      logDebug(
        `${entry.source_id}: ${fields.read_status ? 'now Reading/Watching, ' : ''}${
          repeating ? 'repeat ' : ''
        }at ${unit} ${number}${number > current ? '' : ` (stays ${current})`}.`
      );
      maybeBackupLibraryToDrive();

      const title = entry.title || entry.source_id;
      // The last episode/chapter of a series (when the total is known):
      // offers to mark it Completed, with a score (RatePrompt.js).
      const reachesEnd = !repeating && entry.total > 0 && number >= entry.total && entry.read_status !== 'read';
      if (finishesRepeat) {
        const verb = config.key === 'anime' ? 'rewatching' : 'rereading';
        setRatePrompt({
          entry,
          heading: `Finished ${verb}`,
          message: `"${title}": ${verb} counted. Times ${config.key === 'anime' ? 'rewatched' : 'reread'}: ${
            fields.times_repeated
          }. Still the same score?`,
          score: entry.score,
        });
      } else if (reachesEnd) {
        setRatePrompt({
          entry,
          complete: true,
          heading: `Finished "${title}"?`,
          message: `That's the last ${unit} (${number} of ${entry.total}). Rate it to mark it Completed:`,
          score: entry.score,
          closeLabel: 'Not yet',
        });
      } else if (!repeating && config.promptForVolumes && fields.progress) {
        promptVolumes(entry, number);
      }
    },
    [config, logDebug, promptVolumes]
  );

  // A series still coming out has no total, so the app can't tell when it
  // has ended. For a title with a MyAnimeList id and no total, opening it
  // asks AniList again (at most once a day — needsAniList in malList.js);
  // once the series has ended AniList has its total, and if the chapter
  // just opened (`chapter`) is the last one, the Completed + score
  // question comes up straight away.
  const totalChecks = useRef(new Set()); // "<type>:<id>:<day>" asked this run
  const learnTotal = useCallback(
    (entry, chapter) => {
      if (!entry || !entry.mal_id || entry.total) return;
      const asked = `${entry.media_type}:${entry.source_id}:${todayString()}`;
      if (totalChecks.current.has(asked)) return;
      totalChecks.current.add(asked);
      refreshFromAniList([entry])
        .then(() => {
          const now = getEntry(entry.source_id, entry.media_type);
          if (!now || !now.total) return;
          logDebug(`${entry.source_id}: AniList now has its total, ${now.total}.`);
          maybeBackupLibraryToDrive();
          if (chapter === null || chapter === undefined || now.read_status === 'read' || chapter < now.total) return;
          const unit = config.key === 'anime' ? 'episode' : 'chapter';
          setRatePrompt({
            entry: now,
            complete: true,
            heading: `Finished "${now.title || now.source_id}"?`,
            message: `It has ended — ${unit} ${now.total} is the last. Rate it to mark it Completed:`,
            score: now.score,
            closeLabel: 'Not yet',
          });
        })
        .catch(() => {});
    },
    [config, logDebug]
  );

  // A score from RatePrompt; with `complete`, the title is also marked
  // Completed the way the Library does it (finish date, full progress).
  const finishRating = useCallback((prompt, score) => {
    setRatePrompt(null);
    const { entry } = prompt;
    const fields = {};
    if (score) fields.score = score;
    if (prompt.complete) {
      fields.read_status = 'read';
      if (!entry.finish_date) fields.finish_date = todayString();
      if (entry.total) fields.progress = entry.total;
      if (entry.total_volumes) fields.progress_volumes = entry.total_volumes;
    }
    if (Object.keys(fields).length === 0) return;
    updateEntryFields(entry.source_id, entry.media_type, fields);
    maybeBackupLibraryToDrive();
    if (Platform.OS === 'android') {
      ToastAndroid.show(
        prompt.complete ? `Completed${score ? ` · ${score}/10` : ''}` : `Score: ${score}/10`,
        ToastAndroid.SHORT
      );
    }
  }, []);

  // Opening an episode/chapter page (extractProgress in mediaTypes.js):
  // - a completed series asks whether you're starting a rewatch/reread
  //   ("Just looking" stops asking about that series for a while —
  //   Settings → Snooze chapter questions, src/snooze.js);
  // - more than one ahead of your record (stopped at 4, opened 7) asks
  //   first: go to the next one (5), record this one, or keep the record
  //   (which stops asking about that series for the same while);
  // - otherwise it's recorded (recordProgress). `fresh` is for a series
  //   recorded just now, which has no record to be ahead of.
  const applyProgress = useCallback(
    (entry, chapter, url, { fresh = false } = {}) => {
      // Chapter 0 (a prologue or one-shot) is a chapter too; when it's the
      // whole title (a total of 1), it counts as 1, so a reread of it ends.
      if (!entry || chapter === null || chapter === undefined || Number.isNaN(chapter)) return;
      const number = chapter === 0 && entry.total === 1 ? 1 : chapter;
      const key = `${entry.media_type}:${entry.source_id}`;
      const title = entry.title || entry.source_id;
      const unit = config.key === 'anime' ? 'episode' : 'chapter';
      const verb = config.key === 'anime' ? 'rewatching' : 'rereading';

      if (entry.read_status === 'read' && !entry.repeating) {
        const snoozeKey = `repeatSnooze:${key}`;
        if (askedRef.current.has(`${key}:repeat`)) return;
        if (Date.now() < Number(getSetting(snoozeKey, '0'))) return;
        askedRef.current.add(`${key}:repeat`);
        Alert.alert(`Start ${verb}?`, `You've completed "${title}". Start ${verb} it from ${unit} ${chapter}?`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Just looking',
            onPress: () => setSetting(snoozeKey, String(snoozeUntil())),
          },
          {
            text: `Start ${verb}`,
            onPress: () => {
              updateEntryFields(entry.source_id, entry.media_type, { repeating: 1, repeat_progress: 0 });
              recordProgress({ ...entry, repeating: 1, repeat_progress: 0 }, number, url);
            },
          },
        ]);
        return;
      }

      const repeating = entry.read_status === 'read' && !!entry.repeating;
      const current = (repeating ? entry.repeat_progress : entry.progress) || 0;
      // During a rewatch that hasn't got going yet, any start is fine.
      const ahead = !fresh && number > current + 1 && !(repeating && current === 0);
      if (ahead) {
        const asked = `${key}:${number}`;
        const snoozeKey = `aheadSnooze:${key}`;
        if (askedRef.current.has(asked)) return;
        if (Date.now() < Number(getSetting(snoozeKey, '0'))) return;
        askedRef.current.add(asked);
        const nextOne = current + 1;
        Alert.alert(
          'Ahead of your record',
          `${
            current === 0
              ? `Your record says you haven't started "${title}"`
              : `Your record for "${title}" says you stopped at ${unit} ${current}${
                  repeating ? ` (this ${verb.replace('ing', '')})` : ''
                }`
          }, but this is ${unit} ${number}.`,
          [
            {
              text: `Keep ${current}`,
              style: 'cancel',
              onPress: () => setSetting(snoozeKey, String(snoozeUntil())),
            },
            {
              text: `Go to ${unit} ${nextOne}`,
              onPress: () => {
                const target = repeating
                  ? { ...entry, progress: current, last_progress_url: entry.last_progress_url }
                  : entry;
                openInThisTab(config.openNext(target, nextOne), entry.source_id);
              },
            },
            { text: `Record ${number}`, onPress: () => recordProgress(entry, number, url) },
          ]
        );
        return;
      }
      recordProgress(entry, number, url);
    },
    [config, recordProgress, openInThisTab]
  );

  const checkUrlAndExtract = useCallback(
    (url) => {
      // Logged unconditionally (not just on a match) so the actual URL
      // is visible in the debug log even when nothing else about it is
      // informative — useful for identifying what an interstitial's
      // real URL looks like, since this webview has no visible address
      // bar to check directly on-device.
      logDebug(`Checking URL: ${url}`);

      // Some sites show an interstitial ("Continue to Video", an ad
      // gate, etc.) on a URL that ALREADY matches the real content
      // pattern — the overlay sits on top of the same page rather than
      // being a genuinely different pre-page, which meant extraction
      // was running immediately and saving wrong/incomplete data
      // (whatever was visible behind/before the overlay), regardless of
      // whether the interstitial ever got dismissed. Rather than trying
      // to detect and auto-dismiss the overlay itself (fragile — it
      // depends on knowing the exact button element, which varies and
      // is hard to inspect on some interstitials), this just skips
      // extraction entirely when the URL contains a known interstitial
      // marker, and waits for a subsequent URL change (which
      // URL_WATCHER_JS/onNavigationStateChange will still catch
      // normally) once you've actually gotten past it.
      if (config.interstitialKeywords && config.interstitialKeywords.some((kw) => url.includes(kw))) {
        logDebug(`URL looks like an interstitial — skipping until past it: ${url}`);
        setCurrentEntryKey(null);
        return;
      }

      const resolved = resolveSource(config, url);
      if (!resolved) {
        setCurrentEntryKey(null);
        return;
      }
      const { source, match } = resolved;

      const sourceId = source.extractId(match);
      // A page whose address doesn't name its series (seriesFromPage in
      // mediaTypes.js, e.g. a chapter page): its script reports the series
      // and the chapter, handled with the details below.
      if (!sourceId) {
        setCurrentEntryKey(null);
        if (!source.seriesFromPage || inFlightSourceIds.current.has(url)) return;
        inFlightSourceIds.current.add(url);
        pendingSourceId.current = null;
        pendingPageUrl.current = url;
        pendingFromPage.current = true;
        logDebug('Matched a page without its series in the address — asking the page…');
        setTimeout(() => {
          webviewRef.current?.injectJavaScript(source.extractMetadataJs);
        }, 400);
        return;
      }
      pendingFromPage.current = false;
      // Already recorded entries are skipped, except ones still missing
      // their MyAnimeList id (recorded before it was read), cover, title or
      // author: the page is read again just to fill those in.
      const existing = getEntry(sourceId, config.key);
      const extractProgress = source.extractProgress || config.extractProgress;
      const chapter = existing && extractProgress ? extractProgress(match, url) : null;
      if (existing && extractProgress) applyProgress(existing, chapter, url);
      if (existing) learnTotal(existing, chapter);
      if (existing && existing.mal_id) {
        logDebug(`Matched ${sourceId} — already recorded, skipping.`);
        setCurrentEntryKey(`${config.key}:${sourceId}`);
        missingDetails(existing).then((missing) => {
          if (!missing.length || pendingSourceId.current || inFlightSourceIds.current.has(sourceId)) return;
          logDebug(`${sourceId} is missing its ${missing.join(', ')} — reading the page for it.`);
          inFlightSourceIds.current.add(sourceId);
          pendingSourceId.current = sourceId;
          pendingPageUrl.current = url;
          setTimeout(() => {
            webviewRef.current?.injectJavaScript(source.extractMetadataJs);
          }, 400);
        });
        return;
      }
      setCurrentEntryKey(existing ? `${config.key}:${sourceId}` : null);
      if (inFlightSourceIds.current.has(sourceId)) {
        logDebug(`Matched ${sourceId} — already being processed, skipping duplicate trigger.`);
        return;
      }
      inFlightSourceIds.current.add(sourceId);

      pendingSourceId.current = sourceId;
      pendingPageUrl.current = url;
      logDebug(`Matched ${sourceId}${config.sources ? ` (${source.name})` : ''} — extracting…`);
      // Small delay as extra safety margin: some sites finish "loading"
      // slightly before all head/meta content or the video element is
      // actually in the DOM.
      setTimeout(() => {
        webviewRef.current?.injectJavaScript(source.extractMetadataJs);
      }, 400);
    },
    [config, logDebug, applyProgress, learnTotal]
  );

  const handleNavigationStateChange = useCallback(
    (navState) => {
      currentUrlRef.current = navState.url;
      setPageUrl(navState.url);
      // Kept by App.js, so Data saver can reopen this page after unloading.
      pageChangeRef.current?.(navState.url);
      setCanGoBack(navState.canGoBack);
      // navState fires multiple times per navigation (start, in-progress,
      // finish). Extracting on the first ("start") event queries a page
      // that hasn't actually loaded yet — still the old content or blank
      // — which returns null meta tags and gets an entry saved with no
      // thumbnail. Only extract once loading has actually finished.
      if (navState.loading) return;
      checkUrlAndExtract(navState.url);
      const pending = pendingOpenCheck.current;
      if (pending && navState.url.includes(pending.expect)) {
        pendingOpenCheck.current = null;
        setTimeout(() => webviewRef.current?.injectJavaScript(pending.js), 500);
      }
    },
    [checkUrlAndExtract]
  );

  // A new "Watch next" / "Read next" request while this tab is open (one
  // that arrived with the tab was opened as its first page, above).
  // App.js clears it once taken, so a reload of the tab doesn't repeat it.
  useEffect(() => {
    if (!openRequest) return;
    if (handledOpenId.current !== openRequest.id) {
      handledOpenId.current = openRequest.id;
      pendingOpenCheck.current = openRequest.checkJs
        ? { js: openRequest.checkJs, expect: openRequest.expect }
        : null;
      setTitleSearch(openRequest.search && searchSites ? { query: openRequest.search, index: 0 } : null);
      webviewRef.current?.injectJavaScript(
        `window.location.href = ${JSON.stringify(requestUrl(openRequest))}; true;`
      );
    }
    onOpenHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, onOpenHandled]);

  // Opens one site's search results for the title search; Next moves the
  // same search on to the next site.
  const openTitleSearch = useCallback(
    (query, index) => {
      const site = searchSites[index];
      setTitleSearch({ query, index });
      logDebug(`Title search: "${query}" on ${site.name}`);
      webviewRef.current?.injectJavaScript(
        `window.location.href = ${JSON.stringify(site.buildSearchUrl(query))}; true;`
      );
    },
    [searchSites, logDebug]
  );

  // Blocks navigation to any domain other than the site's own (or, for
  // a multi-source type, any of its sources' domains) — this is what
  // stops ad popups/redirects/hijacks, regardless of the exact
  // mechanism the ad script uses (window.open, location.href, a clicked
  // link, a meta refresh, whatever). Every one of those ultimately
  // triggers a navigation request, which this intercepts and rejects
  // before it ever loads, rather than trying to detect and dismiss the
  // ad after the fact. Opt-in per media type via `blockExternalNavigation`
  // in mediaTypes.js — off by default since some sites legitimately link
  // out (e.g. to a Discord/Twitter), and blocking that might be
  // unwanted depending on the site.
  //
  // Domain-matching alone isn't enough, though — some sites run their
  // own same-domain ad-redirect endpoint specifically to defeat this
  // kind of blocking (e.g. example.com/pop?url=<encoded-ad-destination> —
  // technically still example.com, so it passes the domain check, even
  // though its entire purpose is hijacking the page into an ad). An
  // optional `blockedUrlPatterns` (array of regexes) catches these:
  // checked regardless of domain, so a same-domain redirect endpoint
  // like this gets blocked too.
  const allowedDomains = getAllowedDomains(config);
  const appLinkNoticeAt = useRef(0);
  const handleShouldStartLoad = useCallback(
    (request) => {
      // Links that would open another app are always blocked, whatever the
      // tab (originWhitelist below sends them here instead of to Android).
      if (request.url && !IN_PAGE_SCHEME.test(request.url)) {
        logDebug(`Blocked opening another app: ${request.url.slice(0, 120)}`);
        if (Platform.OS === 'android' && Date.now() - appLinkNoticeAt.current > 10000) {
          appLinkNoticeAt.current = Date.now();
          ToastAndroid.show('Blocked: the page tried to open another app.', ToastAndroid.SHORT);
        }
        return false;
      }
      if (config.blockedUrlPatterns && config.blockedUrlPatterns.some((p) => p.test(request.url))) {
        return false;
      }
      // Known ad networks (adBlock.js) are never opened, on any tab.
      if (blockAds && isAdUrl(request.url)) {
        logDebug(`Ad blocked: page ${request.url}`);
        return false;
      }
      if (!config.blockExternalNavigation) return true;
      const requestHostname = getHostname(request.url);
      // Also allow about:blank, data: and blob: through untouched —
      // getHostname returns null for those, and blocking them tends to
      // break legitimate in-page behavior for no reason.
      if (!requestHostname) return true;
      return allowedDomains.some(
        (domain) => requestHostname === domain || requestHostname.endsWith(`.${domain}`)
      );
    },
    [config, allowedDomains, blockAds, logDebug]
  );

  // Pop-ups and "open in new window" links: opened in this same view only
  // if they'd be allowed as a normal page (handleShouldStartLoad above),
  // so ads and other sites are dropped.
  const handleOpenWindow = useCallback(
    (event) => {
      const url = event.nativeEvent.targetUrl;
      if (!url || !handleShouldStartLoad({ url })) {
        logDebug(`Pop-up blocked: ${url || '(no address)'}`);
        return;
      }
      webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
    },
    [handleShouldStartLoad, logDebug]
  );

  // Android back button (App.js): back in the webview's own history
  // (previous page, previous search results, etc) when there is one;
  // false otherwise, so App.js asks whether to exit.
  useImperativeHandle(
    ref,
    () => ({
      goBackIfPossible: () => {
        if (canGoBack && webviewRef.current) {
          webviewRef.current.goBack();
          return true;
        }
        return false;
      },
      // For App.js's screenshot filing log (Settings → Show debug tools).
      logDebug: (message) => logDebug(message),
      // Called by App.js when you switch to another tab or leave the app,
      // so a video doesn't keep playing where you can't see it.
      pauseMedia: () => {
        webviewRef.current?.injectJavaScript(PAUSE_MEDIA_JS);
      },
      // For naming screenshots (App.js). Resolves to
      // { code, pageNumber, title, currentTime } — any of them null when
      // not available. Never rejects: if the page doesn't answer within
      // 1.5s it falls back to the last known URL, without title/time.
      // The title prefers the Library entry's (same name you see in the
      // Library), falling back to the page's own title.
      getScreenshotInfo: () =>
        new Promise((resolve) => {
          const requestId = String(++screenshotRequestCounter.current);
          const finish = (page) => {
            const url = (page && page.url) || currentUrlRef.current;
            const resolved = url ? resolveSource(config, url) : null;
            const code = resolved ? resolved.source.extractId(resolved.match) : null;
            const pageNumber =
              resolved && resolved.source.extractPageNumber ? resolved.source.extractPageNumber(resolved.match) : null;
            const entry = code ? getEntry(code, config.key) : null;
            resolve({
              code: code || null,
              pageNumber: pageNumber || null,
              title: (entry && entry.title) || (page && page.title) || null,
              currentTime: page && typeof page.currentTime === 'number' ? page.currentTime : null,
            });
          };
          const timer = setTimeout(() => {
            screenshotRequests.current.delete(requestId);
            finish(null);
          }, 1500);
          screenshotRequests.current.set(requestId, (page) => {
            clearTimeout(timer);
            finish(page);
          });
          webviewRef.current?.injectJavaScript(buildScreenshotInfoJs(requestId));
        }),
    }),
    [canGoBack, config, logDebug]
  );

  // Saves a held picture (src/imageHold.js) to this tab's gallery folder
  // (e.g. Pictures/AniManga Tracker/Manga/, gallery.js), named
  // "<code>_<time>" on a title's page (e.g. "12345_20261014_220215"),
  // else "<site>_<time>".
  const savingHeldPicture = useRef(false);
  const saveHeldPicture = useCallback(
    async (picture, pageUrl) => {
      if (savingHeldPicture.current) return;
      savingHeldPicture.current = true;
      const toast = (text, long = false) =>
        Platform.OS === 'android' && ToastAndroid.show(text, long ? ToastAndroid.LONG : ToastAndroid.SHORT);
      try {
        const resolved = pageUrl ? resolveSource(config, pageUrl) : null;
        const label = (resolved && resolved.source.extractId(resolved.match)) || getHostname(pageUrl) || 'picture';
        const folder = galleryFolderFor(config.label);
        const name = await saveHeldPictureToGallery(picture, pageUrl, folder, label);
        toast(`Saved to ${folder}`);
        logDebug(`Hold to save: saved "${name}".`);
      } catch (err) {
        if (err.message === 'denied') toast('Allow photo access to save pictures.');
        else toast(`Couldn't save the picture (${err.message}).`, true);
        logDebug(`Hold to save FAILED: ${err.message}`);
      } finally {
        savingHeldPicture.current = false;
      }
    },
    [config, logDebug]
  );

  const handleMessage = useCallback(
    async (event) => {
      let payload;
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      // Some sites change the URL via client-side routing (history.pushState)
      // without a full page load, which react-native-webview's
      // onNavigationStateChange never fires for. URL_WATCHER_JS below
      // polls for that and reports changes through this same channel.
      if (payload.type === 'screenshotInfo') {
        const callback = screenshotRequests.current.get(payload.requestId);
        if (callback) {
          screenshotRequests.current.delete(payload.requestId);
          callback(payload);
        }
        return;
      }

      // Reported by AD_BLOCK_JS (adBlock.js) each time it stops something.
      if (payload.type === 'adBlocked') {
        logDebug(`Ad blocked: ${payload.what} ${payload.url}`);
        return;
      }

      if (payload.type === 'urlchange') {
        checkUrlAndExtract(payload.url);
        return;
      }

      // Scrolling / pull-at-top, for the auto-hiding tab row (App.js).
      if (payload.type === 'tabBar') {
        tabBarActivityRef.current?.(payload.kind);
        return;
      }

      // Held a finger on a picture (src/imageHold.js): ask, then save it.
      if (payload.type === 'holdImage') {
        if (payload.error) {
          if (Platform.OS === 'android') ToastAndroid.show("This picture can't be saved.", ToastAndroid.SHORT);
          return;
        }
        if (!payload.url && !payload.dataUrl) return;
        const pageUrl = currentUrlRef.current;
        Alert.alert('Save picture?', `Saves it to your gallery in ${galleryFolderFor(config.label)}.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save', onPress: () => saveHeldPicture(payload, pageUrl) },
        ]);
        return;
      }

      if (payload.type === 'episodeMissing') {
        Alert.alert(config.key === 'anime' ? 'No next episode' : 'No next chapter', payload.message);
        return;
      }

      if (payload.type === 'pageHtml') {
        setCapturedHtml(payload.html || '(empty)');
        setHtmlModalVisible(true);
        return;
      }

      if (payload.type === 'pageImage') {
        savingImageRef.current = false;
        setSavingImage(false);
        if (!payload.imageUrl) {
          logDebug('Save image: no image found on this page.');
          return;
        }
        try {
          // The permission dialog (and on some devices, the save
          // action itself) briefly registers as the app going
          // "inactive" in AppState — without this, AppLock would treat
          // that exactly like leaving the app and force a re-unlock
          // immediately after saving an image.
          suppressNextRelock();
          const { status } = await MediaLibrary.requestPermissionsAsync();
          if (status !== 'granted') {
            logDebug('Save image: photo library permission denied.');
            return;
          }

          // Name the file "code -- page" (e.g. "12345 -- 3") using the
          // current URL, so saved pages sort/identify themselves clearly
          // in the gallery. Falls back to a timestamp if the current URL
          // doesn't match this media type's pattern at all (e.g. saving
          // from an unrelated page within the same webview).
          const resolved = currentUrlRef.current ? resolveSource(config, currentUrlRef.current) : null;
          let fileNameBase = `page-${Date.now()}`;
          if (resolved) {
            const { source, match } = resolved;
            const code = source.extractId(match);
            const pageNumber = source.extractPageNumber ? source.extractPageNumber(match) : null;
            if (code) fileNameBase = pageNumber ? `${code} -- ${pageNumber}` : code;
          }
          fileNameBase = safeFileName(fileNameBase);

          const tempPath = `${FileSystem.cacheDirectory}${fileNameBase}.jpg`;
          await FileSystem.downloadAsync(payload.imageUrl, tempPath, {
            headers: currentUrlRef.current ? { Referer: currentUrlRef.current } : undefined,
          });
          const folder = galleryFolderFor(config.label);
          try {
            await saveFileToGallery(tempPath, folder);
          } finally {
            FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
          }
          logDebug(`Saved current page image to ${folder} as "${fileNameBase}".`);
        } catch (err) {
          logDebug(`Save image FAILED: ${err.message}`);
        }
        return;
      }

      // Scripts of sites whose pages name their series (seriesFromPage in
      // mediaTypes.js) answer with the series (sourceId), the chapter
      // (progress) and their own page (pageUrl), so the answer stands
      // even if you've moved on to another page while it was being read.
      // Only an answer for the page being waited on clears that wait.
      const selfNamed = !!(config.seriesFromPage && payload.pageUrl);
      const ownsPending = !selfNamed || payload.pageUrl === pendingPageUrl.current;
      const clearPending = () => {
        if (!ownsPending) return;
        pendingSourceId.current = null;
        pendingPageUrl.current = null;
        pendingFromPage.current = false;
      };
      let sourceId = selfNamed ? null : pendingSourceId.current;
      const pageUrl = selfNamed ? payload.pageUrl : pendingPageUrl.current;

      // A site you added (customSites.js): its general reader found that
      // this page isn't one title's page (home, search, a tag list…).
      if (payload.notAnEntry) {
        logDebug(`${sourceId || pageUrl} isn't a title's page — not saved.`);
        if (sourceId) inFlightSourceIds.current.delete(sourceId);
        if (pageUrl) inFlightSourceIds.current.delete(pageUrl);
        clearPending();
        return;
      }

      if (selfNamed) {
        inFlightSourceIds.current.delete(pageUrl);
        if (!payload.sourceId) {
          logDebug(`Not recording from this page: ${payload.skip || 'no series found'}.`);
          clearPending();
          return;
        }
        sourceId = String(payload.sourceId);
        const known = getEntry(sourceId, config.key);
        if (ownsPending) setCurrentEntryKey(known ? `${config.key}:${sourceId}` : null);
        if (known && payload.progress != null) applyProgress(known, payload.progress, pageUrl);
        // A series page's own answer was already marked in flight by
        // checkUrlAndExtract; anything else for that series is a duplicate.
        const waitedFor = ownsPending && pendingSourceId.current === sourceId;
        if (!waitedFor && inFlightSourceIds.current.has(sourceId)) {
          clearPending();
          return;
        }
        inFlightSourceIds.current.add(sourceId);
      } else if (!sourceId && pendingFromPage.current && pageUrl) {
        // An answer without the series (e.g. { skip }).
        inFlightSourceIds.current.delete(pageUrl);
        logDebug(`Not recording from this page: ${payload.skip || 'no series found'}.`);
        clearPending();
        return;
      }
      if (!sourceId) return;

      // Re-check right before writing, closing the gap between the
      // nav-state check and this async step. An existing entry only gets
      // what it was missing filled in: its MyAnimeList id, cover, title or
      // author (fillMissingEntryFields — nothing already there changes).
      const existing = getEntry(sourceId, config.key);
      if (existing) {
        if (!existing.mal_id && payload.malId) {
          setMalId(sourceId, config.key, payload.malId);
          refreshFromAniList([getEntry(sourceId, config.key)]).catch(() => {});
          logDebug(`Matched ${sourceId} — already recorded, added its MyAnimeList id ${payload.malId}.`);
          maybeBackupLibraryToDrive();
        } else {
          learnTotal(existing, payload.progress);
        }
        if (!payload.skip) {
          let coverPath = null;
          if (payload.imageUrl && !(await hasCoverFile(existing))) {
            try {
              coverPath = await downloadImageLocally(payload.imageUrl, config.key, sourceId, pageUrl);
            } catch (err) {
              logDebug(`Cover download FAILED for ${sourceId}: ${err.message}`);
            }
          }
          const filled = fillMissingEntryFields(sourceId, config.key, {
            title: payload.title,
            altTitle: payload.altTitle,
            author: payload.author,
            coverPath,
          });
          if (filled.length) {
            logDebug(`Filled in for ${sourceId}: ${filled.join(', ')}`);
            maybeBackupLibraryToDrive();
          }
          // A new cover goes up like a new entry's (or waits for Wi-Fi).
          if (coverPath && isSignedInToGoogle && !driveSyncAllowed()) {
            markDriveSyncDeferred();
          } else if (coverPath && isSignedInToGoogle) {
            try {
              const updated = getEntry(sourceId, config.key);
              const driveFileId = await uploadImageToDrive(
                config.key,
                buildDriveDisplayName(sourceId, updated && updated.title),
                coverPath
              );
              markSynced(sourceId, config.key, driveFileId);
            } catch (err) {
              markSyncFailed(sourceId, config.key);
            }
          }
        }
        clearPending();
        inFlightSourceIds.current.delete(sourceId);
        return;
      }

      // extractMetadataJs can decline a page that matches urlRegex but
      // doesn't carry the details (e.g. a manga reader page with no
      // cover) by posting { skip: '<reason>' }; the entry gets recorded
      // from a page that does.
      if (payload.skip) {
        logDebug(`Matched ${sourceId} — ${payload.skip}, not recording from this page.`);
        clearPending();
        inFlightSourceIds.current.delete(sourceId);
        return;
      }

      // 18+ titles (site genres, or AniList by MAL id) are only recorded
      // if you say so; a "Don't add" isn't asked again until the app
      // restarts.
      if (
        !(payload.malId && getEntryByMalId(payload.malId, config.key)) &&
        (await isAdultTitle({ malId: payload.malId, mediaType: config.key, genres: payload.genre }))
      ) {
        const adultKey = `${config.key}:${sourceId}`;
        const add =
          !declinedAdult.has(adultKey) &&
          (await new Promise((resolve) =>
            Alert.alert(
              '18+ title',
              `"${payload.title || sourceId}" is marked 18+. Add it to the library anyway?`,
              [
                { text: "Don't add", style: 'cancel', onPress: () => resolve(false) },
                { text: 'Add', onPress: () => resolve(true) },
              ],
              { cancelable: true, onDismiss: () => resolve(false) }
            )
          ));
        if (!add) {
          declinedAdult.add(adultKey);
          logDebug(`Matched ${sourceId} — 18+, not recording it.`);
          clearPending();
          inFlightSourceIds.current.delete(sourceId);
          return;
        }
        logDebug(`Matched ${sourceId} — 18+, recording it as asked.`);
      }

      // A missing/failed thumbnail no longer blocks saving the entry —
      // previously a failed download here silently dropped the whole
      // entry with no feedback. Better to record it (title/author still
      // captured) than lose it entirely; localImagePath just stays null.
      let localPath = null;
      if (payload.imageUrl) {
        try {
          localPath = await downloadImageLocally(payload.imageUrl, config.key, sourceId, pageUrl);
        } catch (err) {
          console.warn(`Thumbnail download failed for ${config.key} ${sourceId}:`, err.message);
          logDebug(`Thumbnail download FAILED for ${sourceId}: ${err.message}`);
        }
      }

      try {
        // A title imported from a MyAnimeList list (no cover, no site
        // link yet) becomes this entry, keeping its status, score and
        // tags, rather than being recorded a second time.
        // Found by MAL id, or — on sites without MAL links — by title
        // (imported titles carry AniList's English title too).
        const byMalId = payload.malId ? getEntryByMalId(payload.malId, config.key) : null;
        const imported =
          byMalId && isImportedSourceId(byMalId.source_id)
            ? byMalId
            : findImportedByTitle(config.key, [payload.title, payload.altTitle]);
        const details = {
          sourceId,
          title: payload.title,
          altTitle: payload.altTitle,
          author: payload.author,
          sourceUrl: payload.sourceUrl || pageUrl,
          localImagePath: localPath,
        };
        const adopted = !!(imported && isImportedSourceId(imported.source_id));
        if (adopted) {
          adoptImportedEntry(imported.source_id, config.key, details);
          // The cover downloaded at import is replaced by the site's.
          if (localPath && imported.local_image_path && imported.local_image_path !== localPath) {
            FileSystem.deleteAsync(imported.local_image_path, { idempotent: true }).catch(() => {});
          }
          logDebug(`Linked ${sourceId} to "${imported.title}" from your imported MyAnimeList list.`);
        } else {
          insertEntry({ ...details, mediaType: config.key, malId: payload.malId });
        }
        // Its total episodes/chapters (and genres) from AniList, if known.
        if (payload.malId) refreshFromAniList([getEntry(sourceId, config.key)]).catch(() => {});
        // Recorded from an episode page: that's progress too.
        const resolvedPage = resolveSource(config, pageUrl);
        const extractProgress = resolvedPage && (resolvedPage.source.extractProgress || config.extractProgress);
        const pageProgress = payload.progress ?? (extractProgress ? extractProgress(resolvedPage.match, pageUrl) : null);
        if (pageProgress != null) {
          // A series new to the library has no record to be ahead of; one
          // imported from MAL does.
          applyProgress(getEntry(sourceId, config.key), pageProgress, pageUrl, { fresh: !adopted });
        }
        logDebug(
          `Saved ${sourceId}${localPath ? ' with thumbnail' : ' (no thumbnail)'} — title: ${payload.title || '(none)'}${payload.altTitle ? ` — alt title: ${payload.altTitle}` : ''} — author: ${payload.author || '(none)'}`
        );
        if (ownsPending) setCurrentEntryKey(`${config.key}:${sourceId}`);
        maybeBackupLibraryToDrive().then((result) => {
          if (!result.attempted) return; // Drive not connected — nothing to report
          logDebug(
            result.success
              ? 'Auto-backup: library-backup.csv updated on Drive.'
              : `Auto-backup FAILED: ${result.error}`
          );
        });

        // On mobile data with Drive sync set to Wi-Fi only, the cover stays
        // pending and goes up with the Wi-Fi catch-up (App.js).
        if (isSignedInToGoogle && localPath && !driveSyncAllowed()) {
          markDriveSyncDeferred();
          logDebug(`Cover upload for ${sourceId} waits for Wi-Fi (Settings → Data saver).`);
        } else if (isSignedInToGoogle && localPath) {
          try {
            const driveFileId = await uploadImageToDrive(
              config.key,
              buildDriveDisplayName(sourceId, payload.title),
              localPath
            );
            markSynced(sourceId, config.key, driveFileId);
          } catch (err) {
            // Local save already succeeded; cloud sync can be retried later.
            markSyncFailed(sourceId, config.key);
          }
        }
      } catch (err) {
        console.warn(`Failed to save ${config.key} entry:`, err);
        logDebug(`FAILED to save ${sourceId}: ${err.message}`);
      } finally {
        clearPending();
        inFlightSourceIds.current.delete(sourceId);
      }
    },
    [config, isSignedInToGoogle, checkUrlAndExtract, logDebug, applyProgress, saveHeldPicture, learnTotal]
  );

  // Site list: picks one of the tab's sites and opens its home page.
  const currentSiteIndex = siteIndexFor(sites, pageUrl || startSource.uri);
  const openSite = (site) => {
    setSiteMenuVisible(false);
    // During a title search, a site with a search shows its results.
    const searchIndex = titleSearch ? searchSites.findIndex((t) => t.name === site.name) : -1;
    if (searchIndex >= 0) {
      openTitleSearch(titleSearch.query, searchIndex);
      return;
    }
    logDebug(`Site list: opening ${site.name}`);
    webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(site.homeUrl)}; true;`);
  };
  const siteButton =
    sites.length < 2 || !buttons.siteMenu ? null : (
      <TouchableOpacity style={[styles.manualButton, styles.siteButton]} onPress={() => setSiteMenuVisible(true)}>
        <Text style={styles.manualButtonText} numberOfLines={1}>
          {currentSiteIndex >= 0 ? sites[currentSiteIndex].name : 'Sites'} ▾
        </Text>
      </TouchableOpacity>
    );

  // The search bar at the top (Settings → Buttons → Search box): a title
  // typed here opens the first site's results with the Next › bar.
  const showSearchBox = !!searchSites && buttons.searchBox !== false;
  const submitSearch = () => {
    const query = searchText.replace(/\s+/g, ' ').trim();
    if (!query) return;
    Keyboard.dismiss();
    openTitleSearch(query, 0);
  };

  return (
    <View style={styles.container}>
      {siteButton || showSearchBox ? (
        <View style={styles.manualBar}>
          {siteButton}
          {showSearchBox ? (
            <>
              <TextInput
                style={styles.manualInput}
                value={searchText}
                onChangeText={setSearchText}
                onSubmitEditing={submitSearch}
                placeholder={`Search ${config.label} titles…`}
                placeholderTextColor="#8892b0"
                returnKeyType="search"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.manualButton} onPress={submitSearch}>
                <Text style={styles.manualButtonText}>Search</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      ) : null}
      {titleSearch ? (
        <View style={styles.titleSearchBar}>
          <Text style={styles.titleSearchText} numberOfLines={1}>
            “{titleSearch.query}” on {searchSites[titleSearch.index].name}
            {searchSites.length > 1 ? ` (${titleSearch.index + 1}/${searchSites.length})` : ''}
          </Text>
          {/* The next site, round to the first again after the last. */}
          {searchSites.length > 1 ? (
            <TouchableOpacity
              style={[styles.manualButton, styles.siteButton]}
              onPress={() => openTitleSearch(titleSearch.query, (titleSearch.index + 1) % searchSites.length)}
            >
              <Text style={styles.manualButtonText} numberOfLines={1}>
                Next: {searchSites[(titleSearch.index + 1) % searchSites.length].name} ›
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setTitleSearch(null)} hitSlop={TAP_SLOP} accessibilityLabel="Stop searching">
            <Text style={styles.titleSearchClose}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {currentEntryKey ? (
        <TouchableOpacity
          style={styles.viewInLibraryButton}
          onPress={() => onViewInLibrary?.(currentEntryKey)}
        >
          <Text style={styles.saveImageButtonText}>📚 View in Library</Text>
        </TouchableOpacity>
      ) : null}
      {config.savePageImage && buttons.savePageImage ? (
        <TouchableOpacity
          style={styles.saveImageButton}
          onPress={handleSaveCurrentImage}
          disabled={savingImage}
        >
          <Text style={styles.saveImageButtonText}>
            {savingImage ? 'Saving…' : '⬇ Save Page Image'}
          </Text>
        </TouchableOpacity>
      ) : null}
      {showDebugTools ? (
        <>
          <TouchableOpacity style={styles.captureHtmlButton} onPress={handleCapturePageHtml}>
            <Text style={styles.saveImageButtonText}>🔍 Capture HTML</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.debugBar} onPress={() => setLogVisible(true)}>
            <Text style={styles.debugText} numberOfLines={1}>
              {debugLog[0] || 'No activity yet.'}  (tap for full log)
            </Text>
          </TouchableOpacity>
          <Modal
            visible={htmlModalVisible}
            animationType="slide"
            onRequestClose={() => setHtmlModalVisible(false)}
          >
            <View style={styles.logModal}>
              <View style={styles.logHeader}>
                <Text style={styles.logTitle}>Page HTML</Text>
                <TouchableOpacity onPress={() => setHtmlModalVisible(false)}>
                  <Text style={styles.logClose}>Close</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.htmlHint}>
                Long-press the text below, then "Select All" and "Copy" to paste it elsewhere.
              </Text>
              <TextInput
                style={styles.htmlTextBox}
                value={capturedHtml}
                multiline
                editable={false}
                selectTextOnFocus
              />
            </View>
          </Modal>
        </>
      ) : null}
      <RatePrompt
        prompt={ratePrompt}
        onRate={(score) => finishRating(ratePrompt, score)}
        onClose={() => setRatePrompt(null)}
      />
      <Modal visible={siteMenuVisible} transparent animationType="fade" onRequestClose={() => setSiteMenuVisible(false)}>
        <TouchableOpacity style={styles.siteMenuOverlay} activeOpacity={1} onPress={() => setSiteMenuVisible(false)}>
          <View style={styles.siteMenu}>
            {sites.map((site, i) => (
              <TouchableOpacity
                key={site.domain}
                style={[styles.siteMenuRow, i < sites.length - 1 && styles.siteMenuRowGap]}
                onPress={() => openSite(site)}
              >
                <Text style={[styles.siteMenuText, i === currentSiteIndex && styles.siteMenuTextCurrent]}>
                  {i === currentSiteIndex ? '✓ ' : ''}
                  {site.name}
                </Text>
                <Text style={styles.siteMenuDomain}>{site.domain}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
      <Modal visible={logVisible} animationType="slide" onRequestClose={() => setLogVisible(false)}>
        <View style={styles.logModal}>
          <View style={styles.logHeader}>
            <Text style={styles.logTitle}>{config.label} debug log</Text>
            <TouchableOpacity onPress={() => setLogVisible(false)}>
              <Text style={styles.logClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.logScroll}>
            {debugLog.length === 0 ? (
              <Text style={styles.logLine}>No activity yet.</Text>
            ) : (
              debugLog.map((line, i) => (
                <Text key={i} style={styles.logLine}>{line}</Text>
              ))
            )}
          </ScrollView>
          <TouchableOpacity style={styles.logClearButton} onPress={() => setDebugLog([])}>
            <Text style={styles.logClearButtonText}>Clear log</Text>
          </TouchableOpacity>
        </View>
      </Modal>
      <WebView
        ref={webviewRef}
        source={startSource}
        onNavigationStateChange={handleNavigationStateChange}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        // Every address goes to handleShouldStartLoad. With the default
        // (http/https only), anything else skips it and goes straight to
        // Android, which opens whatever app handles it (an ad's market:
        // link opening the Play Store).
        originWhitelist={['*']}
        onMessage={handleMessage}
        // Pop-ups and "open in new window" links are handed to
        // handleOpenWindow, which opens them in this same view only if
        // they'd be allowed as a normal page (ads and other sites are
        // dropped). Multiple windows stay switched on because turning them
        // off lets a page's embedded frame take over the main page
        // (CVE-2020-6506, per the react-native-webview docs).
        setSupportMultipleWindows={true}
        onOpenWindow={handleOpenWindow}
        // Without this, the fullscreen button on an HTML5 <video>
        // player does nothing at all on Android — WebView doesn't
        // support the browser Fullscreen API for video by default.
        allowsFullscreenVideo={true}
        // Lets video play inline in the page rather than forcing it
        // into a separate native player, so the in-page player's own
        // controls (including fullscreen) behave the way they would in
        // a real mobile browser.
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        // Optional per-type UA override. Android's WebView identifies
        // itself with a "wv" marker in its default User-Agent string,
        // which some streaming sites specifically detect and use to
        // kill video playback shortly after it starts (a common symptom:
        // video plays for a second or two then stops on its own).
        // Spoofing a plain mobile Chrome UA (no "wv" marker) avoids
        // that detection.
        userAgent={config.userAgent}
        injectedJavaScriptBeforeContentLoaded={
          URL_WATCHER_JS +
          buildAutoConfirmJs(getDomainButtonMap(config)) +
          (config.doubleTapSeekSeconds ? buildDoubleTapSeekJs(config.doubleTapSeekSeconds) : '') +
          getBeforeLoadJs(config) +
          TAB_BAR_WATCH_JS +
          IMAGE_HOLD_JS +
          (blockAds ? AD_BLOCK_JS : '')
        }
        // The tab-row watcher, hold-to-save and ad blocking again once the
        // page has loaded, since Android doesn't always run the script
        // above (each only runs once per page).
        injectedJavaScript={TAB_BAR_WATCH_JS + IMAGE_HOLD_JS + (blockAds ? AD_BLOCK_JS : '')}
      />
    </View>
  );
});

export default MediaWebView;

const styles = themed(StyleSheet.create({
  container: { flex: 1 },
  manualBar: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: '#16213e',
    gap: 8,
  },
  manualButton: {
    backgroundColor: '#e94560',
    borderRadius: 6,
    paddingHorizontal: 14,
    minHeight: 34,
    justifyContent: 'center',
  },
  manualButtonText: { color: '#fff', fontWeight: '600' },
  manualInput: {
    flex: 1,
    minHeight: 34,
    backgroundColor: '#1a1a2e',
    color: '#fff',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  siteButton: { backgroundColor: '#1f4068', paddingHorizontal: 10, maxWidth: 140 },
  // Title search: which site's results are showing, and Next.
  titleSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#16213e',
  },
  titleSearchText: { flex: 1, color: '#ddd', fontSize: 13 },
  titleSearchClose: { color: '#aaa', fontSize: 18, paddingHorizontal: 4 },
  // The site list drops down from the top left, under its button.
  siteMenuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', paddingTop: 96, paddingHorizontal: 8 },
  siteMenu: { alignSelf: 'flex-start', minWidth: 220, backgroundColor: '#16213e', borderRadius: 8, paddingVertical: 4 },
  siteMenuRow: { paddingVertical: 10, paddingHorizontal: 14 },
  siteMenuRowGap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3a5e' },
  siteMenuText: { color: '#fff', fontSize: 15 },
  siteMenuTextCurrent: { color: '#e94560', fontWeight: '700' },
  siteMenuDomain: { color: '#8892b0', fontSize: 12, marginTop: 2 },
  viewInLibraryButton: {
    backgroundColor: '#1a7a4c',
    paddingVertical: 8,
    alignItems: 'center',
  },
  saveImageButton: {
    backgroundColor: '#0f3460',
    paddingVertical: 8,
    alignItems: 'center',
  },
  // Spans the button's full width (centred) rather than shrink-wrapping:
  // on Samsung phones a colour emoji like 📚 is measured narrower than it
  // draws, so a shrink-wrapped one-line label wrapped its last word
  // ("Library") onto a hidden second line. With the full width there's
  // always room, so nothing wraps.
  saveImageButtonText: { color: '#fff', fontWeight: '600', fontSize: 13, alignSelf: 'stretch', textAlign: 'center' },
  captureHtmlButton: {
    backgroundColor: '#5a3d8a',
    paddingVertical: 8,
    alignItems: 'center',
  },
  htmlHint: {
    color: '#aaa',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  htmlTextBox: {
    flex: 1,
    margin: 16,
    marginTop: 0,
    padding: 12,
    backgroundColor: '#111',
    color: '#0f0',
    fontFamily: 'monospace',
    fontSize: 11,
    borderRadius: 8,
    textAlignVertical: 'top',
  },
  debugBar: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#fff3cd',
  },
  debugText: { fontSize: 11, color: '#664d03' },
  logModal: { flex: 1, backgroundColor: '#1a1a2e', paddingTop: 50 },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  logTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  logClose: { color: '#e94560', fontSize: 14, fontWeight: '600' },
  logScroll: { flex: 1, paddingHorizontal: 16 },
  logLine: {
    color: '#ddd',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  logClearButton: {
    margin: 16,
    backgroundColor: '#0f3460',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  logClearButtonText: { color: '#fff', fontWeight: '600' },
}));
