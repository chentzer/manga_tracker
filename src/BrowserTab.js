import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Keyboard, Alert, Platform, ToastAndroid } from 'react-native';
import { WebView } from 'react-native-webview';
import { galleryFolderFor } from './gallery';
import { PAUSE_MEDIA_JS } from './MediaWebView';
import { AD_BLOCK_JS, isAdUrl } from './adBlock';
import { TAB_BAR_WATCH_JS } from './tabBarWatch';
import { IMAGE_HOLD_JS, saveHeldPicture } from './imageHold';
import { TAP_SLOP } from './touch';
import { themed, themeColor, useDarkMode } from './theme';

// Turns what was typed in the address bar into a URL to open:
//   "https://x.com/a"  -> as typed (already has a scheme)
//   "example.com/page" -> "https://example.com/page"
//   "some words"       -> a Google search for them
// Returns null for empty input.
export function normalizeAddress(input) {
  const text = (input || '').trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/\s]+\.[a-z]{2,})(:\d+)?(\/.*)?$/i.test(text)) {
    return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

// The site part of a web address, for telling "same site" from "another
// site": the last two parts of the host name (www.example.com and
// m.example.com both -> example.com). null for non-web addresses.
export function siteOf(url) {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url || '');
  if (!match) return null;
  return match[1].toLowerCase().split('.').slice(-2).join('.');
}

// "example.com" from "https://www.example.com/page", for picture names.
function hostnameOf(url) {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url || '');
  return match ? match[1].toLowerCase().replace(/^www\./, '') : '';
}

// How long after a tap on the page (or opening an address yourself) a
// jump to another site is allowed — long enough for the redirects a
// normal link click goes through (e.g. Google's result links).
const USER_NAV_WINDOW_MS = 4000;

// Tells the app whenever you touch the page, so a move to another site
// can be told apart from one the page makes on its own.
const TAP_TRACKER_JS = `
  (function () {
    if (window.__mtTapTracker) return;
    window.__mtTapTracker = true;
    var send = function () {
      try { window.ReactNativeWebView.postMessage('{"type":"userTap"}'); } catch (e) {}
    };
    document.addEventListener('touchstart', send, true);
    document.addEventListener('keydown', send, true);
  })();
  true;
`;

