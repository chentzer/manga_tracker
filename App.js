import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  Alert,
  Modal,
  Switch,
  ScrollView,
  LayoutAnimation,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initDb, getSetting, setSetting } from './src/db';
import MediaWebView from './src/MediaWebView';
import EntryList from './src/EntryList';
import { signInToGoogle, restoreGoogleSession } from './src/GoogleDriveService';
import { maybeBackupLibraryToDrive, uploadPendingImages, restoreFromDriveBackup } from './src/backup';
import {
  DATA_SAVER_DEFAULTS,
  dataSaverSetting,
  driveSyncAllowed,
  onUnmetered,
  startNetworkWatch,
  takeDriveSyncDeferred,
} from './src/dataSaver';
import { MEDIA_TYPE_LIST } from './src/mediaTypes';
import AppLock, { useAppLockSetting } from './src/AppLock';

// Tabs = one per media type (from config, so this never needs manual
// updates when a type is added) + a unified library at the end.
// Browsing tabs (everything but the Library), for Data saver's tab loading.
const SITE_TAB_KEYS = MEDIA_TYPE_LIST.map((m) => m.key);

const TABS = [...MEDIA_TYPE_LIST.map((m) => ({ key: m.key, label: m.label })), { key: 'library', label: 'Library' }];

export default function App() {
  return (
    // SafeAreaProvider is required for react-native-safe-area-context's
    // SafeAreaView to work at all — without it, insets default to zero.
    <SafeAreaProvider>
      <AppLock>
        <AppContent />
      </AppLock>
    </SafeAreaProvider>
  );
}

// Settings → Buttons: optional controls on the browsing tabs, each shown
// unless turned off (stored as `setting` = '0'). Each only appears on
// tabs whose type supports it (see MediaWebView.js / mediaTypes.js).
const BUTTON_SETTINGS = [
  {
    key: 'codeSearch',
    setting: 'showCodeSearch',
    label: 'Code search box',
    hint: 'The "Enter code" / "Search code" box at the top of each tab.',
  },
  {
    key: 'reverseSearch',
    setting: 'showReverseSearchButton',
    label: 'Reverse',
    hint: 'Find a title from an image (types with reverseSearch set).',
  },
  {
    key: 'savePageImage',
    setting: 'showSavePageImageButton',
    label: 'Save Page Image',
    hint: 'Save the page on screen to the gallery (Manga).',
  },
];

// Settings → Data saver (src/dataSaver.js).
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

function AppContent() {
  const [tab, setTab] = useState(MEDIA_TYPE_LIST[0].key);
  const tabRef = useRef(tab);
  tabRef.current = tab;

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
    await uploadPendingImages();
  }, []);
  useEffect(() => onUnmetered(catchUpDriveSync), [catchUpDriveSync]);

  const [isSignedInToGoogle, setIsSignedInToGoogle] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showDebugTools, setShowDebugTools] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  // Settings → Buttons: which optional controls the browsing tabs show
  // (MediaWebView.js). All on unless turned off.
  const [buttons, setButtons] = useState({ codeSearch: true, reverseSearch: true, savePageImage: true });
  // Settings → App lock; the setting lives in AppLock (src/AppLock.js).
  const { lockEnabled, changeLockEnabled } = useAppLockSetting();
  // Set when a "View in Library" button is tapped from a browsing tab —
  // switches to the Library tab and tells it which entry to open.
  // Cleared once EntryList has consumed it, so it doesn't re-trigger on
  // every re-render or every time you switch back to that tab.
  const [libraryFocusKey, setLibraryFocusKey] = useState(null);

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
    try {
      await signInToGoogle();
      setIsSignedInToGoogle(true);
      setRestoring(true);

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
      await maybeBackupLibraryToDrive({ force: true });
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
      Alert.alert('Connected', parts.join(' '));
    } catch (err) {
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
    await maybeBackupLibraryToDrive({ force: true });
    const uploaded = await uploadPendingImages({ force: true });
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
                  `Added ${result.restored} ${result.restored === 1 ? 'entry' : 'entries'} (${result.imagesRestored} with cover images restored). Open the Library tab (or pull to refresh if you're already there) to see them.`
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>Media Tracker</Text>
        <View style={styles.headerButtons}>
          {isSignedInToGoogle ? (
            <TouchableOpacity onPress={handleBackupNow} style={styles.backupButton} disabled={restoring}>
              <Text style={styles.driveButtonText}>Backup Now</Text>
            </TouchableOpacity>
          ) : null}
          {isSignedInToGoogle ? (
            <TouchableOpacity onPress={handleRestoreFromDrive} style={styles.backupButton} disabled={restoring}>
              <Text style={styles.driveButtonText}>{restoring ? 'Restoring…' : 'Restore'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={handleGoogleSignIn} style={styles.driveButton} disabled={restoring}>
            <Text style={styles.driveButtonText}>
              {isSignedInToGoogle ? '☁️ Connected' : 'Connect Drive'}
            </Text>
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
                config={mediaConfig}
                isSignedInToGoogle={isSignedInToGoogle}
                showDebugTools={showDebugTools}
                onViewInLibrary={handleViewInLibrary}
                buttons={buttons}
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
            focusKey={libraryFocusKey}
            onFocusHandled={() => setLibraryFocusKey(null)}
            onOpenInTab={handleOpenInTab}
          />
          {tab === 'library' ? (
            <TouchableOpacity style={styles.settingsFab} onPress={() => setSettingsVisible(true)}>
              <Text style={styles.settingsFabIcon}>⚙️</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

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
  headerButtons: { flexDirection: 'row', gap: 8 },
  backupButton: {
    backgroundColor: '#1f4068',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  driveButton: {
    backgroundColor: '#0f3460',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  driveButtonText: { color: '#fff', fontSize: 12 },
  tabBar: { flexDirection: 'row', backgroundColor: '#16213e' },
  tabBarHidden: { height: 0, overflow: 'hidden' },
  tabItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { color: '#e94560', fontWeight: '700' },
  tabInactive: { color: '#888' },
  body: { flex: 1, backgroundColor: '#fff' },
  tabPane: { flex: 1 },
  settingsFab: {
    position: 'absolute',
    right: 16,
    bottom: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#16213e',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  settingsFabIcon: { fontSize: 22 },
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
});
