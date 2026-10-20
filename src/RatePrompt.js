import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SCORE_LABELS } from './malFormat';
import { themed, useDarkMode } from './theme';

// Asks for a score (MyAnimeList's 1–10) when a title is finished: marked
// Completed in the Library (EntryList.js), its last chapter/episode opened,
// or a reread finished (MediaWebView.js). prompt: { heading, message,
// score (the current one, shown chosen), actions: [{ label, onPress }] —
// extra buttons under the scores, e.g. "Just mark Completed" } or null.
// onRate(score) when one is tapped; onClose for "Not now" / back.
export default function RatePrompt({ prompt, onRate, onClose }) {
  useDarkMode(); // redraws in the other colours when Dark mode is switched
  if (!prompt) return null;
  const scores = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.heading}>{prompt.heading}</Text>
          {prompt.message ? <Text style={styles.message}>{prompt.message}</Text> : null}
          <View style={styles.grid}>
            {scores.map((score) => {
              const current = Number(prompt.score) === score;
              return (
                <TouchableOpacity
                  key={score}
                  style={[styles.score, current && styles.scoreCurrent]}
                  onPress={() => onRate(score)}
                >
                  <Text style={[styles.scoreNumber, current && styles.scoreTextCurrent]}>{score}</Text>
                  <Text style={[styles.scoreLabel, current && styles.scoreTextCurrent]} numberOfLines={1}>
                    {SCORE_LABELS[score]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {(prompt.actions || []).map((action) => (
            <TouchableOpacity key={action.label} style={styles.action} onPress={action.onPress}>
              <Text style={styles.actionText}>{action.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>{prompt.closeLabel || 'Not now'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = themed(
  StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 },
    card: { backgroundColor: '#fff', borderRadius: 12, padding: 18 },
    heading: { fontSize: 18, fontWeight: '700', color: '#222' },
    message: { fontSize: 14, color: '#666', marginTop: 6 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
    score: {
      width: '48%',
      flexGrow: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#ddd',
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    scoreCurrent: { backgroundColor: '#16213e', borderColor: '#16213e' },
    scoreNumber: { fontSize: 16, fontWeight: '700', color: '#16213e', minWidth: 22 },
    scoreLabel: { flex: 1, fontSize: 13, color: '#555' },
    scoreTextCurrent: { color: '#fff' },
    action: { alignItems: 'center', paddingVertical: 12, marginTop: 10, borderRadius: 8, backgroundColor: '#e3ecfa' },
    actionText: { color: '#0f3460', fontSize: 15, fontWeight: '600' },
    close: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
    closeText: { color: '#888', fontSize: 15 },
  })
);
