import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
  BackHandler,
  Modal,
  Switch,
  ScrollView,
  LayoutAnimation,
  Platform,
  ToastAndroid,
  AppState,
  Linking,
} from 'react-native';
import { addScreenshotListener } from 'expo-screen-capture';
import { getPermissionsAsync, requestPermissionsAsync } from 'expo-media-library';
import { useShareIntent } from 'expo-share-intent';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initDb, getSetting, setSetting, addNote } from './src/db';
import MediaWebView from './src/MediaWebView';
import EntryList from './src/EntryList';
import { signInToGoogle, restoreGoogleSession } from './src/GoogleDriveService';
import { maybeBackupLibraryToDrive, uploadPendingImages, restoreFromDriveBackup, countPendingImages } from './src/backup';
import SyncStatusPill from './src/SyncStatusPill';
import Notepad from './src/Notepad';
import { syncNotepadToDrive } from './src/notepadSync';
import { beginSync } from './src/syncStatus';
import { exportMalList, pickAndImportMalList, MAL_LISTS } from './src/malList';
import {
  DATA_SAVER_DEFAULTS,
  dataSaverSetting,
  driveSyncAllowed,
  isOnMobileData,
  onUnmetered,
  startNetworkWatch,
  takeDriveSyncDeferred,
} from './src/dataSaver';
import { MEDIA_TYPE_LIST } from './src/mediaTypes';
import AppLock, { useAppLockSetting } from './src/AppLock';
import { galleryFolderFor } from './src/gallery';
import { fileScreenshot, buildGalleryFileName } from './src/screenshots';
import { suppressNextRelock, isRelockSuppressed } from './src/relockGuard';

// Tabs = one per media type (from config, so this never needs manual
// updates when a type is added) + a unified library at the end.
// Browsing tabs (everything but the Library), for Data saver's tab loading.
const SITE_TAB_KEYS = MEDIA_TYPE_LIST.map((m) => m.key);

const TABS = [...MEDIA_TYPE_LIST.map((m) => ({ key: m.key, label: m.label })), { key: 'library', label: 'Library' }];

