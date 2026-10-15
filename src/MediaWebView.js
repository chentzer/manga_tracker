import React, { useRef, useCallback, useState, useEffect } from 'react';
import { View, StyleSheet, TextInput, TouchableOpacity, Text, Keyboard, Modal, ScrollView, BackHandler } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import { entryExists, insertEntry, markSynced, markSyncFailed } from './db';
import { uploadImageToDrive, buildDriveDisplayName } from './GoogleDriveService';
import { maybeBackupLibraryToDrive } from './backup';
import { suppressNextRelock } from './relockGuard';
import ReverseSearch from './ReverseSearch';
import { TAB_BAR_WATCH_JS } from './tabBarWatch';

// Which optional controls to show (Settings → Buttons). Each also needs
// the type to support it: buildUrlFromId/sources for the code box,
// reverseSearch and savePageImage in mediaTypes.js.
const ALL_BUTTONS = { codeSearch: true, reverseSearch: true, savePageImage: true };

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
// Listens at the document level (bubbling phase) rather than attaching
// directly to the <video> element — most players wrap the raw <video>
// in their own overlay/controls layer that sits on top and intercepts
// clicks itself, so a listener on <video> directly can simply never
// receive anything (this was the actual cause of double-tap seeming to
// do nothing at all on at least one real player). Delegating to
// document and checking the click's position against the nearest
// <video>'s bounding box works regardless of what's layered on top,
// as long as the click isn't fully swallowed via stopPropagation
// before it bubbles up — which most players don't do for a plain tap.
//
// Uses plain 'click' (not touch events directly) since mixing both
// would double-count a single tap as two, throwing off the double-tap
// timing detection.
//
// Some players bind their own double-click handler (commonly for
// toggling fullscreen — a known real-world case on some sites),
// which fires as a genuinely separate native "dblclick" event
// alongside our own two-click timing detection, meaning a double-tap
// could seek AND toggle fullscreen at once. Fixed by also listening
// for "dblclick" at the document level in the CAPTURING phase and
// calling stopPropagation() — capture-phase listeners run before a
// bubble-phase listener further down the tree (which is how a
// player's own handler is presumably attached), so this reliably
// intercepts it before the player ever sees the event.
function buildDoubleTapSeekJs(seconds) {
  return `
    (function() {
      if (window.__mangaTrackerSeekInstalled) return;
      window.__mangaTrackerSeekInstalled = true;

      var DOUBLE_TAP_MS = 300;
      var SEEK_SECONDS = ${seconds};
      var lastTapTime = 0;

      // Finds whichever <video> the click actually landed within,
      // even if the click's real target was an overlay/controls
      // element layered on top of it rather than the <video> itself.
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

      document.addEventListener('click', function(e) {
        var video = findVideoUnderPoint(e.clientX, e.clientY);
        if (!video) return;

        var now = Date.now();
        var isDoubleTap = (now - lastTapTime) < DOUBLE_TAP_MS;
        // Reset after a successful double-tap so a third tap shortly
        // after doesn't immediately chain into another seek.
        lastTapTime = isDoubleTap ? 0 : now;
        if (!isDoubleTap) return;

        var rect = video.getBoundingClientRect();
        var isLeftHalf = (e.clientX - rect.left) < (rect.width / 2);
        var duration = video.duration || Infinity;
        if (isLeftHalf) {
          video.currentTime = Math.max(0, video.currentTime - SEEK_SECONDS);
        } else {
          video.currentTime = Math.min(duration, video.currentTime + SEEK_SECONDS);
        }
      });

      // Blocks the player's own native double-click behavior (e.g.
      // fullscreen toggle) from firing alongside our seek above, for
      // the same "click landed over a video" area.
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
function getHostname(url) {
  if (!url) return null;
  const match = url.match(/^https?:\/\/([^/]+)/i);
  return match ? match[1].toLowerCase().replace(/^www\./, '') : null;
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
  return match ? { source: config, match } : null;
}

// All domains considered "safe to navigate to" for this type — every
// source's domain for a multi-source type, or just the single
// startUrl's domain otherwise. Used by the external-navigation blocker.
function getAllowedDomains(config) {
  if (config.sources) {
    return config.sources.map((s) => s.domain);
  }
  const host = getHostname(config.startUrl);
  return host ? [host] : [];
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
export default function MediaWebView({
  config,
  isSignedInToGoogle,
  showDebugTools,
  onViewInLibrary,
  buttons = ALL_BUTTONS,
  onTabBarActivity,
}) {
  const webviewRef = useRef(null);
  // The Reverse button's search window (ReverseSearch.js).
  const [reverseVisible, setReverseVisible] = useState(false);
  // Latest onTabBarActivity, for handleMessage (which isn't re-created
  // every time App.js passes a new function).
  const tabBarActivityRef = useRef(onTabBarActivity);
  tabBarActivityRef.current = onTabBarActivity;
  const pendingSourceId = useRef(null);
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
  const [manualCode, setManualCode] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
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

  const handleManualSubmit = useCallback(() => {
    const code = manualCode.trim();
    if (!code) return;

    // Duplicate check happens before navigating anywhere — a duplicate
    // code is silently ignored rather than re-fetching/re-saving it.
    if (entryExists(code, config.key)) {
      setManualCode('');
      Keyboard.dismiss();
      return;
    }

    const url = config.buildUrlFromId(code);
    webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
    setManualCode('');
    Keyboard.dismiss();
  }, [manualCode, config]);

  // Strips everything but letters/digits and lowercases, for comparing
  // a searched-for code against a candidate result's extracted id —
  // codes are written inconsistently across sites/queries ("ABC-123"
  // vs "abc123"), so hyphens/case shouldn't matter for the comparison.
  function normalizeCode(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Cross-site fallback search for multi-source types (e.g. otherCategory):
  // tries each configured source's search URL in priority order via a
  // plain app-level fetch (not the webview — this needs to inspect raw
  // HTML from multiple sites without navigating away from whichever
  // page is currently showing), and navigates the webview to the first
  // genuinely matching result found. A "candidate result" is any link
  // on that search results page matching the source's own urlRegex —
  // deliberately reusing the same pattern used to recognize a genuine
  // content page while browsing normally, so there's only one place
  // per source that defines what a valid video URL looks like. Each
  // candidate is then double-checked against the actual searched code
  // (via normalizeCode, allowing a suffix like "-extended" to
  // follow the real code) rather than trusted outright — some sites'
  // search is fuzzy/broad rather than exact and can return a
  // completely different code that just happens to share a number
  // (e.g. searching "ABC-123" returning "XYZ-123").
  const handleSearchSubmit = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query || !config.sources) return;
    Keyboard.dismiss();
    setSearching(true);
    logDebug(`Searching for "${query}" across ${config.sources.length} sites…`);
    const normalizedQuery = normalizeCode(query);

    try {
      for (const source of config.sources) {
        const searchUrl = source.buildSearchUrl(query);
        try {
          const res = await fetch(searchUrl);
          const html = await res.text();
          const hrefRegex = /href="([^"]+)"/g;
          let hrefMatch;
          let foundUrl = null;
          while ((hrefMatch = hrefRegex.exec(html)) !== null) {
            const href = hrefMatch[1];
            const idMatch = href.match(source.urlRegex);
            if (!idMatch) continue;
            const candidateId = normalizeCode(source.extractId(idMatch));
            if (candidateId.indexOf(normalizedQuery) === 0) {
              foundUrl = href;
              break;
            }
          }
          if (foundUrl) {
            logDebug(`Found on ${source.name}: ${foundUrl}`);
            webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(foundUrl)}; true;`);
            setSearchQuery('');
            return;
          }
          logDebug(`Not found on ${source.name}, trying next…`);
        } catch (err) {
          logDebug(`Search on ${source.name} failed: ${err.message}`);
        }
      }
      logDebug(`"${query}" not found on any configured site.`);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, config, logDebug]);

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
      if (entryExists(sourceId, config.key)) {
        logDebug(`Matched ${sourceId} — already recorded, skipping.`);
        setCurrentEntryKey(`${config.key}:${sourceId}`);
        return;
      }
      setCurrentEntryKey(null);
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
    [config, logDebug]
  );

  const handleNavigationStateChange = useCallback(
    (navState) => {
      currentUrlRef.current = navState.url;
      setCanGoBack(navState.canGoBack);
      // navState fires multiple times per navigation (start, in-progress,
      // finish). Extracting on the first ("start") event queries a page
      // that hasn't actually loaded yet — still the old content or blank
      // — which returns null meta tags and gets an entry saved with no
      // thumbnail. Only extract once loading has actually finished.
      if (navState.loading) return;
      checkUrlAndExtract(navState.url);
    },
    [checkUrlAndExtract]
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
  const handleShouldStartLoad = useCallback(
    (request) => {
      if (config.blockedUrlPatterns && config.blockedUrlPatterns.some((p) => p.test(request.url))) {
        return false;
      }
      if (!config.blockExternalNavigation) return true;
      const requestHostname = getHostname(request.url);
      // Also allow non-http(s) schemes (e.g. about:blank, data:) through
      // untouched — getHostname returns null for those, and blocking
      // them tends to break legitimate in-page behavior for no reason.
      if (!requestHostname) return true;
      return allowedDomains.some(
        (domain) => requestHostname === domain || requestHostname.endsWith(`.${domain}`)
      );
    },
    [config, allowedDomains]
  );

  // Android hardware back button: go back in the webview's own history
  // (previous manga page, previous search results, etc) instead of the
  // default behavior of closing the app entirely. Only intercepts when
  // there's actually somewhere to go back to — otherwise falls through
  // to the default (letting the app close/navigate away normally).
  useEffect(() => {
    const onBackPress = () => {
      if (canGoBack && webviewRef.current) {
        webviewRef.current.goBack();
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [canGoBack]);

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
      if (payload.type === 'urlchange') {
        checkUrlAndExtract(payload.url);
        return;
      }

      // Scrolling / pull-at-top, for the auto-hiding tab row (App.js).
      if (payload.type === 'tabBar') {
        tabBarActivityRef.current?.(payload.kind);
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
            fileNameBase = pageNumber ? `${code} -- ${pageNumber}` : code;
          }

          const tempPath = `${FileSystem.cacheDirectory}${fileNameBase}.jpg`;
          await FileSystem.downloadAsync(payload.imageUrl, tempPath, {
            headers: currentUrlRef.current ? { Referer: currentUrlRef.current } : undefined,
          });
          await MediaLibrary.saveToLibraryAsync(tempPath);
          logDebug(`Saved current page image to your photo gallery as "${fileNameBase}".`);
        } catch (err) {
          logDebug(`Save image FAILED: ${err.message}`);
        }
        return;
      }

      const sourceId = pendingSourceId.current;
      if (!sourceId) return;

      const pageUrl = pendingPageUrl.current;

      // Re-check right before writing, closing the gap between the
      // nav-state check and this async step.
      if (entryExists(sourceId, config.key)) {
        pendingSourceId.current = null;
        pendingPageUrl.current = null;
        inFlightSourceIds.current.delete(sourceId);
        return;
      }

      // extractMetadataJs can decline a page that matches urlRegex but
      // doesn't carry the details (e.g. a manga reader page with no
      // cover) by posting { skip: '<reason>' }; the entry gets recorded
      // from a page that does.
      if (payload.skip) {
        logDebug(`Matched ${sourceId} — ${payload.skip}, not recording from this page.`);
        pendingSourceId.current = null;
        pendingPageUrl.current = null;
        inFlightSourceIds.current.delete(sourceId);
        return;
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
        insertEntry({
          sourceId,
          mediaType: config.key,
          title: payload.title,
          altTitle: payload.altTitle,
          author: payload.author,
          sourceUrl: pageUrl,
          localImagePath: localPath,
        });
        logDebug(
          `Saved ${sourceId}${localPath ? ' with thumbnail' : ' (no thumbnail)'} — title: ${payload.title || '(none)'}${payload.altTitle ? ` — alt title: ${payload.altTitle}` : ''} — author: ${payload.author || '(none)'}`
        );
        setCurrentEntryKey(`${config.key}:${sourceId}`);
        maybeBackupLibraryToDrive().then((result) => {
          if (!result.attempted) return; // Drive not connected — nothing to report
          logDebug(
            result.success
              ? 'Auto-backup: library-backup.csv updated on Drive.'
              : `Auto-backup FAILED: ${result.error}`
          );
        });

        if (isSignedInToGoogle && localPath) {
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
        pendingSourceId.current = null;
        pendingPageUrl.current = null;
        inFlightSourceIds.current.delete(sourceId);
      }
    },
    [config, isSignedInToGoogle, checkUrlAndExtract, logDebug]
  );

  const reverseButton =
    !config.reverseSearch || !config.buildUrlFromId || !buttons.reverseSearch ? null : (
      <TouchableOpacity style={[styles.manualButton, styles.secondaryButton]} onPress={() => setReverseVisible(true)}>
        <Text style={styles.manualButtonText}>Reverse</Text>
      </TouchableOpacity>
    );

  // A reverse-search result: open that code (and page, if the result
  // was a single page) in this tab.
  const handleReverseResult = (code, page) => {
    setReverseVisible(false);
    const url = config.buildUrlFromId(code) + (page ? `${page}/` : '');
    logDebug(`Reverse search: opening ${code}${page ? ` page ${page}` : ''}`);
    webviewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
  };

  // The code box can be hidden in Settings; the bar stays for any buttons
  // still shown.
  const showCodeBar = buttons.codeSearch || reverseButton;

  return (
    <View style={styles.container}>
      {config.buildUrlFromId && showCodeBar ? (
        <View style={[styles.manualBar, !buttons.codeSearch && styles.manualBarButtonsOnly]}>
          {buttons.codeSearch ? (
            <>
              <TextInput
                style={styles.manualInput}
                placeholder={`Enter ${config.label} code…`}
                placeholderTextColor="#999"
                value={manualCode}
                onChangeText={setManualCode}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="default"
                returnKeyType="go"
                onSubmitEditing={handleManualSubmit}
              />
              <TouchableOpacity style={styles.manualButton} onPress={handleManualSubmit}>
                <Text style={styles.manualButtonText}>Add</Text>
              </TouchableOpacity>
            </>
          ) : null}
          {reverseButton}
        </View>
      ) : null}
      {config.sources && buttons.codeSearch ? (
        <View style={styles.manualBar}>
          <TextInput
            style={styles.manualInput}
            placeholder={`Search code across ${config.sources.length} sites…`}
            placeholderTextColor="#999"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="default"
            returnKeyType="search"
            onSubmitEditing={handleSearchSubmit}
            editable={!searching}
          />
          <TouchableOpacity style={styles.manualButton} onPress={handleSearchSubmit} disabled={searching}>
            <Text style={styles.manualButtonText}>{searching ? '…' : 'Search'}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {reverseButton ? (
        <ReverseSearch
          visible={reverseVisible}
          config={config}
          onClose={() => setReverseVisible(false)}
          onOpenCode={handleReverseResult}
        />
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
        source={{ uri: config.startUrl }}
        onNavigationStateChange={handleNavigationStateChange}
        onShouldStartLoadWithRequest={handleShouldStartLoad}
        onMessage={handleMessage}
        // Prevents window.open()-based popups from opening a second
        // webview/window at all — combined with onShouldStartLoadWithRequest
        // above, this covers both common ad-popup mechanisms.
        setSupportMultipleWindows={false}
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
          TAB_BAR_WATCH_JS
        }
        // The tab-row watcher again once the page has loaded, since Android
        // doesn't always run the script above (it only runs once per page).
        injectedJavaScript={TAB_BAR_WATCH_JS}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  manualBar: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: '#16213e',
    gap: 8,
  },
  manualInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  manualButton: {
    backgroundColor: '#e94560',
    borderRadius: 6,
    paddingHorizontal: 14,
    minHeight: 34,
    justifyContent: 'center',
  },
  manualButtonText: { color: '#fff', fontWeight: '600' },
  secondaryButton: { backgroundColor: '#1f4068' },
  // Code box hidden in Settings: just the buttons, on the right.
  manualBarButtonsOnly: { justifyContent: 'flex-end' },
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
  saveImageButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
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
});
