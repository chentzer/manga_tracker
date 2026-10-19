import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MEDIA_TYPE_LIST } from './mediaTypes';

// Which tab to search a highlighted / shared text in, when quickSearch.js
// can't tell (App.js). pick: { query, order, counts } from classify —
// the tabs with Library matches come first, with how many.
export default function QuickSearchPicker({ pick, onChoose, onClose }) {
  if (!pick) return null;
  const labelOf = (key) => (MEDIA_TYPE_LIST.find((m) => m.key === key) || {}).label || key;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Search in…</Text>
          <Text style={styles.query} numberOfLines={3}>
            “{pick.query}”
          </Text>
          {pick.order.map((key, i) => {
            const count = pick.counts[key] || 0;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.button, i === 0 && count > 0 && styles.buttonFirst]}
                onPress={() => onChoose(key)}
              >
                <Text style={styles.buttonText}>{labelOf(key)}</Text>
                {count > 0 ? <Text style={styles.count}>{count} in Library</Text> : null}
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#16213e', borderRadius: 12, padding: 16 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  query: { color: '#bbb', fontSize: 14, marginTop: 4, marginBottom: 12 },
  button: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1f4068',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 8,
  },
  buttonFirst: { backgroundColor: '#e94560' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  count: { color: '#fff', opacity: 0.8, fontSize: 12 },
  cancel: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  cancelText: { color: '#aaa', fontSize: 15 },
});
