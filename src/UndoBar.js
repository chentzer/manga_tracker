import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useUndoMessage, undoPending } from './undo';

// The "Deleted · Undo" bar (a Material snackbar) for undo.js's offers.
// Sits just above the bottom bar.
export default function UndoBar() {
  const message = useUndoMessage();
  if (!message) return null;
  return (
    <View style={styles.bar} accessibilityLiveRegion="polite">
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      <TouchableOpacity style={styles.button} onPress={undoPending} accessibilityRole="button">
        <Text style={styles.buttonText}>UNDO</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#323232',
    borderRadius: 8,
    paddingLeft: 16,
    elevation: 6,
  },
  text: { flex: 1, color: '#fff', fontSize: 14, paddingVertical: 14 },
  button: { minWidth: 64, minHeight: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#ffb4c0', fontWeight: '700', fontSize: 14 },
});
