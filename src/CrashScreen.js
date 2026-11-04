// Shows an error that would otherwise close the app at once, so it can be
// read (and shared) instead of the app just disappearing — release builds
// have no red error screen, and a phone without a cable gives no log.
//
// Two ways in: CrashGuard (wrapped round the app in App.js) catches errors
// while drawing the screen, and installCrashHandler catches the rest
// (effects, timers, promises the app doesn't handle), so a fatal one
// shows here instead of ending the app.
import React, { Component, useEffect, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

let fatal = null;
const listeners = new Set();

function describe(error) {
  if (!error) return 'Unknown error';
  const message = error.message || String(error);
  const stack = error.stack ? String(error.stack).split('\n').slice(0, 15).join('\n') : '';
  return stack && !stack.includes(message) ? `${message}\n\n${stack}` : stack || message;
}

export function installCrashHandler() {
  const ErrorUtils = global.ErrorUtils;
  if (!ErrorUtils || ErrorUtils.__crashScreen) return;
  ErrorUtils.__crashScreen = true;
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    if (!isFatal) {
      previous(error, isFatal);
      return;
    }
    // Kept until the crash screen is up to show it (it may not be yet).
    fatal = describe(error);
    listeners.forEach((l) => l(fatal));
  });
}

function CrashView({ text, onRetry }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.hint}>The app hit an error. Share it (or hold the text to copy it) and send it on, so it can be fixed.</Text>
      <ScrollView style={styles.box}>
        <Text style={styles.error} selectable>
          {text}
        </Text>
      </ScrollView>
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => Share.share({ message: text }).catch(() => {})}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Share error</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, styles.secondary]} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.buttonText}>Try again</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Errors outside drawing (installCrashHandler) switch the app to CrashView.
function FatalWatcher({ children }) {
  const [text, setText] = useState(fatal);
  useEffect(() => {
    listeners.add(setText);
    if (fatal) setText(fatal); // came before this was listening
    return () => listeners.delete(setText);
  }, []);
  if (text) {
    return (
      <CrashView
        text={text}
        onRetry={() => {
          fatal = null;
          setText(null);
        }}
      />
    );
  }
  return children;
}

export class CrashGuard extends Component {
  state = { text: null };

  static getDerivedStateFromError(error) {
    return { text: describe(error) };
  }

  componentDidCatch(error, info) {
    if (info && info.componentStack) {
      this.setState({ text: `${describe(error)}\n\nIn:${String(info.componentStack).split('\n').slice(0, 12).join('\n')}` });
    }
  }

  render() {
    if (this.state.text) return <CrashView text={this.state.text} onRetry={() => this.setState({ text: null })} />;
    return <FatalWatcher>{this.props.children}</FatalWatcher>;
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#121212', padding: 24, paddingTop: 56 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  hint: { color: '#c8c8d8', fontSize: 14, marginBottom: 16 },
  box: { flex: 1, backgroundColor: '#0f0f1e', borderRadius: 8, padding: 12 },
  error: { color: '#ffb4bf', fontSize: 12, fontFamily: 'monospace' },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  button: { flex: 1, minHeight: 48, borderRadius: 24, backgroundColor: '#006f8a', alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: '#1d1f20' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
