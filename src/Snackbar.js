import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { currentToast, onToast } from './toast';

// showToast()'s message, just above the bottom bar. Touches go through it to
// the page underneath. It's drawn in the app's own window, so it sits behind
// any pop-up that's open.
export default function Snackbar() {
  const [message, setMessage] = useState(currentToast);
  useEffect(() => onToast(setMessage), []);
  if (!message) return null;
  return (
    <View style={styles.bar} pointerEvents="none" accessibilityLiveRegion="polite">
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 8,
    backgroundColor: '#323232',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    elevation: 6,
  },
  text: { color: '#fff', fontSize: 14 },
});
