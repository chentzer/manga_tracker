// Shown in place of a page that couldn't load (a WebView's renderError),
// instead of Android's bare "Error loading page / Domain: undefined":
// what went wrong in plain words, and Retry. The bars above stay shown
// (App.js keeps them up after a failed load), so the site list and
// address bar are still there.
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { themed, useDarkMode } from './theme';

function explain(description = '') {
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE/i.test(description)) {
    return ["You're offline", 'Check Wi-Fi or mobile data, then try again.'];
  }
  if (/TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED/i.test(description)) {
    return ['The site took too long', 'The connection is slow or the site is busy. Try again in a moment.'];
  }
  if (/NAME_NOT_RESOLVED/i.test(description)) {
    return ["Couldn't find the site", 'Check the address, or try again if the connection is slow.'];
  }
  return ["Couldn't load the page", description || 'Something went wrong. Try again.'];
}

export default function PageError({ description, onRetry }) {
  useDarkMode();
  const [title, hint] = explain(description);
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.hint}>{hint}</Text>
      <TouchableOpacity style={styles.retry} onPress={onRetry} accessibilityRole="button">
        <Text style={styles.retryText}>
          Retry
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = themed(
  StyleSheet.create({
    wrap: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: '#ffffff',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    title: { fontSize: 18, fontWeight: '700', color: '#222', marginBottom: 6, textAlign: 'center' },
    hint: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20 },
    retry: {
      backgroundColor: '#16213e',
      borderRadius: 24,
      paddingHorizontal: 24,
      minHeight: 48,
      justifyContent: 'center',
    },
    retryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  })
);
