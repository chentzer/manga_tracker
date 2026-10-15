import React, { useEffect, useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { suppressNextRelock } from './relockGuard';

// A type's Reverse button: opens a reverse image search site (the type's
// `reverseSearch.url` in mediaTypes.js) in a full-screen window, where
// you pick a page image from the gallery to find what it comes from.
//
// When you tap a result whose link matches `reverseSearch.resultRegex`
// (default: the type's own urlRegex, on any host), this window closes
// and that code opens in the type's tab instead (onOpenCode). Links to
// anywhere else on the search site's pages don't open.

// Tells the app when the page opens the gallery picker, which briefly
// counts as leaving the app (see onMessage below).
const PICKER_WATCH_JS = `
  (function() {
    function tell() { window.ReactNativeWebView.postMessage('picker'); }
    var click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
      if (this.type === 'file') tell();
      return click.apply(this, arguments);
    };
    document.addEventListener('click', function(e) {
      if (e.target && e.target.type === 'file') tell();
    }, true);
  })();
  true;
`;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

export default function ReverseSearch({ visible, config, onClose, onOpenCode }) {
  const searchUrl = config.reverseSearch.url;
  const resultRegex = config.reverseSearch.resultRegex || config.urlRegex;
  const searchHost = hostOf(searchUrl);

  // While the gallery picker is open, coming back to the app isn't a
  // reason to lock it. The window ends as soon as the app is back.
  const pickerOpen = useRef(false);
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && pickerOpen.current) {
        pickerOpen.current = false;
        suppressNextRelock(1500);
      }
    });
    return () => subscription.remove();
  }, [visible]);

  const isSearchSite = (url) => {
    if (!/^https?:/i.test(url)) return true; // about:blank, data:, blob:
    const host = hostOf(url);
    return !!host && (host === searchHost || host.endsWith(`.${searchHost}`));
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Reverse search</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>
          Pick an image to search for. Tap a result to open it in the {config.label} tab.
        </Text>
        {visible ? (
          <WebView
            source={{ uri: searchUrl }}
            style={styles.webview}
            injectedJavaScriptBeforeContentLoaded={PICKER_WATCH_JS}
            onMessage={(event) => {
              if (event.nativeEvent.data === 'picker') {
                pickerOpen.current = true;
                suppressNextRelock(120000);
              }
            }}
            // Result links open in this same view (not a new window), so
            // they come through here.
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(request) => {
              const match = isSearchSite(request.url) ? null : request.url.match(resultRegex);
              if (match) {
                onOpenCode(config.extractId(match), config.extractPageNumber ? config.extractPageNumber(match) : null);
                return false;
              }
              return request.isTopFrame === false || isSearchSite(request.url);
            }}
          />
        ) : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#16213e',
  },
  title: { color: '#fff', fontSize: 16, fontWeight: '700' },
  close: { color: '#e94560', fontSize: 15, fontWeight: '600' },
  hint: { color: '#aaa', fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
  webview: { flex: 1 },
});