// Plain in-app browser for any site: type a URL (or search words) in the
// address bar and browse. Nothing is recorded here — the Manga, Manhwa
// and Anime tabs do that for their own sites.
//
// Exposes the ref methods App.js uses for the other tabs: goBackIfPossible
// (hardware back), getScreenshotInfo (screenshots keep Android's own name
// here, since a web page has no code; they're filed under
// AniManga Tracker/Browser), pauseMedia and getCurrentUrl (Data saver).
const BrowserTab = forwardRef(function BrowserTab(
  { blockAds = true, onTabBarActivity, initialUrl = null, onPageChange },
  ref
) {
  useDarkMode(); // redraws in the other colours when Dark mode is switched
  const webviewRef = useRef(null);
  // null until the first page is opened. initialUrl: the page this tab
  // was on before Data saver unloaded it (App.js), reopened as it mounts.
  const [source, setSource] = useState(initialUrl ? { uri: initialUrl } : null);
  const [address, setAddress] = useState(initialUrl || '');
  const [editingAddress, setEditingAddress] = useState(false);
  const [nav, setNav] = useState({ url: '', title: '', canGoBack: false, canGoForward: false, loading: false });
  // Until when a jump to another site counts as yours (see USER_NAV_WINDOW_MS).
  const userNavUntil = useRef(0);
  // The last jump to another site (or app) that was stopped, shown in a
  // bar with an "Open" button in case you did want it.
  const [blockedUrl, setBlockedUrl] = useState(null);

  const open = (url) => {
    if (!url) return;
    userNavUntil.current = Date.now() + USER_NAV_WINDOW_MS;
    setBlockedUrl(null);
    Keyboard.dismiss();
    setEditingAddress(false);
    setAddress(url);
    if (url === nav.url && webviewRef.current) webviewRef.current.reload();
    else setSource({ uri: url });
  };

  useImperativeHandle(
    ref,
    () => ({
      goBackIfPossible: () => {
        if (nav.canGoBack && webviewRef.current) {
          webviewRef.current.goBack();
          return true;
        }
        return false;
      },
      getScreenshotInfo: async () => ({ code: null, pageNumber: null, title: nav.title || null, currentTime: null }),
      pauseMedia: () => webviewRef.current?.injectJavaScript(PAUSE_MEDIA_JS),
      // The page on screen, kept by App.js when Data saver unloads this tab.
      getCurrentUrl: () => nav.url || (source && source.uri) || null,
    }),
    [nav, source]
  );

  // Stops pages from sending you to another website on their own —
  // redirects, pop-unders, "you've won" pages. Moving to another site is
  // allowed only within a few seconds of you touching the page or opening
  // an address; anything else is stopped and shown in a bar where you can
  // still open it. Moving around within the same site is never blocked.
  // Links that would open another app are always stopped (as on the other
  // tabs).
  const handleShouldStartLoad = (request) => {
    const { url } = request;
    if (/^(about|data|blob|javascript):/i.test(url)) return true;
    // Known ad networks (adBlock.js) are stopped even after a tap.
    if (blockAds && isAdUrl(url)) {
      setBlockedUrl(url);
      return false;
    }
    if (!/^https?:/i.test(url)) {
      setBlockedUrl(url);
      return false;
    }
    const currentSite = siteOf(nav.url);
    if (!currentSite || siteOf(url) === currentSite || Date.now() < userNavUntil.current) return true;
    setBlockedUrl(url);
    return false;
  };

  const savingPicture = useRef(false);
  const handleMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      return;
    }
    if (message.type === 'tabBar') {
      onTabBarActivity?.(message.kind); // auto-hiding tab row, pull up for Library (App.js)
    } else if (message.type === 'userTap') {
      userNavUntil.current = Date.now() + USER_NAV_WINDOW_MS;
    } else if (message.type === 'holdImage') {
      // Held a finger on a picture (src/imageHold.js): saved to
      // AniManga Tracker/Browser, named "<site>_<time>".
      const toast = (text, long = false) =>
        Platform.OS === 'android' && ToastAndroid.show(text, long ? ToastAndroid.LONG : ToastAndroid.SHORT);
      if (message.error) {
        toast("This picture can't be saved.");
        return;
      }
      if (!message.url && !message.dataUrl) return;
      const pageUrl = nav.url;
      const folder = galleryFolderFor('Browser');
      Alert.alert('Save picture?', `Saves it to your gallery in ${folder}.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: async () => {
            if (savingPicture.current) return;
            savingPicture.current = true;
            try {
              await saveHeldPicture(message, pageUrl, folder, hostnameOf(pageUrl) || 'picture');
              toast(`Saved to ${folder}`);
            } catch (err) {
              if (err.message === 'denied') toast('Allow photo access to save pictures.');
              else toast(`Couldn't save the picture (${err.message}).`, true);
            } finally {
              savingPicture.current = false;
            }
          },
        },
      ]);
    }
  };

  const pageJs = TAP_TRACKER_JS + IMAGE_HOLD_JS + TAB_BAR_WATCH_JS + (blockAds ? AD_BLOCK_JS : '');

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity
          onPress={() => webviewRef.current?.goBack()}
          disabled={!nav.canGoBack}
          style={styles.navButton}
          hitSlop={4}
          accessibilityLabel="Back"
        >
          <Text style={[styles.navText, !nav.canGoBack && styles.navDisabled]}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => webviewRef.current?.goForward()}
          disabled={!nav.canGoForward}
          style={styles.navButton}
          hitSlop={4}
          accessibilityLabel="Forward"
        >
          <Text style={[styles.navText, !nav.canGoForward && styles.navDisabled]}>›</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.address}
          value={editingAddress ? address : nav.url || address}
          onChangeText={setAddress}
          onFocus={() => {
            setEditingAddress(true);
            setAddress(nav.url || address);
          }}
          onBlur={() => setEditingAddress(false)}
          onSubmitEditing={() => open(normalizeAddress(address))}
          placeholder="Type a URL or search"
          placeholderTextColor="#8892b0"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
        />
        <TouchableOpacity
          onPress={() => (nav.loading ? webviewRef.current?.stopLoading() : webviewRef.current?.reload())}
          disabled={!source}
          style={styles.navButton}
          hitSlop={4}
          accessibilityLabel={nav.loading ? 'Stop loading' : 'Reload'}
        >
          <Text style={[styles.navTextSmall, !source && styles.navDisabled]}>{nav.loading ? '✕' : '⟳'}</Text>
        </TouchableOpacity>
      </View>

      {blockedUrl ? (
        <View style={styles.blockedBar}>
          <Text style={styles.blockedText} numberOfLines={2}>
            {blockAds && isAdUrl(blockedUrl)
              ? 'Blocked an ad at'
              : /^https?:/i.test(blockedUrl)
              ? 'Stopped a redirect to'
              : 'Stopped opening another app:'}{' '}
            {blockedUrl}
          </Text>
          {/^https?:/i.test(blockedUrl) ? (
            <TouchableOpacity
              onPress={() => {
                const url = blockedUrl;
                setBlockedUrl(null);
                open(url);
              }}
              hitSlop={TAP_SLOP}
            >
              <Text style={styles.blockedAction}>Open</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => setBlockedUrl(null)} hitSlop={TAP_SLOP} accessibilityLabel="Dismiss">
            <Text style={styles.blockedAction}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {source ? (
        <WebView
          ref={webviewRef}
          source={source}
          style={styles.webview}
          onNavigationStateChange={(state) => {
            setNav({
              url: state.url,
              title: state.title,
              canGoBack: state.canGoBack,
              canGoForward: state.canGoForward,
              loading: state.loading,
            });
            if (/^https?:/i.test(state.url || '')) onPageChange?.(state.url);
          }}
          // '*' sends every address (including other apps' links) through
          // handleShouldStartLoad instead of straight to Android.
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onMessage={handleMessage}
          injectedJavaScriptBeforeContentLoaded={pageJs}
          injectedJavaScript={pageJs}
          // Links that would open a new window load here instead, if
          // allowed (same rules as any other page). Multiple windows stay
          // on: turning them off lets embedded frames take over the page
          // (CVE-2020-6506, per the react-native-webview docs).
          setSupportMultipleWindows={true}
          onOpenWindow={(event) => {
            const url = event.nativeEvent.targetUrl;
            if (url && handleShouldStartLoad({ url })) open(url);
          }}
          allowsInlineMediaPlayback
          allowsFullscreenVideo
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Browser</Text>
          <Text style={styles.emptyText}>
            Type a web address or search words in the bar above. Pages here aren't added to your Library — open a title
            in the Manga, Manhwa or Anime tab for that.
          </Text>
        </View>
      )}
    </View>
  );
});

export default BrowserTab;

const styles = themed(StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#16213e',
  },
  navButton: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 26, lineHeight: 28, color: '#fff' },
  navTextSmall: { fontSize: 18, color: '#fff' },
  navDisabled: { color: '#4a5578' },
  address: {
    flex: 1,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 19,
    backgroundColor: '#0f1a33',
    borderWidth: 1,
    borderColor: '#2a3a5e',
    fontSize: 14,
    color: '#fff',
  },
  webview: { flex: 1 },
  blockedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#3a2a10',
  },
  blockedText: { flex: 1, fontSize: 12, color: '#f5d9a8' },
  blockedAction: { fontSize: 14, fontWeight: '700', color: '#fff' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#fff', marginBottom: 10 },
  emptyText: { fontSize: 15, lineHeight: 23, color: '#8892b0', textAlign: 'center' },
}));
