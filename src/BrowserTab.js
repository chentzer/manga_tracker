import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  Alert,
  Platform,
  Modal,
  ScrollView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { showToast } from './toast';
import { VIDEO_GESTURES_JS } from './videoGestures';
import { galleryFolderFor } from './gallery';
import { PAUSE_MEDIA_JS, getTabSites } from './MediaWebView';
import { MEDIA_TYPE_LIST } from './mediaTypes';
import { loadCustomSites } from './customSites';
import { getBookmarks } from './db';
import { addBookmark, renameBookmark, removeBookmark, onBookmarksSynced } from './bookmarks';
import { offerUndo } from './undo';
import { AD_BLOCK_JS, isAdUrl } from './adBlock';
import { TAB_BAR_WATCH_JS } from './tabBarWatch';
import { IMAGE_HOLD_JS, saveHeldPicture, getHoldToSave } from './imageHold';
import { TAP_SLOP } from './touch';
import { KeyboardPad } from './keyboard';
import { tourTarget } from './Tour';
import PageError from './PageError';
import Icon from './Icon';
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
  { blockAds = true, holdToSave = true, onTabBarActivity, initialUrl = null, onPageChange, onOpenSite },
  ref
) {
  useDarkMode(); // redraws in the other colours when Dark mode is switched
  const webviewRef = useRef(null);
  // null until the first page is opened. initialUrl: the page this tab
  // was on before Data saver unloaded it (App.js), reopened as it mounts.
  const [source, setSource] = useState(initialUrl ? { uri: initialUrl } : null);
  // 🏠 The home page (the first page): every tab's sites and your
  // bookmarks. The open page stays loaded behind it, so Back returns to it.
  const [home, setHome] = useState(!initialUrl);
  const [homeBookmarks, setHomeBookmarks] = useState(() => getBookmarks());
  // 🔖 Bookmarks: pages to come back to. null while the list is closed;
  // editingBookmark: { uid, title } being renamed. menuOpen: the ⋮ menu.
  const [bookmarks, setBookmarks] = useState(null);
  const [editingBookmark, setEditingBookmark] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    setHome(false);
    // A page is open now: the bars can start counting to hide (App.js).
    onTabBarActivity?.('scroll');
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
        if (home && source) {
          leaveHome();
          return true;
        }
        if (!home && nav.canGoBack && webviewRef.current) {
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
    [nav, source, home]
  );

  // Bookmarks changed on another device (src/bookmarks.js).
  useEffect(() => onBookmarksSynced(() => setHomeBookmarks(getBookmarks())), []);

  const goHome = () => {
    Keyboard.dismiss();
    setEditingAddress(false);
    setBlockedUrl(null);
    webviewRef.current?.injectJavaScript(PAUSE_MEDIA_JS);
    setHomeBookmarks(getBookmarks());
    setHome(true);
    // The bars come back and stay while home is shown (App.js).
    onTabBarActivity?.('pullTop');
  };

  // Back to the page behind the home page.
  const leaveHome = () => {
    setHome(false);
    onTabBarActivity?.('scroll');
  };

  const bookmarksChanged = () => {
    setBookmarks((list) => (list ? getBookmarks() : list));
    setHomeBookmarks(getBookmarks());
  };
  const showBookmarks = () => {
    setEditingBookmark(null);
    setBookmarks(getBookmarks());
  };
  const bookmarkHere = bookmarks && nav.url && !home ? bookmarks.find((b) => b.url === nav.url) : null;
  const addThisPage = () => {
    addBookmark(nav.title || hostnameOf(nav.url), nav.url);
    bookmarksChanged();
  };
  // Removed at once, with Undo.
  const dropBookmark = (b) => {
    removeBookmark(b.uid);
    bookmarksChanged();
    offerUndo({
      message: 'Bookmark removed',
      commit: () => {},
      undo: () => {
        removeBookmark(b.uid, false);
        bookmarksChanged();
      },
    });
  };
  const saveBookmarkName = () => {
    renameBookmark(editingBookmark.uid, editingBookmark.title);
    setEditingBookmark(null);
    bookmarksChanged();
  };

  // The home page's sites, by tab: each tab's own (its site list) and
  // yours from Settings → Sites. Tapping one opens it in its tab.
  const homeSites = MEDIA_TYPE_LIST.map((m) => {
    const own = getTabSites(m);
    const sites = own.length ? own.map((x) => ({ name: x.name, url: x.homeUrl })) : [{ name: m.siteName || m.label, url: m.startUrl }];
    loadCustomSites()
      .filter((c) => c.type === m.key)
      .forEach((c) => sites.push({ name: c.domain, url: `https://${c.domain}/` }));
    return { key: m.key, label: m.label, sites: sites.filter((x) => x.url) };
  }).filter((t) => t.sites.length);

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
    } else if (message.type === 'holdImage' && getHoldToSave()) {
      // Held a finger on a picture (src/imageHold.js): saved to
      // AniManga Tracker/Browser, named "<site>_<time>".
      const toast = (text, long = false) =>
        Platform.OS === 'android' && showToast(text, long);
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

  const pageJs = TAP_TRACKER_JS + VIDEO_GESTURES_JS + (holdToSave ? IMAGE_HOLD_JS : '') + TAB_BAR_WATCH_JS + (blockAds ? AD_BLOCK_JS : '');

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TouchableOpacity
          ref={tourTarget('browser.home')}
          onPress={goHome}
          disabled={home}
          style={styles.navButton}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Home"
          accessibilityState={{ disabled: home }}
        >
          <Icon name="home-outline" size={24} color={home ? '#ff7a90' : '#ffffff'} />
        </TouchableOpacity>
        <TextInput
          ref={tourTarget('browser.address')}
          style={styles.address}
          value={editingAddress ? address : home ? '' : nav.url || address}
          onChangeText={setAddress}
          onFocus={() => {
            setEditingAddress(true);
            setAddress(home ? '' : nav.url || address);
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
          accessibilityLabel="Address"
        />
        <TouchableOpacity
          ref={tourTarget('browser.menu')}
          onPress={() => setMenuOpen(true)}
          style={styles.navButton}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="More: back, forward, reload, bookmarks"
        >
          <Icon name="dots-vertical" size={24} color="#ffffff" />
        </TouchableOpacity>
      </View>

      {/* ⋮: Back, Forward, Reload and Bookmarks (the phone's Back goes back a page too). */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity
          style={styles.menuBackdrop}
          activeOpacity={1}
          onPress={() => setMenuOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        >
          <View style={styles.menu}>
            {[
              {
                icon: 'arrow-left',
                label: 'Back',
                disabled: home ? !source : !nav.canGoBack,
                run: () => (home ? leaveHome() : webviewRef.current?.goBack()),
              },
              { icon: 'arrow-right', label: 'Forward', disabled: home || !nav.canGoForward, run: () => webviewRef.current?.goForward() },
              {
                icon: nav.loading ? 'close' : 'reload',
                label: nav.loading ? 'Stop loading' : 'Reload',
                disabled: !source || home,
                run: () => (nav.loading ? webviewRef.current?.stopLoading() : webviewRef.current?.reload()),
              },
              { icon: 'bookmark-outline', label: 'Bookmarks', disabled: false, run: showBookmarks },
            ].map((item) => (
              <TouchableOpacity
                key={item.label}
                style={styles.menuItem}
                disabled={item.disabled}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: item.disabled }}
                onPress={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                <Text style={[styles.menuText, item.disabled && styles.navDisabled]}>
                  <Icon name={item.icon} size={18} />
                  {'  '}
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

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
            <Text style={styles.blockedAction}>
              <Icon name="close" size={18} />
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {source ? (
        <WebView
          ref={webviewRef}
          source={source}
          style={styles.webview}
          containerStyle={home ? styles.hiddenPage : null}
          // For the auto-hiding bars (App.js): they stay up until a page
          // has loaded, since only a loaded page can bring them back.
          onLoadStart={() => onTabBarActivity?.('loading')}
          onLoad={() => onTabBarActivity?.('loaded')}
          onError={() => onTabBarActivity?.('error')}
          renderError={(domain, code, description) => (
            <PageError description={description} onRetry={() => webviewRef.current?.reload()} />
          )}
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
      ) : null}
      {home || !source ? (
        <ScrollView style={styles.home} contentContainerStyle={styles.homeContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.emptyTitle}>Browser</Text>
          <Text style={styles.emptyText}>
            Type a web address or search words in the bar above. Pages here aren't added to your Library — open a title
            in the Manga, Manhwa or Anime tab for that. ⋮ → Bookmarks keeps any page to come back to.
          </Text>
          {source && nav.url ? (
            <TouchableOpacity accessibilityRole="button" style={styles.returnRow} onPress={leaveHome}>
              <Text style={styles.returnText} numberOfLines={1}>
                ‹ Back to {nav.title || hostnameOf(nav.url)}
              </Text>
            </TouchableOpacity>
          ) : null}
          <Text style={styles.homeHeading}>Sites</Text>
          {homeSites.map((t) => (
            <View key={t.key} style={styles.homeTab}>
              <Text style={styles.homeTabLabel}>{t.label}</Text>
              <View style={styles.homeSites}>
                {t.sites.map((x) => (
                  <TouchableOpacity
                    key={x.url}
                    style={styles.siteChip}
                    onPress={() => (onOpenSite ? onOpenSite(t.key, x.url) : open(x.url))}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${x.name} in ${t.label}`}
                  >
                    <Text style={styles.siteChipText}>{x.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          <Text style={styles.homeHeading}>Bookmarks</Text>
          {homeBookmarks.length === 0 ? (
            <Text style={styles.homeHint}>None yet. Open a page, then ⋮ → Bookmarks → Bookmark this page.</Text>
          ) : (
            homeBookmarks.map((b) => (
              <TouchableOpacity accessibilityRole="button" key={b.uid} style={styles.bookmarkRow} onPress={() => open(b.url)}>
                <View style={styles.bookmarkText}>
                  <Text style={styles.bookmarkTitle} numberOfLines={1}>
                    {b.title || hostnameOf(b.url)}
                  </Text>
                  <Text style={styles.bookmarkUrl} numberOfLines={1}>
                    {b.url}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      ) : null}

      <Modal visible={!!bookmarks} transparent animationType="fade" onRequestClose={() => setBookmarks(null)}>
        <KeyboardPad style={styles.overlay}>
          <View style={styles.sheet}>
            {bookmarks ? (
              <>
                <Text style={styles.sheetTitle}>Bookmarks</Text>
                {nav.url && !home ? (
                  bookmarkHere ? (
                    <View style={styles.bookmarkHere}>
                      <Text style={styles.sheetHint}>
                        <Icon name="star" size={14} /> This page is bookmarked.
                      </Text>
                      <TouchableOpacity accessibilityRole="button" style={styles.textButton} onPress={() => dropBookmark(bookmarkHere)}>
                        <Text style={styles.removeText}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity accessibilityRole="button" style={styles.addBookmarkButton} onPress={addThisPage}>
                      <Text style={styles.addBookmarkText}>
                        <Icon name="star-outline" size={16} /> Bookmark this page
                      </Text>
                    </TouchableOpacity>
                  )
                ) : null}
                <ScrollView style={styles.bookmarkList} keyboardShouldPersistTaps="handled">
                  {bookmarks.length === 0 ? (
                    <Text style={styles.sheetHint}>No bookmarks yet. Open a page, then ⋮ → Bookmarks → Bookmark this page.</Text>
                  ) : (
                    bookmarks.map((b) =>
                      editingBookmark && editingBookmark.uid === b.uid ? (
                        <View key={b.uid} style={styles.bookmarkRow}>
                          <TextInput
                            style={styles.bookmarkInput}
                            value={editingBookmark.title}
                            onChangeText={(title) => setEditingBookmark((e) => ({ ...e, title }))}
                            autoFocus
                            onSubmitEditing={saveBookmarkName}
                            accessibilityLabel="Bookmark name"
                          />
                          <TouchableOpacity accessibilityRole="button" style={styles.textButton} onPress={saveBookmarkName}>
                            <Text style={styles.blockedAction}>Done</Text>
                          </TouchableOpacity>
                        </View>
                      ) : (
                        <TouchableOpacity
                          accessibilityRole="button"
                          key={b.uid}
                          style={styles.bookmarkRow}
                          onPress={() => {
                            setBookmarks(null);
                            open(b.url);
                          }}
                          onLongPress={() => setEditingBookmark({ uid: b.uid, title: b.title || '' })}
                        >
                          <View style={styles.bookmarkText}>
                            <Text style={styles.bookmarkTitle} numberOfLines={1}>
                              {b.title || hostnameOf(b.url)}
                            </Text>
                            <Text style={styles.bookmarkUrl} numberOfLines={1}>
                              {b.url}
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={styles.textButton}
                            onPress={() => dropBookmark(b)}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove bookmark ${b.title || b.url}`}
                          >
                            <Text style={styles.removeText}>
                              <Icon name="close" size={18} />
                            </Text>
                          </TouchableOpacity>
                        </TouchableOpacity>
                      )
                    )
                  )}
                </ScrollView>
                {bookmarks.length > 0 ? <Text style={styles.sheetHint}>Hold a bookmark to rename it.</Text> : null}
                <TouchableOpacity accessibilityRole="button" onPress={() => setBookmarks(null)} style={styles.closeButton}>
                  <Text style={styles.closeText}>Close</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </KeyboardPad>
      </Modal>
    </View>
  );
});

export default BrowserTab;

const styles = themed(StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#1d1f20',
  },
  navButton: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 26, lineHeight: 28, color: '#fff' },
  navTextSmall: { fontSize: 22, color: '#fff' },
  navDisabled: { color: '#4a5578' },
  address: {
    flex: 1,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 24,
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
  hiddenPage: { display: 'none' },
  home: { flex: 1, backgroundColor: '#121212' },
  homeContent: { padding: 20, paddingBottom: 40 },
  homeHeading: { fontSize: 22, fontWeight: '700', color: '#ffffff', marginTop: 20, marginBottom: 8 },
  homeHint: { fontSize: 14, color: '#b8c0dc' },
  homeTab: { marginBottom: 10 },
  homeTabLabel: { fontSize: 14, fontWeight: '700', color: '#b8c0dc', marginBottom: 6 },
  homeSites: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  siteChip: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: '#1d1f20',
    borderWidth: 1,
    borderColor: '#666',
    justifyContent: 'center',
  },
  siteChipText: { fontSize: 16, fontWeight: '600', color: '#ffffff' },
  returnRow: { minHeight: 48, justifyContent: 'center', marginTop: 12 },
  returnText: { fontSize: 16, fontWeight: '700', color: '#8fb3ff' },
  bookmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#4a5578',
  },
  bookmarkText: { flex: 1, paddingVertical: 6 },
  bookmarkTitle: { fontSize: 16, fontWeight: '600', color: '#ffffff' },
  bookmarkUrl: { fontSize: 14, color: '#b8c0dc' },
  menuBackdrop: { flex: 1, alignItems: 'flex-end', paddingTop: 100, paddingRight: 8 },
  menu: { backgroundColor: '#1d1f20', borderRadius: 8, paddingVertical: 4, minWidth: 200, elevation: 8 },
  menuItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 },
  menuText: { fontSize: 16, color: '#ffffff' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#1d1f20', borderRadius: 12, padding: 20, maxHeight: '90%' },
  sheetTitle: { fontSize: 22, fontWeight: '700', color: '#ffffff', marginBottom: 6 },
  sheetHint: { fontSize: 14, color: '#b8c0dc', marginVertical: 6 },
  bookmarkHere: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bookmarkList: { maxHeight: 360, marginTop: 8 },
  bookmarkInput: {
    flex: 1,
    marginRight: 8,
    minHeight: 48,
    color: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#666',
    fontSize: 16,
  },
  addBookmarkButton: {
    alignSelf: 'flex-start',
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#d62f4b',
  },
  addBookmarkText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  textButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  removeText: { color: '#ff7468', fontSize: 16, fontWeight: '700' },
  closeButton: { alignSelf: 'flex-end', minHeight: 48, minWidth: 64, justifyContent: 'center', alignItems: 'center', marginTop: 12 },
  closeText: { color: '#b8c0dc', fontSize: 16, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 10 },
  emptyText: { fontSize: 16, lineHeight: 23, color: '#8892b0', textAlign: 'center' },
}));
