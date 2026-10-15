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
import { MEDIA_TYPE_LIST } from './src/mediaTypes';
import AppLock, { useAppLockSetting } from './src/AppLock';

// Tabs = one per media type (from config, so this never needs manual
// updates when a type is added) + a unified library at the end.
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
      if (restored) setIsSignedInToGoogle(true);
    });
  }, []);

  const toggleDebugTools = (value) => {
    setShowDebugTools(value);
    setSetting('showDebugTools', value ? '1' : '0');
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
      const restoreResult = await restoreFromDriveBackup();
      await maybeBackupLibraryToDrive();
      const uploaded = await uploadPendingImages(); // catch up any images saved before connecting

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
    await maybeBackupLibraryToDrive();
    const uploaded = await uploadPendingImages();
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
            that changed between manga/video), which destroyed and
            recreated the webview's native view — losing scroll
            position and navigation history — every single time you
            switched away and back, including via the Library tab. */}
        {MEDIA_TYPE_LIST.map((mediaConfig) => (
          <View
            key={mediaConfig.key}
            style={[styles.tabPane, { display: tab === mediaConfig.key ? 'flex' : 'none' }]}
          >
            <MediaWebView
              config={mediaConfig}
              isSignedInToGoogle={isSignedInToGoogle}
              showDebugTools={showDebugTools}
              onViewInLibrary={handleViewInLibrary}
              buttons={buttons}
              onTabBarActivity={(kind) => handleTabBarActivity(mediaConfig.key, kind)}
            />
          </View>
        ))}
        <View style={[styles.tabPane, { display: tab === 'library' ? 'flex' : 'none' }]}>
          <EntryList
            active={tab === 'library'}
            focusKey={libraryFocusKey}
            onFocusHandled={() => setLibraryFocusKey(null)}
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
