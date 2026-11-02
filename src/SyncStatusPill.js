import React, { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { clearSyncResult, getSyncStatus, onSyncStatus } from './syncStatus';
import Icon from './Icon';
import { themed, useDarkMode } from './theme';

// The pill beside the Settings button: "Backup", "Restore" or "Import"
// (MAL import, src/malList.js) while it runs, filling from the left as it goes (full = done), then
// "✓ Backed up" / "✓ Restored 12" for a moment, or a red "Backup failed"
// that shows the error when tapped. Driven by syncStatus.js. While it
// runs the pill shows the percentage done, and tapping it opens the
// details: the percentage, and x / total for each part (entries checked,
// covers, ...), live until it's done.

// Waits this long before showing a running backup/restore, so quick
// ones (most automatic backups) never flash it.
const SHOW_DELAY_MS = 500;
const SUCCESS_MS = 2000;

const LABELS = {
  backup: { running: 'Backup', done: 'Backed up', failed: 'Backup failed' },
  restore: { running: 'Restore', done: 'Restored', failed: 'Restore failed' },
  import: { running: 'Import', done: 'Imported', failed: 'Import failed' },
};

export default function SyncStatusPill() {
  const [status, setStatus] = useState(getSyncStatus);
  // Whether the running activity has lasted past SHOW_DELAY_MS.
  const [delayPassed, setDelayPassed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  // A success goes away by itself (not while its details are open); a
  // failure stays until tapped.
  useEffect(() => {
    if (!result?.ok || detailsOpen) return undefined;
    const timer = setTimeout(clearSyncResult, SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [result, detailsOpen]);

  const details = <SyncDetails visible={detailsOpen} status={status} onClose={() => setDetailsOpen(false)} />;
  if (active && active.show && delayPassed) {
    const percent = Math.floor(fraction * 100);
    return (
      <>
        <TouchableOpacity
          style={styles.pill}
          onPress={() => setDetailsOpen(true)}
          hitSlop={{ top: 11, bottom: 11, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={`${LABELS[active.kind].running} ${percent}%. Show details`}
        >
          <Animated.View
            style={[styles.fill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}
          />
          <Text style={styles.text} numberOfLines={1}>
            {LABELS[active.kind].running} {percent}%
          </Text>
        </TouchableOpacity>
        {details}
      </>
    );
  }
  if (!active && result) {
    const labels = LABELS[result.kind];
    if (result.ok) {
      return (
        <>
          <View style={[styles.pill, styles.pillDone]}>
            <Text style={styles.text} numberOfLines={1}>
              <Icon name="check" size={13} /> {result.summary || labels.done}
            </Text>
          </View>
          {details}
        </>
      );
    }
    return (
      <>
        <TouchableOpacity
          style={[styles.pill, styles.pillFailed]}
          onPress={() => {
            setDetailsOpen(false);
            Alert.alert(labels.failed, result.error);
            clearSyncResult();
          }}
          hitSlop={{ top: 11, bottom: 11, left: 6, right: 6 }}
          accessibilityRole="button"
        >
          <Text style={styles.text}>
            <Icon name="warning" size={13} /> {labels.failed}
          </Text>
        </TouchableOpacity>
        {details}
      </>
    );
  }
  return detailsOpen ? details : null;
}

const TITLES = { backup: 'Backing up', restore: 'Restoring', import: 'Importing' };

// The pill's details: the percentage done and each part's x / total,
// updated as it goes; once it's finished, how it ended.
function SyncDetails({ visible, status, onClose }) {
  useDarkMode();
  if (!visible) return null;
  const { active, result } = status;
  let body;
  if (active) {
    const percent = active.total > 0 ? Math.floor((active.done / active.total) * 100) : 0;
    body = (
      <>
        <Text style={detailStyles.title}>{TITLES[active.kind]}…</Text>
        <Text style={detailStyles.percent} accessibilityLiveRegion="polite">
          {percent}%
        </Text>
        <View style={detailStyles.bar}>
          <View style={[detailStyles.barFill, { width: `${percent}%` }]} />
        </View>
        {active.parts.map((part, i) => (
          <View key={`${part.label}${i}`} style={detailStyles.part}>
            <Text style={detailStyles.partLabel}>{part.label}</Text>
            <Text style={detailStyles.partCount}>
              {part.done} / {part.total}
            </Text>
          </View>
        ))}
        <Text style={detailStyles.hint}>You can keep using the app meanwhile.</Text>
      </>
    );
  } else {
    const kind = (result && result.kind) || 'restore';
    const failed = result && !result.ok;
    body = (
      <>
        <Text style={detailStyles.title}>
          {failed ? (
            LABELS[kind].failed
          ) : (
            <>
              <Icon name="check" size={20} /> {(result && result.summary) || LABELS[kind].done}
            </>
          )}
        </Text>
        {failed ? <Text style={detailStyles.hint}>{result.error}</Text> : null}
      </>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={detailStyles.overlay}>
        <View style={detailStyles.card}>
          {body}
          <TouchableOpacity style={detailStyles.close} onPress={onClose} accessibilityRole="button">
            <Text style={detailStyles.closeText}>{active ? 'Hide' : 'Close'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const detailStyles = themed(
  StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
    card: { backgroundColor: '#ffffff', borderRadius: 16, padding: 20, elevation: 8 },
    title: { fontSize: 18, fontWeight: '700', color: '#222', marginBottom: 8 },
    percent: { fontSize: 36, fontWeight: '700', color: '#16213e', marginBottom: 8 },
    bar: { height: 8, borderRadius: 4, backgroundColor: '#e0e0e0', overflow: 'hidden', marginBottom: 16 },
    barFill: { height: 8, backgroundColor: '#3d5f99' },
    part: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
    partLabel: { fontSize: 15, color: '#333' },
    partCount: { fontSize: 15, fontWeight: '700', color: '#222' },
    hint: { fontSize: 14, color: '#666', marginTop: 10 },
    close: {
      alignSelf: 'flex-end',
      marginTop: 16,
      minHeight: 48,
      minWidth: 88,
      paddingHorizontal: 20,
      borderRadius: 24,
      backgroundColor: '#16213e',
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  })
);

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
