import React, { useEffect, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { clearSyncResult, getSyncStatus, onSyncStatus } from './syncStatus';

// The pill beside the Settings button: "Backup", "Restore" or "Import"
// (MAL import, src/malList.js) while it runs, filling from the left as it goes (full = done), then
// "✓ Backed up" / "✓ Restored 12" for a moment, or a red "Backup failed"
// that shows the error when tapped. Driven by syncStatus.js.

// Waits this long before showing a running backup/restore, so quick
// ones (most automatic backups) never flash it.
const SHOW_DELAY_MS = 500;
const SUCCESS_MS = 2000;

const LABELS = {
  backup: { running: 'Backup', done: '✓ Backed up', failed: '⚠ Backup failed' },
  restore: { running: 'Restore', done: '✓ Restored', failed: '⚠ Restore failed' },
  import: { running: 'Import', done: '✓ Imported', failed: '⚠ Import failed' },
};

export default function SyncStatusPill() {
  const [status, setStatus] = useState(getSyncStatus);
  // Whether the running activity has lasted past SHOW_DELAY_MS.
  const [delayPassed, setDelayPassed] = useState(false);
  const fill = useRef(new Animated.Value(0)).current;

  useEffect(() => onSyncStatus(setStatus), []);

  const { active, result } = status;
  const running = !!active;
  useEffect(() => {
    if (!running) {
      setDelayPassed(false);
      fill.setValue(0);
      return undefined;
    }
    const timer = setTimeout(() => setDelayPassed(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [running, fill]);

  const fraction = active && active.total > 0 ? active.done / active.total : 0;
  useEffect(() => {
    Animated.timing(fill, { toValue: fraction, duration: 250, useNativeDriver: false }).start();
  }, [fraction, fill]);

  // A success goes away by itself; a failure stays until tapped.
  useEffect(() => {
    if (!result?.ok) return undefined;
    const timer = setTimeout(clearSyncResult, SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [result]);

  if (active && active.show && delayPassed) {
    return (
      <View
        style={styles.pill}
        accessibilityRole="progressbar"
        accessibilityLabel={`${LABELS[active.kind].running} ${Math.round(fraction * 100)}%`}
      >
        <Animated.View
          style={[styles.fill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
        />
        <Text style={styles.text}>{LABELS[active.kind].running}</Text>
      </View>
    );
  }
  if (!active && result) {
    const labels = LABELS[result.kind];
    if (result.ok) {
      return (
        <View style={[styles.pill, styles.pillDone]}>
          <Text style={styles.text} numberOfLines={1}>
            {result.summary ? `✓ ${result.summary}` : labels.done}
          </Text>
        </View>
      );
    }
    return (
      <TouchableOpacity
        style={[styles.pill, styles.pillFailed]}
        onPress={() => {
          Alert.alert(labels.failed.replace('⚠ ', ''), result.error);
          clearSyncResult();
        }}
        hitSlop={6}
      >
        <Text style={styles.text}>{labels.failed}</Text>
      </TouchableOpacity>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 84,
    maxWidth: 170,
    height: 26,
    paddingHorizontal: 12,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#4a6fa5',
    backgroundColor: '#16213e',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  // The part done, behind the word.
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#3d5f99' },
  pillDone: { borderColor: '#2e7d4f', backgroundColor: '#1e5c3a' },
  pillFailed: { borderColor: '#c0392b', backgroundColor: '#7a1f1f' },
  text: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
