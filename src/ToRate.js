import React from 'react';
import { Modal, View, Text, Image, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { getSetting, setSetting } from './db';
import { MEDIA_TYPES } from './mediaTypes';
import { TAP_SLOP } from './touch';
import { themed, useDarkMode } from './theme';

// The Library's ⭐ To rate button (EntryList.js): titles waiting for a score.
//   finished — you're at its last chapter/episode (progress = total) but
//              it isn't marked Completed: a series you caught up on that
//              has since ended (its total comes from AniList, re-asked
//              daily while it's missing). Rating it marks it Completed.
//   unrated  — Completed, with no score.
// "Skip" takes a title off the list on this phone (rateSkipped setting).

const key = (e) => `${e.media_type}:${e.source_id}`;

function skippedSet() {
  try {
    return new Set(JSON.parse(getSetting('rateSkipped', '[]')));
  } catch (e) {
    return new Set();
  }
}

export function skipRating(entry) {
  const skipped = skippedSet();
  skipped.add(key(entry));
  setSetting('rateSkipped', JSON.stringify([...skipped]));
}

export function findToRate(entries) {
  const skipped = skippedSet();
  const open = entries.filter((e) => !skipped.has(key(e)));
  const finished = open.filter(
    (e) => ['reading', 'on_hold'].includes(e.read_status) && e.total > 0 && (e.progress || 0) >= e.total
  );
  const unrated = open.filter((e) => e.read_status === 'read' && !e.score);
  return { finished, unrated, count: finished.length + unrated.length };
}

function Row({ entry, label, onRate, onSkip }) {
  const title = entry.title || entry.alt_title || entry.source_id;
  const type = (MEDIA_TYPES[entry.media_type] || {}).label || entry.media_type;
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={() => onRate(entry)}>
        {entry.local_image_path ? (
          <Image source={{ uri: entry.local_image_path }} style={styles.thumb} resizeMethod="resize" />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]} />
        )}
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {type} · {label}
          </Text>
        </View>
        <Text style={styles.rateText}>Rate</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onSkip(entry)} hitSlop={TAP_SLOP} style={styles.skip}>
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>
    </View>
  );
}

// list: findToRate's result. onRate(entry, { complete }) opens the score
// question; onSkip(entry) takes it off the list.
export default function ToRateModal({ visible, list, onRate, onSkip, onClose }) {
  useDarkMode(); // redraws in the other colours when Dark mode is switched
  const unit = (e) => (e.media_type === 'anime' ? 'ep' : 'ch');
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.heading}>⭐ To rate</Text>
          <ScrollView style={styles.scroll}>
            {list.finished.length ? (
              <>
                <Text style={styles.section}>Finished — not marked Completed yet</Text>
                <Text style={styles.hint}>
                  You've read up to the last chapter of these. Rating one marks it Completed.
                </Text>
                {list.finished.map((e) => (
                  <Row
                    key={key(e)}
                    entry={e}
                    label={`${unit(e)} ${e.progress} of ${e.total}`}
                    onRate={(entry) => onRate(entry, { complete: true })}
                    onSkip={onSkip}
                  />
                ))}
              </>
            ) : null}
            {list.unrated.length ? (
              <>
                <Text style={styles.section}>Completed — no score</Text>
                {list.unrated.map((e) => (
                  <Row
                    key={key(e)}
                    entry={e}
                    label={e.finish_date ? `finished ${e.finish_date}` : 'Completed'}
                    onRate={(entry) => onRate(entry, { complete: false })}
                    onSkip={onSkip}
                  />
                ))}
              </>
            ) : null}
            {!list.count ? <Text style={styles.hint}>Nothing to rate.</Text> : null}
          </ScrollView>
          <TouchableOpacity style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = themed(
  StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 16 },
    card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, maxHeight: '85%' },
    heading: { fontSize: 18, fontWeight: '700', color: '#222', marginBottom: 6 },
    scroll: { flexGrow: 0 },
    section: { fontSize: 13, fontWeight: '700', color: '#666', textTransform: 'uppercase', marginTop: 12 },
    hint: { fontSize: 12, color: '#666', marginTop: 4, marginBottom: 4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#ddd',
    },
    thumb: { width: 36, height: 50, borderRadius: 4 },
    thumbEmpty: { backgroundColor: '#eee' },
    rowText: { flex: 1 },
    rowTitle: { fontSize: 14, fontWeight: '600', color: '#222' },
    rowMeta: { fontSize: 12, color: '#666', marginTop: 2 },
    rateText: { color: '#e94560', fontWeight: '700', fontSize: 14 },
    skip: { paddingHorizontal: 4 },
    skipText: { color: '#666', fontSize: 13 },
    close: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
    closeText: { color: '#666', fontSize: 15 },
  })
);
