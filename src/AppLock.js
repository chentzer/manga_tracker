import React, { useState, useEffect, useRef, useCallback, useContext, useMemo, createContext } from 'react';
import { Text, TouchableOpacity, StyleSheet, AppState, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as LocalAuthentication from 'expo-local-authentication';
import { isRelockSuppressed, suppressNextRelock } from './relockGuard';
import { initDb, getSetting, setSetting } from './db';

// { lockEnabled, changeLockEnabled } for the Settings → App lock switch.
const AppLockSettingContext = createContext(null);

export function useAppLockSetting() {
  return useContext(AppLockSettingContext);
}

// Wraps the whole app. With App lock on (Settings; the appLockEnabled
// setting) it requires biometric/device-passcode auth before showing
// anything, and re-locks whenever the app goes to the background and
// comes back — a screenshot in the recent-apps switcher or someone
// picking up an unlocked phone shouldn't be enough to see what's tracked
// here. With App lock off it just shows the app.
export default function AppLock({ children }) {
  // Read before the first render decides what to show. initDb (idempotent)
  // has to run first, since it sets the default.
  const [lockEnabled, setLockEnabled] = useState(() => {
    initDb();
    return getSetting('appLockEnabled', '0') === '1';
  });
  const lockEnabledRef = useRef(lockEnabled);
  const [locked, setLocked] = useState(lockEnabled);
  const [checking, setChecking] = useState(lockEnabled);
  const [canUseAuth, setCanUseAuth] = useState(true);
  const [statusMessage, setStatusMessage] = useState(null);
  const [failedOnce, setFailedOnce] = useState(false);
  const appState = useRef(AppState.currentState);

  const attemptUnlock = useCallback(async () => {
    setChecking(true);
    setStatusMessage(null);
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      if (!hasHardware) {
        // No biometric/passcode hardware at all — can't enforce a lock,
        // so don't block the user out of their own app.
        setCanUseAuth(false);
        setLocked(false);
        return;
      }

      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!isEnrolled) {
        // Hardware exists but nothing is enrolled — this is the most
        // common cause of the prompt never appearing at all. It usually
        // means the phone has no fingerprint/face AND no PIN/pattern/
        // password set at the system level, so there's nothing for the
        // native prompt to fall back to.
        setStatusMessage(
          'No fingerprint, face, or screen lock is set up on this phone. Add one in your phone\'s Settings (Security / Lock screen) to use this lock — until then, tap below to continue.'
        );
        setChecking(false);
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Manga Tracker',
        // Falls back to device PIN/pattern/password if biometrics aren't
        // enrolled or fail — most users won't have fingerprint/face setup
        // on every device, and locking them out entirely would be worse
        // than falling back to whatever screen lock they already use.
        disableDeviceFallback: false,
        cancelLabel: 'Cancel',
      });

      if (result.success) {
        setLocked(false);
      } else {
        setFailedOnce(true);
        setStatusMessage(
          result.error ? `Authentication failed: ${result.error}` : 'Authentication was cancelled or failed.'
        );
      }
    } catch (err) {
      setFailedOnce(true);
      setStatusMessage(`Authentication error: ${err.message}`);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (lockEnabledRef.current) attemptUnlock();
  }, [attemptUnlock]);

  // Settings → App lock. Turning it on or off both need the fingerprint/
  // PIN first, so someone handed the unlocked phone can't switch it off.
  // Takes effect straight away; the app stays unlocked either way.
  const changeLockEnabled = useCallback(async (value) => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = hasHardware && (await LocalAuthentication.isEnrolledAsync());
      if (!isEnrolled) {
        Alert.alert(
          'No screen lock',
          "App lock uses your phone's fingerprint, face, PIN, pattern or password. Set one up in your phone's Settings (Security / Lock screen) first."
        );
        return;
      }
      // The prompt briefly counts as leaving the app.
      suppressNextRelock();
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: value ? 'Turn on app lock' : 'Turn off app lock',
        disableDeviceFallback: false,
        cancelLabel: 'Cancel',
      });
      // Covers the return from the prompt, however long it was up.
      suppressNextRelock(1500);
      if (!result.success) {
        if (!['user_cancel', 'system_cancel', 'app_cancel'].includes(result.error)) {
          Alert.alert("Couldn't confirm it's you", `App lock wasn't changed (${result.error || 'failed'}).`);
        }
        return;
      }
      setSetting('appLockEnabled', value ? '1' : '0');
      lockEnabledRef.current = value;
      setCanUseAuth(true);
      setLockEnabled(value);
    } catch (err) {
      Alert.alert("Couldn't confirm it's you", `App lock wasn't changed (${err.message}).`);
    }
  }, []);

  const settingValue = useMemo(() => ({ lockEnabled, changeLockEnabled }), [lockEnabled, changeLockEnabled]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasBackgrounded =
        appState.current.match(/inactive|background/) && nextState === 'active';
      // Any time the app comes back from being backgrounded, require
      // re-auth — otherwise leaving the app for even a second would
      // permanently unlock it for the rest of the session. Skipped when
      // a specific action (e.g. saving an image, which triggers a
      // native permission dialog) has marked the upcoming transition as
      // benign via suppressNextRelock() — that dialog briefly registers
      // as "inactive" in AppState even though nothing actually left the
      // app.
      if (wasBackgrounded && lockEnabledRef.current && canUseAuth && !isRelockSuppressed()) {
        setLocked(true);
        setFailedOnce(false);
        setStatusMessage(null);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [canUseAuth]);

  if (locked) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.title}>Manga Tracker Locked</Text>
        {statusMessage ? <Text style={styles.status}>{statusMessage}</Text> : null}
        <TouchableOpacity
          style={styles.button}
          onPress={attemptUnlock}
          disabled={checking}
        >
          <Text style={styles.buttonText}>{checking ? 'Checking…' : 'Unlock'}</Text>
        </TouchableOpacity>

        {/* Escape hatch — only shown after a real failure/enrollment
            issue, never on the very first attempt. This is here so a
            device with no lock screen set up (or any other auth
            hiccup) never permanently locks someone out of their own
            app. It intentionally isn't offered up front, so the lock
            still does its job in the common case. */}
        {failedOnce || statusMessage ? (
          <TouchableOpacity style={styles.skipButton} onPress={() => setLocked(false)}>
            <Text style={styles.skipButtonText}>Continue without unlocking</Text>
          </TouchableOpacity>
        ) : null}
      </SafeAreaView>
    );
  }

  return <AppLockSettingContext.Provider value={settingValue}>{children}</AppLockSettingContext.Provider>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  icon: { fontSize: 56, marginBottom: 16 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  status: {
    color: '#f5a623',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 18,
  },
  button: {
    backgroundColor: '#e94560',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 10,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  skipButton: { marginTop: 20, padding: 8 },
  skipButtonText: { color: '#888', fontSize: 13, textDecorationLine: 'underline' },
});