export default function App() {
  // Bumped whenever a note arrives via the share sheet, so an already
  // open Notepad reloads its list.
  const [notepadRefreshKey, setNotepadRefreshKey] = useState(0);
  // Text/links selected in another app and shared here via Android's
  // share sheet. Handled up here, OUTSIDE AppLock, so saving never needs
  // an unlock: AppLock renders only the lock screen until unlocked, so
  // anything inside it can't run yet. Shares always go to the Inbox —
  // choosing a specific note would mean showing note titles to whoever
  // is holding a locked phone; items get moved to a note in-app instead.
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  // The database is ready before the share effect below runs, even for a
  // share that cold-launches the app: AppLock calls initDb during its
  // first render (it needs the App lock setting), and render comes before
  // any effect.
  useEffect(() => {
    if (!hasShareIntent) return;
    const shared = (shareIntent?.text || shareIntent?.webUrl || '').trim();
    if (shared) {
      addNote(shared); // no notebook = Inbox
      setNotepadRefreshKey((k) => k + 1);
      if (Platform.OS === 'android') {
        ToastAndroid.show('Saved to Notepad › Inbox', ToastAndroid.SHORT);
      }
      // Only reaches Drive if this run of the app is already signed in;
      // otherwise AppContent catches it up once Drive is signed in.
      syncNotepadToDrive();
    }
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return (
    // SafeAreaProvider is required for react-native-safe-area-context's
    // SafeAreaView to work at all — without it, insets default to zero.
    <SafeAreaProvider>
      <AppLock>
        <AppContent notepadRefreshKey={notepadRefreshKey} />
      </AppLock>
    </SafeAreaProvider>
  );
}

// Settings → Buttons: optional controls on the browsing tabs, each shown
// unless turned off (stored as `setting` = '0'). Each only appears on
// tabs whose type supports it (see MediaWebView.js / mediaTypes.js).
const BUTTON_SETTINGS = [
  {
    key: 'siteMenu',
    setting: 'showSiteMenu',
    label: 'Site list',
    hint: 'The ▾ menu at the top of the tab for switching between a tab\'s sites (Manhwa).',
  },
  {
    key: 'savePageImage',
    setting: 'showSavePageImageButton',
    label: 'Save Page Image',
    hint: 'Save the page on screen to the gallery (Manga).',
  },
];

// Opens Android's "Media management apps" screen (Android 12+). With that
// access on, deleting the original screenshot no longer shows the
// "Allow Manga Tracker to delete…?" dialog (needs MANAGE_MEDIA in
// app.config.js). Falls back to the app's own settings page if that
// screen can't be opened.
function openMediaManagementSettings() {
  Linking.sendIntent('android.settings.REQUEST_MANAGE_MEDIA').catch(() =>
    Linking.openSettings().catch(() => {})
  );
}

// Settings → Data saver (src/dataSaver.js). Block ads (under App) also
// saves data, since ads are never downloaded.
const DATA_SAVER_SETTINGS = [
  {
    key: 'lazyTabs',
    label: 'Load tabs only when opened',
    hint: 'A tab loads the first time you open it, instead of every tab loading when the app starts.',
  },
  {
    key: 'unloadBackgroundTabs',
    label: 'Unload background tabs',
    hint: 'Only the current and the last-used tab stay loaded. Others reopen on the same page, back at the top.',
  },
  {
    key: 'driveWifiOnly',
    label: 'Drive sync on Wi-Fi only',
    hint: 'Automatic backups and cover uploads wait for Wi-Fi, then catch up. Backup Now still works anytime.',
  },
];

// How long a browsing tab's page sits still before the tab row hides.
const TAB_BAR_HIDE_MS = 3000;

function AppContent({ notepadRefreshKey }) {
  const [tab, setTab] = useState(MEDIA_TYPE_LIST[0].key);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // Each browsing tab's MediaWebView, for the back button below.
  const webviewRefs = useRef({});

  // The app's only hardwareBackPress listener. Lets the open tab's webview
  // go back in its own history first; once it has nowhere left to go (or
  // the Library is showing), asks before closing instead of letting
  // Android close the app outright. Pop-ups (Settings, details, ...) close
  // themselves on back before this is reached.
  useEffect(() => {
    const onBackPress = () => {
      const webview = webviewRefs.current[tab];
      if (webview && webview.goBackIfPossible()) return true;
      Alert.alert('Exit app?', 'Are you sure you want to exit?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Exit', style: 'destructive', onPress: () => BackHandler.exitApp() },
      ]);
      return true;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [tab]);

  // Settings → Block ads (src/adBlock.js). On unless turned off.
  const [blockAds, setBlockAds] = useState(() => getSetting('blockAds', '1') === '1');
  const toggleBlockAds = (value) => {
    setBlockAds(value);
    setSetting('blockAds', value ? '1' : '0');
  };

  // Tabs stay loaded when you switch away (so they keep their place), so
  // pause any video in the tab you're leaving — no sound or battery use
  // from a tab you can't see. Play resumes from the same spot.
  const previousTabRef = useRef(tab);
  useEffect(() => {
    const left = webviewRefs.current[previousTabRef.current];
    if (previousTabRef.current !== tab && left && left.pauseMedia) left.pauseMedia();
    previousTabRef.current = tab;
  }, [tab]);

  // Pause any playing video as soon as the app leaves the screen (phone
  // locked, Home, another app) rather than let it play on behind it.
  // Skipped for the app's own system dialogs (permission/delete prompts),
  // which don't count as leaving.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'background' || isRelockSuppressed()) return;
      Object.values(webviewRefs.current).forEach((w) => w && w.pauseMedia && w.pauseMedia());
    });
    return () => subscription.remove();
  }, []);

  // Phone screenshots taken in the app are filed into the gallery under
  // Pictures/Manga Tracker/<tab>/ (or Manga Tracker/ itself on the
  // Library tab) with a descriptive name — see src/screenshots.js. Only
  // runs while unlocked: AppLock shows nothing else while locked.
  useEffect(() => {
    // Finding the screenshot Android just saved needs full photo access
    // (and on Android 13 and older, so does detecting it at all). Asked
    // once; if refused, screenshots simply stay in Screenshots.
    getPermissionsAsync()
      .then((permission) => {
        if (permission.status !== 'granted' && permission.canAskAgain) {
          suppressNextRelock(); // the permission dialog would trigger AppLock
          return requestPermissionsAsync();
        }
        return null;
      })
      .catch(() => {});

    const subscription = addScreenshotListener(() => {
      const tabKey = tabRef.current;
      const mediaConfig = MEDIA_TYPE_LIST.find((m) => m.key === tabKey);
      const webview = mediaConfig ? webviewRefs.current[tabKey] : null;
      const folder = galleryFolderFor(mediaConfig ? mediaConfig.label : null);
      // Step-by-step details go to a debug log (Settings → Show debug
      // tools): the current tab's own, or — on the Library — the first
      // browsing tab's, labelled with where it came from.
      const logTarget =
        webview && webview.logDebug
          ? { tab: webview, prefix: '' }
          : {
              tab: MEDIA_TYPE_LIST.map((m) => webviewRefs.current[m.key]).find((w) => w && w.logDebug),
              prefix: `[${mediaConfig ? mediaConfig.label : 'Library'} tab] `,
            };
      const onLog = (message) => logTarget.tab && logTarget.tab.logDebug(logTarget.prefix + message);
      fileScreenshot({
        folder,
        onLog,
        getName: webview ? () => webview.getScreenshotInfo().then((info) => buildGalleryFileName(info)) : null,
      }).then((result) => {
        if (Platform.OS !== 'android') return;
        if (result.ok) {
          ToastAndroid.show(`Screenshot saved to ${result.folder}`, ToastAndroid.SHORT);
        } else if (result.reason === 'permission') {
          ToastAndroid.show(
            'Screenshot left in Screenshots — allow full photo access for Manga Tracker to file it.',
            ToastAndroid.LONG
          );
        } else if (result.reason === 'not-found') {
          ToastAndroid.show(
            'Couldn’t find the new screenshot to file — it’s still in Screenshots.',
            ToastAndroid.LONG
          );
        } else {
          // Names the step and error, so a failure can be reported exactly.
          ToastAndroid.show(
            `Couldn’t file that screenshot (failed while ${result.step}: ${result.error}) — it’s still in Screenshots.`,
            ToastAndroid.LONG
          );
        }
      });
    });
    return () => subscription.remove();
  }, []);

  // The tab row hides on browsing tabs once the page has sat still (no
  // scrolling) for TAB_BAR_HIDE_MS — taps on the page don't count. Pulling
  // down at the very top of the page brings it back (src/tabBarWatch.js
  // reports both). Always shown on the Library tab.
  const [tabBarHidden, setTabBarHidden] = useState(false);
  const tabBarHiddenRef = useRef(false);
  const hideTimer = useRef(null);
  const setTabBarHiddenAnimated = useCallback((hidden) => {
    if (tabBarHiddenRef.current === hidden) return;
    tabBarHiddenRef.current = hidden;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setTabBarHidden(hidden);
  }, []);
  const scheduleTabBarHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (tabRef.current !== 'library') setTabBarHiddenAnimated(true);
    }, TAB_BAR_HIDE_MS);
  }, [setTabBarHiddenAnimated]);
  useEffect(() => {
    if (tab === 'library') {
      clearTimeout(hideTimer.current);
      setTabBarHiddenAnimated(false);
    } else {
      scheduleTabBarHide();
    }
  }, [tab, scheduleTabBarHide, setTabBarHiddenAnimated]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const handleTabBarActivity = useCallback(
    (tabKey, kind) => {
      if (tabKey !== tabRef.current) return; // a tab in the background
      if (kind === 'pullTop') {
        setTabBarHiddenAnimated(false);
        scheduleTabBarHide();
      } else if (kind === 'scroll' && !tabBarHiddenRef.current) {
        scheduleTabBarHide();
      }
    },
    [scheduleTabBarHide, setTabBarHiddenAnimated]
  );
  // Settings → Data saver (src/dataSaver.js). AppLock has already run
  // initDb by the time this renders, so the settings can be read here.
  const [dataSaver, setDataSaver] = useState(() =>
    Object.fromEntries(Object.keys(DATA_SAVER_DEFAULTS).map((key) => [key, dataSaverSetting(key)]))
  );
  // Browsing tabs whose page is loaded, most recently used first. With
  // "Load tabs only when opened" a tab joins on its first visit; with
  // "Unload background tabs" only the first two stay. Each tab reports its
  // page (onPageChange) so an unloaded one reopens where it was.
  const [loadedTabs, setLoadedTabs] = useState(() => (dataSaver.lazyTabs ? [tab] : SITE_TAB_KEYS));
  const loadedTabsRef = useRef(loadedTabs);
  const lastUrls = useRef({});
  useEffect(() => {
    const current = loadedTabsRef.current;
    let next = SITE_TAB_KEYS.includes(tab) ? [tab, ...current.filter((k) => k !== tab)] : [...current];
    if (!dataSaver.lazyTabs) next = [...next, ...SITE_TAB_KEYS.filter((k) => !next.includes(k))];
    if (dataSaver.unloadBackgroundTabs) next = next.slice(0, 2);
    if (next.length === current.length && next.every((k, i) => k === current[i])) return;
    loadedTabsRef.current = next;
    setLoadedTabs(next);
  }, [tab, dataSaver.lazyTabs, dataSaver.unloadBackgroundTabs]);

  // Wi-Fi vs mobile data, for Data saver.
  useEffect(() => startNetworkWatch(), []);
  // Drive sync held back for Wi-Fi runs as soon as the phone is on Wi-Fi
  // again, or the setting is turned off.
  const catchUpDriveSync = useCallback(async () => {
    if (!driveSyncAllowed() || !takeDriveSyncDeferred()) return;
    await maybeBackupLibraryToDrive();
    await syncNotepadToDrive();
    await uploadPendingImages();
  }, []);
  useEffect(() => onUnmetered(catchUpDriveSync), [catchUpDriveSync]);

  const [isSignedInToGoogle, setIsSignedInToGoogle] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showDebugTools, setShowDebugTools] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  // The Notepad (src/Notepad.js), opened from the 📝 button on the Library.
  const [notepadVisible, setNotepadVisible] = useState(false);
  // Settings → Buttons: which optional controls the browsing tabs show
  // (MediaWebView.js). All on unless turned off.
  const [buttons, setButtons] = useState({ siteMenu: true, savePageImage: true });
  // Settings → App lock; the setting lives in AppLock (src/AppLock.js).
  const { lockEnabled, changeLockEnabled } = useAppLockSetting();
  // Set when a "View in Library" button is tapped from a browsing tab —
  // switches to the Library tab and tells it which entry to open.
  // Cleared once EntryList has consumed it, so it doesn't re-trigger on
  // every re-render or every time you switch back to that tab.
  const [libraryFocusKey, setLibraryFocusKey] = useState(null);
  // Bumped after Settings changes the library (MAL import, Drive restore)
  // so the Library reloads even if it's already the open tab.
  const [libraryReloadKey, setLibraryReloadKey] = useState(0);
  const reloadLibrary = () => setLibraryReloadKey((k) => k + 1);

  const handleViewInLibrary = (entryKey) => {
    setLibraryFocusKey(entryKey);
    setTab('library');
  };

  // "Watch next" / "Read next" from the Library: switches to that type's
  // tab and has it open the page ({ url, checkJs, expect } — see openNext
  // in mediaTypes.js). Cleared once the tab has taken it.
  const [openRequests, setOpenRequests] = useState({});
  const handleOpenInTab = useCallback((mediaType, request) => {
    setOpenRequests((prev) => ({ ...prev, [mediaType]: { ...request, id: Date.now() } }));
    setTab(mediaType);
  }, []);
  const clearOpenRequest = useCallback((mediaType) => {
    setOpenRequests((prev) => (prev[mediaType] ? { ...prev, [mediaType]: null } : prev));
  }, []);

  useEffect(() => {
    initDb();
    setShowDebugTools(getSetting('showDebugTools', '0') === '1');
    setButtons(
      Object.fromEntries(BUTTON_SETTINGS.map((b) => [b.key, getSetting(b.setting, '1') === '1']))
    );
    // Restores the last signed-in Google session silently, if there is
    // one — no prompt, no account picker. Without this the app would
    // ask to reconnect Drive on every single launch, which is what was
    // happening before.
    restoreGoogleSession().then((restored) => {
      if (restored) {
        setIsSignedInToGoogle(true);
        // Picks up note names added on other devices, and anything shared
        // into the Inbox before Drive was signed in for this run.
        syncNotepadToDrive();
        catchUpDriveSync();
      }
    });
  }, []);

  const toggleDebugTools = (value) => {
    setShowDebugTools(value);
    setSetting('showDebugTools', value ? '1' : '0');
  };

  const toggleDataSaver = (key, value) => {
    setDataSaver((current) => ({ ...current, [key]: value }));
    setSetting(key, value ? '1' : '0');
    // Sync that was waiting for Wi-Fi may go now.
    if (key === 'driveWifiOnly' && !value) catchUpDriveSync();
  };

  const toggleButton = (button, value) => {
    setButtons((current) => ({ ...current, [button.key]: value }));
    setSetting(button.setting, value ? '1' : '0');
  };

  const handleGoogleSignIn = async () => {
    let syncJob = null;
    try {
      await signInToGoogle();
      setIsSignedInToGoogle(true);
      setRestoring(true);
      // The restore, backup and uploads below show as one in the status pill.
      syncJob = beginSync('restore', { show: true });

      // Always merge in anything from Drive FIRST, before ever backing
      // up — this makes it impossible for connecting to overwrite a
      // real Drive backup with less data than it already had, no
      // matter what's already local (including nothing at all). A
      // previous version of this only skipped the backup when local
      // was completely empty, which still left a gap the moment even
      // one local entry existed but Drive had more — restoring first
      // closes that gap entirely rather than special-casing around it.
      // force: connecting is your own action, so it runs even when Data
      // saver holds automatic sync for Wi-Fi.
      const restoreResult = await restoreFromDriveBackup();
      if (restoreResult.restored > 0) reloadLibrary();
      await maybeBackupLibraryToDrive({ force: true });
      await syncNotepadToDrive({ force: true }); // push any notes written before connecting
      const uploaded = await uploadPendingImages({ force: true }); // catch up any images saved before connecting
      takeDriveSyncDeferred(); // nothing is waiting for Wi-Fi now

      const parts = ['Google Drive sync is now enabled.'];
      if (restoreResult.restored > 0) {
        parts.push(
          `Restored ${restoreResult.restored} ${restoreResult.restored === 1 ? 'entry' : 'entries'} from Drive.`
        );
      }
      if (uploaded > 0) {
        parts.push(`Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'} that hadn't synced yet.`);
      }
      syncJob?.end({ summary: 'Connected' });
      Alert.alert('Connected', parts.join(' '));
    } catch (err) {
      syncJob?.end({ ok: false, error: err.message });
      Alert.alert('Sign-in failed', err.message);
    } finally {
      setRestoring(false);
    }
  };

  const handleBackupNow = async () => {
    if (!isSignedInToGoogle) {
      Alert.alert('Not connected', 'Connect Google Drive first.');
      return;
    }
    // force: runs even when Data saver holds automatic sync for Wi-Fi.
    // The CSVs and covers show as one backup in the status pill, with the
    // covers counted from the start (one step each).
    const syncJob = beginSync('backup', { show: true, total: countPendingImages() });
    let uploaded = 0;
    try {
      await maybeBackupLibraryToDrive({ force: true });
      await syncNotepadToDrive({ force: true });
      uploaded = await uploadPendingImages({ force: true, job: syncJob });
      syncJob.end();
    } catch (err) {
      syncJob.end({ ok: false, error: err.message });
      Alert.alert('Backup failed', err.message);
      return;
    }
    takeDriveSyncDeferred(); // nothing is waiting for Wi-Fi now
    Alert.alert(
      'Backed up',
      `Your library data has been saved to Drive as library-backup.csv${
        uploaded > 0 ? `, and ${uploaded} image${uploaded === 1 ? '' : 's'} were uploaded` : ''
      }.`
    );
  };

  const handleRestoreFromDrive = () => {
    if (!isSignedInToGoogle) {
      Alert.alert('Not connected', 'Connect Google Drive first.');
      return;
    }

    Alert.alert(
      'Restore from Drive?',
      "This adds any entries found in your Drive backup that aren't already on this phone, including re-downloading their cover images where available. Existing entries here are never touched or overwritten.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: async () => {
            setRestoring(true);
            try {
              const result = await restoreFromDriveBackup();
              if (result.restored > 0) reloadLibrary();
              if (result.restored === 0) {
                Alert.alert(
                  'Nothing to restore',
                  result.skipped > 0
                    ? 'Every entry in your Drive backup already exists on this phone.'
                    : "No backup was found in Drive yet — try Backup Now first from another device, or there's simply nothing there."
                );
              } else {
                Alert.alert(
                  'Restore complete',
                  `Added ${result.restored} ${result.restored === 1 ? 'entry' : 'entries'} (${result.imagesRestored} with cover images restored).`
                );
              }
            } catch (err) {
              Alert.alert('Restore failed', err.message);
            } finally {
              setRestoring(false);
            }
          },
        },
      ]
    );
  };

  // Settings → MyAnimeList: export/import MAL list files (src/malList.js).
  // MAL has two lists; the manga one includes manhwa.
  const [malBusy, setMalBusy] = useState(false);

  const runMalExport = async (malType) => {
    setMalBusy(true);
    try {
      const result = await exportMalList(malType);
      const listLabel = MAL_LISTS.find((l) => l.key === malType).label;
      const lines = [`${result.exported} ${listLabel} entries exported.`];
      if (result.hentai > 0) lines.push(`${result.hentai} hentai titles left out.`);
      if (result.skipped > 0) {
        lines.push(
          `${result.skipped} left out: no MyAnimeList id yet. Open them once in their tab to pick it up.`
        );
      }
      if (result.drive === 'saved') {
        lines.push('Saved to Google Drive (replacing the last export).');
      } else if (result.drive === 'not connected') {
        lines.push("Not saved to Google Drive: Drive isn't connected.");
      } else {
        lines.push(`Saving to Google Drive failed: ${result.drive}`);
      }
      Alert.alert('Export done', lines.join('\n\n'));
    } catch (err) {
      Alert.alert('Export failed', err.message);
    } finally {
      setMalBusy(false);
    }
  };

  // Importing looks every title up on AniList and downloads covers, so it
  // asks first, recommending Wi-Fi.
  const handleMalImport = () => {
    Alert.alert(
      'Import uses data',
      `Importing looks your titles up on AniList and downloads a cover for each one that has none — about 0.1 MB per title (roughly 15 MB for 150).${
        isOnMobileData() ? " You're on mobile data right now." : ''
      } Wi-Fi is recommended.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Choose file', onPress: runMalImport },
      ]
    );
  };

  const runMalImport = async () => {
    setMalBusy(true);
    try {
      const result = await pickAndImportMalList({
        // Covers arrive after the summary: show them, and back them up
        // (as part of the same pill).
        onCoversDone: async ({ downloaded }) => {
          if (downloaded > 0) {
            reloadLibrary();
            await uploadPendingImages();
          }
        },
      });
      if (!result) return; // picker cancelled
      reloadLibrary();
      maybeBackupLibraryToDrive().then((backup) => {
        if (backup.attempted && !backup.success) {
          Alert.alert('Drive backup failed', backup.error || 'Unknown error — try Backup Now.');
        }
      });
      const label = MAL_LISTS.find((l) => l.key === result.mediaType).label;
      const lines = [`${result.added} ${label} titles added.`];
      if (result.manhwa > 0) lines.push(`${result.manhwa} Korean titles are under Manhwa.`);
      if (result.aniListFailed) {
        lines.push("Couldn't reach AniList, so manhwa couldn't be told apart: everything went to Manga.");
      }
      if (result.linked > 0) {
        lines.push(`${result.linked} already in your library got their MyAnimeList id.`);
      }
      if (result.nsfw > 0) {
        lines.push(`${result.nsfw} NSFW (18+) title${result.nsfw === 1 ? ' was' : 's were'} left out.`);
      }
      if (result.alreadyThere > 0) lines.push(`${result.alreadyThere} were already there.`);
      if (result.differing > 0) {
        lines.push(
          `${result.differing} differ from what's in the app — tap "⚠ To review" in the Library to go through them. Nothing in the app was overwritten.`
        );
      }
      if (result.covers > 0) {
        lines.push(
          `Downloading ${result.covers} cover${result.covers === 1 ? '' : 's'} in the background — the Import pill at the top shows how far it is.`
        );
      }
      Alert.alert('Import done', lines.join('\n\n'));
    } catch (err) {
      Alert.alert('Import failed', err.message);
    } finally {
      setMalBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>Manga Tracker</Text>
        <View style={styles.headerRight}>
          {/* Backup / restore progress (src/SyncStatusPill.js). */}
          <SyncStatusPill />
          {/* Settings (incl. Drive and MyAnimeList), on every tab. */}
          <TouchableOpacity onPress={() => setSettingsVisible(true)} hitSlop={10} style={styles.headerSettingsButton}>
            <Text style={styles.headerSettingsIcon}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.tabBar, tabBarHidden && styles.tabBarHidden]}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={styles.tabItem} onPress={() => setTab(t.key)}>
            <Text style={tab === t.key ? styles.tabActive : styles.tabInactive}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.body}>
        {/* All tabs stay mounted at all times — switching tabs only
            toggles `display`, never unmounts anything. Previously each
            MediaWebView was conditionally rendered (and given a `key`
            that changed between manga/anime), which destroyed and
            recreated the webview's native view — losing scroll
            position and navigation history — every single time you
            switched away and back, including via the Library tab. */}
        {MEDIA_TYPE_LIST.map((mediaConfig) => (
          <View
            key={mediaConfig.key}
            style={[styles.tabPane, { display: tab === mediaConfig.key ? 'flex' : 'none' }]}
          >
            {/* Not loaded yet, or unloaded by Data saver: nothing here
                until the tab is opened (loadedTabs). */}
            {loadedTabs.includes(mediaConfig.key) ? (
              <MediaWebView
                ref={(r) => {
                  webviewRefs.current[mediaConfig.key] = r;
                }}
                config={mediaConfig}
                isSignedInToGoogle={isSignedInToGoogle}
                showDebugTools={showDebugTools}
                onViewInLibrary={handleViewInLibrary}
                buttons={buttons}
                blockAds={blockAds}
                onTabBarActivity={(kind) => handleTabBarActivity(mediaConfig.key, kind)}
                initialUrl={lastUrls.current[mediaConfig.key] || null}
                onPageChange={(url) => {
                  lastUrls.current[mediaConfig.key] = url;
                }}
                openRequest={openRequests[mediaConfig.key] || null}
                onOpenHandled={() => clearOpenRequest(mediaConfig.key)}
              />
            ) : null}
          </View>
        ))}
        <View style={[styles.tabPane, { display: tab === 'library' ? 'flex' : 'none' }]}>
          <EntryList
            active={tab === 'library'}
            reloadKey={libraryReloadKey}
            focusKey={libraryFocusKey}
            onFocusHandled={() => setLibraryFocusKey(null)}
            onOpenInTab={handleOpenInTab}
          />
          {tab === 'library' ? (
            <TouchableOpacity style={styles.notepadFab} onPress={() => setNotepadVisible(true)}>
              <Text style={styles.notepadFabIcon}>📝</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <Notepad visible={notepadVisible} onClose={() => setNotepadVisible(false)} refreshKey={notepadRefreshKey} />

      <Modal
        visible={settingsVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.settingsOverlay}>
          {/* Scrolls when the settings don't fit on the screen. */}
          <ScrollView style={styles.settingsCard} contentContainerStyle={styles.settingsCardContent}>
            <Text style={styles.settingsTitle}>Settings</Text>

            <Text style={styles.settingsSectionTitle}>Google Drive</Text>
            <View style={styles.settingsRow}>
              <View style={styles.settingsRowText}>
                <Text style={styles.settingsLabel}>
                  {isSignedInToGoogle ? '☁️ Cloud sync is on' : 'Cloud sync is off'}
                </Text>
                <Text style={styles.settingsHint}>
                  {isSignedInToGoogle
                    ? 'Your library and covers are backed up to Google Drive automatically.'
                    : 'Connect Google Drive to back up your library and covers automatically.'}
                </Text>
              </View>
              <TouchableOpacity style={styles.settingsSmallButton} onPress={handleGoogleSignIn} disabled={restoring}>
                <Text style={styles.settingsSmallButtonText}>{isSignedInToGoogle ? 'Reconnect' : 'Connect'}</Text>
              </TouchableOpacity>
            </View>
            {isSignedInToGoogle ? (
              <View style={styles.settingsButtonRow}>
                <TouchableOpacity style={styles.settingsWideButton} onPress={handleBackupNow} disabled={restoring}>
                  <Text style={styles.settingsSmallButtonText}>Backup Now</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.settingsWideButton} onPress={handleRestoreFromDrive} disabled={restoring}>
                  <Text style={styles.settingsSmallButtonText}>{restoring ? 'Restoring…' : 'Restore'}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={styles.settingsSectionTitle}>MyAnimeList</Text>
            <Text style={styles.settingsHint}>
              Export or import MAL list files. Manga includes manhwa. Exports are also saved to Google
              Drive when it's connected; imports add missing titles and mark differences to review.
            </Text>
            <View style={styles.settingsButtonRow}>
              {MAL_LISTS.map((l) => (
                <TouchableOpacity
                  key={l.key}
                  style={styles.settingsWideButton}
                  onPress={() => runMalExport(l.key)}
                  disabled={malBusy}
                >
                  <Text style={styles.settingsSmallButtonText}>⬆ Export {l.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.settingsWideButton} onPress={handleMalImport} disabled={malBusy}>
              <Text style={styles.settingsSmallButtonText}>{malBusy ? 'Working…' : '⬇ Import MAL list'}</Text>
            </TouchableOpacity>

            <Text style={styles.settingsSectionTitle}>App</Text>
            <View style={[styles.settingsRow, styles.settingsRowGap]}>
              <View style={styles.settingsRowText}>
                <Text style={styles.settingsLabel}>App lock</Text>
                <Text style={styles.settingsHint}>
                  Asks for your fingerprint or phone PIN when the app opens and whenever you come
                  back to it. Turning this on or off asks for it too.
                </Text>
              </View>
              <Switch value={lockEnabled} onValueChange={changeLockEnabled} />
            </View>
            <View style={[styles.settingsRow, styles.settingsRowGap]}>
              <View style={styles.settingsRowText}>
                <Text style={styles.settingsLabel}>Block ads</Text>
                <Text style={styles.settingsHint}>
                  Stops pop-ups, ad networks and ad boxes on every tab. Turn off if a site stops working;
                  takes effect when a page next loads.
                </Text>
              </View>
              <Switch value={blockAds} onValueChange={toggleBlockAds} />
            </View>
            <View style={styles.settingsRow}>
              <View style={styles.settingsRowText}>
                <Text style={styles.settingsLabel}>Show debug tools</Text>
                <Text style={styles.settingsHint}>
                  Adds the debug log bar and a "Capture HTML" button to each browsing tab, for
                  troubleshooting extraction issues.
                </Text>
              </View>
              <Switch value={showDebugTools} onValueChange={toggleDebugTools} />
            </View>
            {Platform.OS === 'android' && Platform.Version >= 31 ? (
              <View style={[styles.settingsRow, styles.settingsRowSpaced]}>
                <View style={styles.settingsRowText}>
                  <Text style={styles.settingsLabel}>Delete screenshots without asking</Text>
                  <Text style={styles.settingsHint}>
                    After filing a screenshot, Android asks before removing the original. Turn on
                    "Media management" for Manga Tracker on the next screen to skip that question.
                  </Text>
                </View>
                <TouchableOpacity style={styles.settingsSmallButton} onPress={openMediaManagementSettings}>
                  <Text style={styles.settingsSmallButtonText}>Open</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={styles.settingsSectionTitle}>Buttons</Text>
            {BUTTON_SETTINGS.map((button, i) => (
              <View key={button.key} style={[styles.settingsRow, i < BUTTON_SETTINGS.length - 1 && styles.settingsRowGap]}>
                <View style={styles.settingsRowText}>
                  <Text style={styles.settingsLabel}>{button.label}</Text>
                  <Text style={styles.settingsHint}>{button.hint}</Text>
                </View>
                <Switch value={buttons[button.key]} onValueChange={(value) => toggleButton(button, value)} />
              </View>
            ))}

            <Text style={styles.settingsSectionTitle}>Data saver</Text>
            {DATA_SAVER_SETTINGS.map((item, i) => (
              <View
                key={item.key}
                style={[styles.settingsRow, i < DATA_SAVER_SETTINGS.length - 1 && styles.settingsRowGap]}
              >
                <View style={styles.settingsRowText}>
                  <Text style={styles.settingsLabel}>{item.label}</Text>
                  <Text style={styles.settingsHint}>{item.hint}</Text>
                </View>
                <Switch value={dataSaver[item.key]} onValueChange={(value) => toggleDataSaver(item.key, value)} />
              </View>
            ))}
            <TouchableOpacity style={styles.settingsCloseButton} onPress={() => setSettingsVisible(false)}>
              <Text style={styles.settingsCloseButtonText}>Close</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  headerSettingsButton: { paddingHorizontal: 4, paddingVertical: 2 },
  headerSettingsIcon: { fontSize: 22 },
  tabBar: { flexDirection: 'row', backgroundColor: '#16213e' },
  tabBarHidden: { height: 0, overflow: 'hidden' },
  tabItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { color: '#e94560', fontWeight: '700' },
  tabInactive: { color: '#888' },
  body: { flex: 1, backgroundColor: '#fff' },
  tabPane: { flex: 1 },
  // The Notepad button, bottom right on the Library.
  notepadFab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#16213e',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  notepadFabIcon: { fontSize: 22 },
  settingsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 24,
  },
  settingsCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    flexGrow: 0,
    maxHeight: '90%',
  },
  settingsCardContent: { padding: 20 },
  settingsSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    marginTop: 20,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  settingsTitle: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  settingsRowGap: { marginBottom: 16 },
  settingsRowText: { flex: 1 },
  settingsLabel: { fontSize: 15, fontWeight: '600', color: '#222' },
  settingsHint: { fontSize: 12, color: '#888', marginTop: 4 },
  settingsCloseButton: {
    marginTop: 20,
    backgroundColor: '#16213e',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  settingsCloseButtonText: { color: '#fff', fontWeight: '600' },
  settingsButtonRow: { flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 12 },
  settingsWideButton: {
    flex: 1,
    backgroundColor: '#16213e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  settingsSmallButton: {
    backgroundColor: '#16213e',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  settingsSmallButtonText: { color: '#fff', fontWeight: '600' },
  settingsRowSpaced: { marginTop: 16 },
});
