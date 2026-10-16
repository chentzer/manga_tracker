import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Modal,
  Linking,
  ScrollView,
  Alert,
  TextInput,
  Switch,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  getAllEntries,
  getEntry,
  setTags,
  updateEntryFields,
  parseTags,
  deleteEntry,
  clearAllEntries,
} from './db';
import { MEDIA_TYPES, MEDIA_TYPE_LIST } from './mediaTypes';
import { maybeBackupLibraryToDrive } from './backup';
import { exportMalList, pickAndImportMalList, isImportedSourceId, MAL_LISTS } from './malList';
import { SCORE_LABELS, PRIORITIES, CONFLICT_FIELDS, normalizeDate, todayString, malTypeOf } from './malFormat';

// MyAnimeList's 1-10 scale.
const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Fallback for any media type that doesn't define its own readStatusLabels.
const DEFAULT_READ_STATUS_LABELS = {
  reading: 'Reading',
  read: 'Read',
  on_hold: 'On Hold',
  dropped: 'Dropped',
  want: 'Want to Read',
};
// The five statuses, in MyAnimeList's order. `label` is the key into a
// type's readStatusLabels.
const READ_STATUSES = [
  { key: 'reading', label: 'reading', icon: '▶️' },
  { key: 'read', label: 'read', icon: '📖' },
  { key: 'on_hold', label: 'on_hold', icon: '⏸️' },
  { key: 'dropped', label: 'dropped', icon: '✖️' },
  { key: 'want_to_read', label: 'want', icon: '📌' },
];
const READ_STATUS_ICONS = Object.fromEntries(READ_STATUSES.map((s) => [s.key, s.icon]));

function getReadStatusLabels(mediaType) {
  return MEDIA_TYPES[mediaType]?.readStatusLabels || DEFAULT_READ_STATUS_LABELS;
}

function toCount(text) {
  const n = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// Words per type for the progress fields.
function progressWords(mediaType) {
  return mediaType === 'anime'
    ? { unit: 'Episodes', short: 'ep', repeat: 'Times rewatched', repeating: 'Rewatching', again: 'Rewatch' }
    : { unit: 'Chapters', short: 'ch', repeat: 'Times reread', repeating: 'Rereading', again: 'Reread' };
}

// "12/24 ep", "60 ch", or null when there's no progress yet.
function progressText(entry) {
  if (!entry.progress && !entry.total) return null;
  const { short } = progressWords(entry.media_type);
  return entry.total ? `${entry.progress || 0}/${entry.total} ${short}` : `${entry.progress} ${short}`;
}

// MyAnimeList's 1-10 score, with its wording for the chosen one.
function ScorePicker({ score, onRate }) {
  return (
    <View>
      <View style={styles.scoreRow}>
        {SCORES.map((n) => (
          <TouchableOpacity
            key={n}
            style={[styles.scoreChip, score === n && styles.scoreChipActive]}
            onPress={() => onRate(score === n ? null : n)}
          >
            <Text style={score === n ? styles.scoreTextActive : styles.scoreText}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.scoreLabel}>{score ? `${score} · ${SCORE_LABELS[score]}` : 'Not rated'}</Text>
    </View>
  );
}

// A text box that saves when you leave it (or press return). onCommit
// can return false to reject the text, which puts the old value back.
function EditableText({ value, onCommit, ...props }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    if (text === (value ?? '')) return;
    if (onCommit(text) === false) setText(value ?? '');
  };
  return <TextInput value={text} onChangeText={setText} onBlur={commit} onSubmitEditing={commit} {...props} />;
}

// − [count] + , optionally "of [total]".
function CountField({ value, onChange, total, onTotalChange }) {
  const count = value || 0;
  const max = total > 0 ? total : Infinity;
  return (
    <View style={styles.countRow}>
      <TouchableOpacity style={styles.stepButton} onPress={() => onChange(Math.max(0, count - 1))}>
        <Text style={styles.stepButtonText}>−</Text>
      </TouchableOpacity>
      <EditableText
        style={styles.countInput}
        value={String(count)}
        keyboardType="number-pad"
        onCommit={(t) => onChange(Math.min(max, toCount(t)))}
      />
      <TouchableOpacity style={styles.stepButton} onPress={() => onChange(Math.min(max, count + 1))}>
        <Text style={styles.stepButtonText}>+</Text>
      </TouchableOpacity>
      {onTotalChange ? (
        <>
          <Text style={styles.countOf}>of</Text>
          <EditableText
            style={styles.countInput}
            value={total ? String(total) : ''}
            placeholder="?"
            keyboardType="number-pad"
            onCommit={(t) => onTotalChange(toCount(t))}
          />
        </>
      ) : null}
    </View>
  );
}

// YYYY-MM-DD (MAL allows 00 for an unknown month or day), with Today and
// clear buttons.
function DateField({ value, onChange }) {
  return (
    <View style={styles.dateRow}>
      <EditableText
        style={styles.dateInput}
        value={value || ''}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        onCommit={(t) => {
          const date = normalizeDate(t);
          if (t.trim() && !date) {
            Alert.alert('Date not recognised', 'Use YYYY-MM-DD, e.g. 2026-10-16.');
            return false;
          }
          onChange(date);
          return true;
        }}
      />
      <TouchableOpacity style={styles.dateButton} onPress={() => onChange(todayString())}>
        <Text style={styles.dateButtonText}>Today</Text>
      </TouchableOpacity>
      {value ? (
        <TouchableOpacity style={styles.dateButton} onPress={() => onChange(null)}>
          <Text style={styles.dateButtonText}>✕</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function PriorityPicker({ value, onChange }) {
  const current = PRIORITIES.includes(value) ? value : 'low';
  return (
    <View style={styles.readStatusRow}>
      {PRIORITIES.map((p) => (
        <TouchableOpacity
          key={p}
          style={[styles.readStatusChip, current === p && styles.readStatusChipActive]}
          onPress={() => onChange(p)}
        >
          <Text style={current === p ? styles.readStatusTextActive : styles.readStatusText}>
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// Labels come from the entry's own media type (e.g. "Read" for manga,
// "Watched" for anime) — the stored values are the same for every type,
// only the wording differs.
function ReadStatusToggle({ status, mediaType, onChange }) {
  const labels = getReadStatusLabels(mediaType);
  const options = READ_STATUSES.map((s) => ({ key: s.key, label: `${s.icon} ${labels[s.label]}` }));
  return (
    <View style={styles.readStatusRow}>
      {options.map((s) => (
        <TouchableOpacity
          key={s.key}
          style={[styles.readStatusChip, status === s.key && styles.readStatusChipActive]}
          onPress={() => onChange(status === s.key ? null : s.key)}
        >
          <Text style={status === s.key ? styles.readStatusTextActive : styles.readStatusText}>
            {s.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState('');

  const addTag = () => {
    const value = input.trim();
    if (!value) return;
    if (!tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      onChange([...tags, value]);
    }
    setInput('');
  };

  const removeTag = (tag) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <View>
      {tags.length > 0 ? (
        <View style={styles.tagWrap}>
          {tags.map((tag) => (
            <TouchableOpacity key={tag} style={styles.tagChip} onPress={() => removeTag(tag)}>
              <Text style={styles.tagChipText}>{tag} ✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <View style={styles.tagInputRow}>
        <TextInput
          style={styles.tagInput}
          placeholder="Add a tag…"
          placeholderTextColor="#999"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={addTag}
          returnKeyType="done"
          autoCapitalize="none"
        />
        <TouchableOpacity style={styles.tagAddButton} onPress={addTag}>
          <Text style={styles.tagAddButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function FullImageModal({ uri, visible, onClose }) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.fullImageOverlay} activeOpacity={1} onPress={onClose}>
        {uri ? <Image source={{ uri }} style={styles.fullImage} resizeMode="contain" /> : null}
      </TouchableOpacity>
    </Modal>
  );
}

// { column: value from your MAL list } where an import disagreed with the
// app (malList.js), or {}.
function conflictsOf(entry) {
  try {
    return entry && entry.mal_conflicts ? JSON.parse(entry.mal_conflicts) : {};
  } catch (e) {
    return {};
  }
}

// `fields` plus mal_conflicts without the columns being set: changing a
// detail yourself settles its difference with MAL.
function settlingConflicts(entry, fields) {
  const conflicts = conflictsOf(entry);
  const keys = Object.keys(fields).filter((k) => k in conflicts);
  if (keys.length === 0) return fields;
  keys.forEach((k) => delete conflicts[k]);
  return { ...fields, mal_conflicts: Object.keys(conflicts).length ? JSON.stringify(conflicts) : null };
}

// How a value reads in the "differs from MAL" list.
function describeValue(entry, key, value) {
  if (value === null || value === undefined || value === '' || value === 0) return '—';
  if (key === 'read_status') {
    const status = READ_STATUSES.find((s) => s.key === value);
    return status ? `${status.icon} ${getReadStatusLabels(entry.media_type)[status.label]}` : String(value);
  }
  if (key === 'score') return `${value} · ${SCORE_LABELS[value] || ''}`;
  if (key === 'repeating') return value ? 'Yes' : 'No';
  if (key === 'priority') return value.charAt(0).toUpperCase() + value.slice(1);
  return String(value);
}

// Details where your imported MAL list disagrees with the app: pick
// either side per detail, or change it yourself further down (that
// settles it too).
function ConflictReview({ entry, onResolve }) {
  const conflicts = conflictsOf(entry);
  const fields = CONFLICT_FIELDS.filter((f) => f.key in conflicts);
  if (fields.length === 0) return null;
  return (
    <View style={styles.conflictBox}>
      <Text style={styles.conflictTitle}>⚠ Differs from your MyAnimeList list</Text>
      <Text style={styles.conflictHint}>
        Choose which to keep, or change it yourself below.
      </Text>
      {fields.map(({ key, label }) => (
        <View key={key} style={styles.conflictRow}>
          <Text style={styles.conflictLabel}>{label}</Text>
          <View style={styles.conflictChoices}>
            <TouchableOpacity style={styles.conflictChoice} onPress={() => onResolve(key, false)}>
              <Text style={styles.conflictWhich}>App</Text>
              <Text style={styles.conflictValue}>{describeValue(entry, key, entry[key])}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.conflictChoice} onPress={() => onResolve(key, true)}>
              <Text style={styles.conflictWhich}>MyAnimeList</Text>
              <Text style={styles.conflictValue}>{describeValue(entry, key, conflicts[key])}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
    </View>
  );
}

function DetailModal({
  entry,
  onClose,
  onRate,
  onSetTags,
  onSetReadStatus,
  onUpdate,
  onResolveConflict,
  onOpenNext,
  onSetRepeating,
  onPickAgain,
  onDelete,
}) {
  const [fullImageVisible, setFullImageVisible] = useState(false);

  if (!entry) return null;
  const tags = parseTags(entry.tags);
  const words = progressWords(entry.media_type);
  const update = (fields) => onUpdate(entry, fields);
  return (
    <Modal visible={!!entry} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.detailOverlay}>
        <View style={styles.detailCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <ConflictReview entry={entry} onResolve={(key, useMal) => onResolveConflict(entry, key, useMal)} />
            {entry.local_image_path ? (
              <TouchableOpacity onPress={() => setFullImageVisible(true)} activeOpacity={0.9}>
                <Image source={{ uri: entry.local_image_path }} style={styles.detailImage} />
              </TouchableOpacity>
            ) : (
              <View style={[styles.detailImage, styles.thumbPlaceholder]} />
            )}
            <Text style={styles.detailTitle}>{entry.title || entry.source_id}</Text>
            {entry.alt_title ? <Text style={styles.detailAltTitle}>{entry.alt_title}</Text> : null}
            {entry.author ? <Text style={styles.detailAuthor}>{entry.author}</Text> : null}

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Type</Text>
              <Text style={styles.detailValue}>
                {entry.series_type ? `${entry.media_type} · ${entry.series_type}` : entry.media_type}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Code</Text>
              <Text style={styles.detailValue}>{entry.source_id}</Text>
            </View>
            {entry.mal_id ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>MyAnimeList</Text>
                <Text style={styles.detailValue}>{entry.mal_id}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Added</Text>
              <Text style={styles.detailValue}>{entry.created_at}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Sync</Text>
              <Text style={styles.detailValue}>
                {entry.sync_status === 'synced' ? '☁️ Synced to Drive' : '📴 Local only'}
              </Text>
            </View>

            <Text style={styles.detailLabel}>
              {entry.media_type === 'anime' ? 'Watch status' : 'Read status'}
            </Text>
            <ReadStatusToggle
              status={entry.read_status}
              mediaType={entry.media_type}
              onChange={(status) => onSetReadStatus(entry, status)}
            />

            <Text style={styles.detailLabel}>Score</Text>
            <ScorePicker score={entry.score} onRate={(score) => onRate(entry, score)} />

            <Text style={styles.detailLabel}>{words.unit}</Text>
            <CountField
              value={entry.progress}
              onChange={(progress) => update({ progress })}
              total={entry.total}
              onTotalChange={(total) => update({ total })}
            />
            {entry.media_type === 'manga' ? (
              <>
                <Text style={styles.detailLabel}>Volumes</Text>
                <CountField
                  value={entry.progress_volumes}
                  onChange={(progress_volumes) => update({ progress_volumes })}
                  total={entry.total_volumes}
                  onTotalChange={(total_volumes) => update({ total_volumes })}
                />
              </>
            ) : null}

            <Text style={styles.detailLabel}>Start date</Text>
            <DateField value={entry.start_date} onChange={(start_date) => update({ start_date })} />
            <Text style={styles.detailLabel}>Finish date</Text>
            <DateField value={entry.finish_date} onChange={(finish_date) => update({ finish_date })} />

            <Text style={styles.detailLabel}>{words.repeat}</Text>
            <CountField value={entry.times_repeated} onChange={(times_repeated) => update({ times_repeated })} />
            <View style={styles.switchRow}>
              <Text style={styles.detailValue}>{words.repeating}</Text>
              <Switch value={!!entry.repeating} onValueChange={(on) => onSetRepeating(entry, on)} />
            </View>
            {entry.repeating ? (
              <>
                <Text style={styles.detailLabel}>
                  {words.again}: {words.unit.toLowerCase()} so far
                </Text>
                <CountField
                  value={entry.repeat_progress}
                  total={entry.total}
                  onChange={(repeat_progress) => update({ repeat_progress })}
                />
              </>
            ) : null}

            <Text style={styles.detailLabel}>Priority</Text>
            <PriorityPicker value={entry.priority} onChange={(priority) => update({ priority })} />

            <Text style={styles.detailLabel}>Tags</Text>
            <TagEditor tags={tags} onChange={(newTags) => onSetTags(entry, newTags)} />

            <Text style={styles.detailLabel}>Comments</Text>
            <EditableText
              style={styles.commentsInput}
              value={entry.comments || ''}
              placeholder="Notes"
              multiline
              onCommit={(t) => update({ comments: t.trim() || null })}
            />

            {entry.source_url ? (
              <TouchableOpacity
                style={styles.detailUrlButton}
                onPress={() => Linking.openURL(entry.source_url)}
              >
                <Text style={styles.detailUrlText} numberOfLines={1}>
                  {entry.source_url}
                </Text>
              </TouchableOpacity>
            ) : null}
          </ScrollView>

          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailNextButton} onPress={() => onOpenNext(entry)}>
              <Text style={styles.detailNextButtonText}>
                {entry.read_status === 'read' && !entry.repeating
                  ? '✓ Completed'
                  : entry.repeating
                    ? `▶ ${words.again} ${words.short} ${(entry.repeat_progress || 0) + 1}`
                    : `▶ ${entry.media_type === 'anime' ? 'Watch' : 'Read'} ${words.short} ${(entry.progress || 0) + 1}`}
              </Text>
            </TouchableOpacity>
            {onPickAgain ? (
              <TouchableOpacity style={styles.detailNextButton} onPress={onPickAgain}>
                <Text style={styles.detailNextButtonText}>🎲 Again</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailDeleteButton} onPress={() => onDelete(entry)}>
              <Text style={styles.detailDeleteButtonText}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onClose}>
              <Text style={styles.detailCloseButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <FullImageModal
        uri={entry.local_image_path}
        visible={fullImageVisible}
        onClose={() => setFullImageVisible(false)}
      />
    </Modal>
  );
}

const FILTERS = [{ key: null, label: 'All' }, ...MEDIA_TYPE_LIST.map((m) => ({ key: m.key, label: m.label }))];
const SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'rating', label: 'Top Rated' },
];
const RATING_FILTERS = [
  { key: null, label: 'Any score' },
  { key: 9, label: '★9+' },
  { key: 8, label: '★8+' },
  { key: 7, label: '★7+' },
  { key: 6, label: '★6+' },
  { key: 5, label: '★5+' },
];
const READ_STATUS_FILTERS = [
  { key: null, label: 'Any status' },
  { key: 'reading', label: '▶️ Reading/Watching' },
  { key: 'read', label: '📖 Read/Watched' },
  { key: 'on_hold', label: '⏸️ On Hold' },
  { key: 'dropped', label: '✖️ Dropped' },
  { key: 'want_to_read', label: '📌 Want to Read/Watch' },
];

// The 🎲 Random button: picks one entry matching the chosen types and
// statuses (none chosen in a row = any), skipping ones already picked
// this round until every match has been shown.
const RANDOM_STATUS_CHOICES = [
  { key: 'want_to_read', label: '📌 Plan to Read/Watch' },
  { key: 'reading', label: '▶️ Reading/Watching' },
];
const DEFAULT_RANDOM_CHOICE = { types: [], statuses: ['want_to_read', 'reading'] };

function toggled(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function RandomModal({ visible, choice, onChange, onPick, onClose }) {
  const chip = (active, label, onPress) => (
    <TouchableOpacity
      key={label}
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
    >
      <Text style={active ? styles.filterTextActive : styles.filterText}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.detailOverlay}>
        <View style={styles.randomCard}>
          <Text style={styles.detailTitle}>🎲 Random</Text>
          <Text style={styles.randomHint}>Choose any number in each row — none means any.</Text>
          <Text style={styles.detailLabel}>Type</Text>
          <View style={styles.readStatusRow}>
            {MEDIA_TYPE_LIST.map((m) =>
              chip(choice.types.includes(m.key), m.label, () =>
                onChange({ ...choice, types: toggled(choice.types, m.key) })
              )
            )}
          </View>
          <Text style={styles.detailLabel}>Status</Text>
          <View style={styles.readStatusRow}>
            {RANDOM_STATUS_CHOICES.map((s) =>
              chip(choice.statuses.includes(s.key), s.label, () =>
                onChange({ ...choice, statuses: toggled(choice.statuses, s.key) })
              )
            )}
          </View>
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailDeleteButton} onPress={onClose}>
              <Text style={styles.detailDeleteButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onPick}>
              <Text style={styles.detailCloseButtonText}>Pick</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function EntryList({ active = true, focusKey = null, onFocusHandled, onOpenInTab }) {
  const [entries, setEntries] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState(null); // null = all types
  const [sort, setSort] = useState('newest');
  const [artistFilter, setArtistFilter] = useState('');
  const [artistModalVisible, setArtistModalVisible] = useState(false);
  const [minRating, setMinRating] = useState(null);
  const [readStatusFilter, setReadStatusFilter] = useState(null);
  const [tagFilters, setTagFilters] = useState([]); // array of selected tag strings (AND logic)
  const [selectedKey, setSelectedKey] = useState(null); // `${media_type}:${source_id}` or null
  const [conflictsOnly, setConflictsOnly] = useState(false); // "⚠ to review" chip

  const load = useCallback(() => {
    setEntries(getAllEntries(filter));
  }, [filter]);

  useEffect(load, [load]);

  // EntryList now stays mounted permanently (App.js toggles visibility
  // rather than mounting/unmounting on tab switches, so webviews keep
  // their scroll/navigation state) — which means the old "remount on
  // every visit reloads fresh data" behavior no longer happens for
  // free. This re-fetches specifically when the Library tab becomes
  // the active one, so anything saved while you were on another tab
  // still shows up without needing a manual pull-to-refresh.
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // Set by a "View in Library" button on a browsing tab — opens that
  // entry's detail sheet directly rather than leaving you to find it
  // in the list yourself. Also clears any active filters that might
  // otherwise hide the entry (e.g. a type filter set to the wrong
  // media type, or a rating/tag filter it doesn't match), since the
  // whole point is to land on it reliably. Reported back to App.js via
  // onFocusHandled so the same key doesn't re-trigger this again later.
  useEffect(() => {
    if (!focusKey) return;
    setFilter(null);
    setMinRating(null);
    setReadStatusFilter(null);
    setTagFilters([]);
    setArtistFilter('');
    setSelectedKey(focusKey);
    onFocusHandled?.();
  }, [focusKey, onFocusHandled]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    setRefreshing(false);
  }, [load]);

  // Filtering and sorting are both done client-side over the already
  // media-type-filtered SQL result: artist search and rating threshold
  // are cheap to run over what's typically a small in-memory list, and
  // keeping them here means toggling either stays instant with no
  // extra query.
  const filteredEntries = entries.filter((e) => {
    if (artistFilter.trim()) {
      const needle = artistFilter.trim().toLowerCase();
      if (!e.author || !e.author.toLowerCase().includes(needle)) return false;
    }
    if (minRating !== null && (e.score || 0) < minRating) return false;
    if (readStatusFilter !== null && e.read_status !== readStatusFilter) return false;
    if (conflictsOnly && !e.mal_conflicts) return false;
    if (tagFilters.length > 0) {
      const entryTags = parseTags(e.tags).map((t) => t.toLowerCase());
      const hasAllSelected = tagFilters.every((t) => entryTags.includes(t.toLowerCase()));
      if (!hasAllSelected) return false;
    }
    return true;
  });

  const displayEntries =
    sort === 'rating'
      ? [...filteredEntries].sort((a, b) => (b.score || 0) - (a.score || 0))
      : filteredEntries;

  // Every distinct tag currently in use, for the filter chip row —
  // computed from the (type-filtered) entries list, so it naturally
  // narrows when switching between the Manga/Anime/All chips above.
  const allTags = useMemo(() => {
    const set = new Set();
    entries.forEach((e) => parseTags(e.tags).forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const toggleTagFilter = useCallback((tag) => {
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  }, []);

  // { [mediaType]: string[] } of distinct authors, sorted alphabetically.
  const [artistGroups, setArtistGroups] = useState({});

  const openArtistFilter = useCallback(() => {
    // Pulls a fresh, unfiltered set regardless of the current type-filter
    // chip (`entries` is already scoped to that chip, which would hide
    // e.g. anime artists entirely while "Manga" is selected) — this
    // picker is meant to show every artist across every type at once,
    // grouped, independent of whatever the list itself is currently
    // filtered to.
    const all = getAllEntries(null);
    const groups = {};
    all.forEach((e) => {
      if (!e.author) return;
      if (!groups[e.media_type]) groups[e.media_type] = new Set();
      groups[e.media_type].add(e.author);
    });
    const sorted = {};
    Object.keys(groups).forEach((type) => {
      sorted[type] = Array.from(groups[type]).sort((a, b) => a.localeCompare(b));
    });
    setArtistGroups(sorted);
    setArtistModalVisible(true);
  }, []);

  const selectArtist = useCallback((artist) => {
    setArtistFilter(artist);
    setArtistModalVisible(false);
  }, []);

  // Fires the auto-backup after a change, but only surfaces it to the
  // user when it actually failed — silent on success (and on the
  // expected no-op when Drive isn't connected), since a popup after
  // every single rating tap would be unbearably noisy. This is what
  // makes an otherwise-invisible failure actually visible, rather than
  // the app quietly falling behind until a manual Backup Now happens to
  // catch it later.
  const backupSilently = useCallback(() => {
    maybeBackupLibraryToDrive().then((result) => {
      if (result.attempted && !result.success) {
        Alert.alert('Drive backup failed', result.error || 'Unknown error — try Backup Now from the header.');
      }
    });
  }, []);

  const rate = useCallback(
    (item, score) => {
      updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, { score }));
      load(); // refresh so the tapped star reflects immediately
      backupSilently();
    },
    [load, backupSilently]
  );

  const handleSetTags = useCallback(
    (item, newTags) => {
      setTags(item.source_id, item.media_type, newTags);
      const settled = settlingConflicts(item, { tags: null });
      if ('mal_conflicts' in settled) {
        updateEntryFields(item.source_id, item.media_type, { mal_conflicts: settled.mal_conflicts });
      }
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  // Like MyAnimeList: starting fills in the start date, completing fills
  // in the finish date and sets progress to the full count (when known).
  const handleSetReadStatus = useCallback(
    (item, status) => {
      const fields = { read_status: status };
      if (status === 'reading' && !item.start_date) fields.start_date = todayString();
      if (status === 'read') {
        if (!item.finish_date) fields.finish_date = todayString();
        if (item.total) fields.progress = item.total;
        if (item.total_volumes) fields.progress_volumes = item.total_volumes;
      }
      updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, fields));
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  const handleUpdate = useCallback(
    (item, fields) => {
      updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, fields));
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  // Settles one "differs from MAL" detail: takes MAL's value, or keeps the
  // app's.
  const handleResolveConflict = useCallback(
    (item, key, useMal) => {
      const malValue = conflictsOf(item)[key];
      const fields = settlingConflicts(item, { [key]: malValue });
      if (!useMal) delete fields[key];
      updateEntryFields(item.source_id, item.media_type, fields);
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  // "▶ Watch ep N" / "▶ Read ch N": opens the episode/chapter after your
  // progress in its tab (openNext in mediaTypes.js; the tab says if it
  // doesn't exist yet).
  const handleOpenNext = useCallback(
    (item) => {
      const config = MEDIA_TYPES[item.media_type];
      const title = item.title || item.alt_title || item.source_id;
      // Sites mostly list English titles, which imported titles keep as
      // their alternate title.
      const searchTitle = item.alt_title || item.title || item.source_id;
      const unit = item.media_type === 'anime' ? 'episode' : 'chapter';
      const repeating = item.read_status === 'read' && !!item.repeating;
      if (item.read_status === 'read' && !repeating) {
        const done = item.total ? ` (${item.progress || 0}/${item.total} ${unit}s)` : '';
        Alert.alert('Completed', `"${title}" is completed${done}.`);
        return;
      }
      // During a rewatch/reread, the next one after its own position.
      const n = ((repeating ? item.repeat_progress : item.progress) || 0) + 1;
      if (item.total && n > item.total) {
        Alert.alert(`No next ${unit}`, `"${title}" has ${item.total} ${unit}s and you're at ${n - 1}.`);
        return;
      }
      if (isImportedSourceId(item.source_id)) {
        Alert.alert(
          'Not opened on the site yet',
          `"${title}" came from your MyAnimeList list, so its page on the site isn't known yet. Search for it, open it once, and this button will work.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Search',
              onPress: () => {
                setSelectedKey(null);
                onOpenInTab?.(item.media_type, { url: config.buildSearchUrl(searchTitle) });
              },
            },
          ]
        );
        return;
      }
      setSelectedKey(null);
      onOpenInTab?.(item.media_type, { ...config.openNext(item, n), expect: item.source_id });
    },
    [onOpenInTab]
  );

  // The Rewatching/Rereading switch. Turning it off yourself asks whether
  // that counts as a finished rewatch/reread (it's counted on its own when
  // you open the last episode/chapter and the total is known).
  const handleSetRepeating = useCallback(
    (item, on) => {
      if (on) {
        handleUpdate(item, { repeating: 1, repeat_progress: 0 });
        return;
      }
      const noun = item.media_type === 'anime' ? 'rewatch' : 'reread';
      const stop = (counted) =>
        handleUpdate(item, {
          repeating: 0,
          repeat_progress: 0,
          ...(counted ? { times_repeated: (item.times_repeated || 0) + 1 } : {}),
        });
      Alert.alert(`Finished this ${noun}?`, `Count it in times ${noun === 'rewatch' ? 'rewatched' : 'reread'}?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'No, just stop', onPress: () => stop(false) },
        { text: 'Yes, count it', onPress: () => stop(true) },
      ]);
    },
    [handleUpdate]
  );

  // 🎲 Random: its window, its choices, and what this round has shown.
  const [randomVisible, setRandomVisible] = useState(false);
  const [randomChoice, setRandomChoice] = useState(DEFAULT_RANDOM_CHOICE);
  const randomShown = useRef(new Set());
  const [randomOpened, setRandomOpened] = useState(false);

  const pickRandomNow = useCallback(() => {
    const pool = getAllEntries(null).filter(
      (e) =>
        (randomChoice.types.length === 0 || randomChoice.types.includes(e.media_type)) &&
        (randomChoice.statuses.length === 0 || randomChoice.statuses.includes(e.read_status))
    );
    if (pool.length === 0) {
      Alert.alert('Nothing to pick', 'No entries match those choices.');
      return;
    }
    const keyOf = (e) => `${e.media_type}:${e.source_id}`;
    let options = pool.filter((e) => !randomShown.current.has(keyOf(e)));
    if (options.length === 0) {
      // Every match has been shown: start over, avoiding the one on screen.
      randomShown.current = new Set();
      options = pool.length > 1 ? pool.filter((e) => keyOf(e) !== selectedKey) : pool;
    }
    const pick = options[Math.floor(Math.random() * options.length)];
    randomShown.current.add(keyOf(pick));
    setRandomVisible(false);
    setRandomOpened(true);
    setSelectedKey(keyOf(pick));
  }, [randomChoice, selectedKey]);

  const openRandom = useCallback(() => {
    randomShown.current = new Set();
    setRandomVisible(true);
  }, []);

  // "Again" is only offered on details opened by Random.
  useEffect(() => {
    if (!selectedKey) setRandomOpened(false);
  }, [selectedKey]);

  const handleDeleteEntry = useCallback(
    (item) => {
      Alert.alert(
        'Delete this entry?',
        `This permanently removes "${item.title || item.source_id}" and its saved thumbnail from this phone. This can't be undone. (Anything already backed up to Google Drive is left untouched there.)`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              if (item.local_image_path) {
                await FileSystem.deleteAsync(item.local_image_path, { idempotent: true }).catch(() => {});
              }
              deleteEntry(item.source_id, item.media_type);
              setSelectedKey(null); // close the detail modal since its entry no longer exists
              load();
              backupSilently(); // reflect the removal in the Drive CSV too
            },
          },
        ]
      );
    },
    [load, backupSilently]
  );

  // Looked up by key rather than kept as a snapshot object, so the modal
  // reflects rating changes made while it's open instead of going stale.
  // Random can pick outside the current type filter, so fall back to the
  // database.
  const selectedEntry = selectedKey
    ? entries.find((e) => `${e.media_type}:${e.source_id}` === selectedKey) ||
      getEntry(selectedKey.slice(selectedKey.indexOf(':') + 1), selectedKey.split(':')[0])
    : null;
  const conflictCount = entries.filter((e) => e.mal_conflicts).length;

  // Export/Import of MyAnimeList lists (see malList.js). Export works on
  // one type: the selected type chip, or it asks when "All" is selected.
  const [busy, setBusy] = useState(false);

  const runExport = useCallback(async (malType) => {
    setBusy(true);
    try {
      const result = await exportMalList(malType);
      const listLabel = MAL_LISTS.find((l) => l.key === malType).label;
      const lines = [`${result.exported} ${listLabel} entries exported.`];
      if (result.hentai > 0) lines.push(`${result.hentai} hentai titles left out.`);
      if (result.skipped > 0) {
        lines.push(
          `${result.skipped} left out: no MyAnimeList id yet. Open them once in their tab to pick it up.`
        );
      }
      if (result.drive === 'saved') {
        lines.push('Saved to Google Drive (replacing the last export).');
      } else if (result.drive === 'not connected') {
        lines.push("Not saved to Google Drive: Drive isn't connected.");
      } else {
        lines.push(`Saving to Google Drive failed: ${result.drive}`);
      }
      Alert.alert('Export done', lines.join('\n\n'));
    } catch (err) {
      Alert.alert('Export failed', err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleExport = useCallback(() => {
    if (filter) {
      runExport(malTypeOf(filter));
      return;
    }
    Alert.alert('Export which list?', "Exports in MyAnimeList's list format. Manga includes manhwa.", [
      ...MAL_LISTS.map((l) => ({ text: l.label, onPress: () => runExport(l.key) })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [filter, runExport]);

  const handleImport = useCallback(async () => {
    setBusy(true);
    try {
      const result = await pickAndImportMalList();
      if (!result) return; // picker cancelled
      load();
      backupSilently();
      const label = MAL_LISTS.find((l) => l.key === result.mediaType).label;
      const lines = [`${result.added} ${label} titles added.`];
      if (result.manhwa > 0) lines.push(`${result.manhwa} Korean titles are under Manhwa.`);
      if (result.aniListFailed) {
        lines.push("Couldn't reach AniList, so manhwa couldn't be told apart: everything went to Manga.");
      }
      if (result.linked > 0) {
        lines.push(`${result.linked} already in your library got their MyAnimeList id.`);
      }
      if (result.alreadyThere > 0) lines.push(`${result.alreadyThere} were already there.`);
      if (result.differing > 0) {
        lines.push(
          `${result.differing} differ from what's in the app — tap "⚠ To review" to go through them. Nothing in the app was overwritten.`
        );
      }
      if (result.added > 0) {
        lines.push('Added titles have no cover yet; open one in its tab to fill it in.');
      }
      Alert.alert('Import done', lines.join('\n\n'));
    } catch (err) {
      Alert.alert('Import failed', err.message);
    } finally {
      setBusy(false);
    }
  }, [load, backupSilently]);

  const handleClearAll = useCallback(() => {
    if (entries.length === 0) return;

    Alert.alert(
      'Clear entire library?',
      `This permanently deletes all ${entries.length} recorded entries and their saved thumbnails from this phone. This can't be undone. (Anything already backed up to Google Drive is left untouched there.)`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Everything',
          style: 'destructive',
          onPress: async () => {
            // Best-effort local file cleanup — DB row deletion still
            // proceeds even if some image files fail to remove.
            await Promise.all(
              entries
                .filter((e) => e.local_image_path)
                .map((e) =>
                  FileSystem.deleteAsync(e.local_image_path, { idempotent: true }).catch(() => {})
                )
            );
            clearAllEntries();
            load();
            backupSilently(); // reflect the now-empty library in the Drive CSV too
          },
        },
      ]
    );
  }, [entries, load, backupSilently]);

  return (
    <View style={styles.container}>
      <View style={[styles.filterBar, styles.filterBarWrap]}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key ?? 'all'}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={filter === f.key ? styles.filterTextActive : styles.filterText}>{f.label}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.listFileChip, styles.listFileChipFirst]}
          onPress={handleExport}
          disabled={busy}
        >
          <Text style={styles.listFileText}>⬆ Export</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.listFileChip} onPress={handleImport} disabled={busy}>
          <Text style={styles.listFileText}>⬇ Import</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.filterBar, styles.filterBarWrap]}>
        {SORTS.map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.filterChip, sort === s.key && styles.filterChipActive]}
            onPress={() => setSort(s.key)}
          >
            <Text style={sort === s.key ? styles.filterTextActive : styles.filterText}>{s.label}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.filterChip} onPress={openRandom}>
          <Text style={styles.filterText}>🎲 Random</Text>
        </TouchableOpacity>
        {conflictCount > 0 || conflictsOnly ? (
          <TouchableOpacity
            style={[styles.filterChip, styles.reviewChip, conflictsOnly && styles.filterChipActive]}
            onPress={() => setConflictsOnly((v) => !v)}
          >
            <Text style={conflictsOnly ? styles.filterTextActive : styles.reviewChipText}>
              ⚠ To review ({conflictCount})
            </Text>
          </TouchableOpacity>
        ) : null}
        {entries.length > 0 ? (
          <TouchableOpacity style={styles.clearAllChip} onPress={handleClearAll}>
            <Text style={styles.clearAllText}>Clear All</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.artistFilterRow}>
        <TouchableOpacity
          style={styles.artistFilterButton}
          onPress={openArtistFilter}
        >
          <Text style={styles.artistFilterButtonText}>
            🎭 {artistFilter ? `Artist: ${artistFilter}` : 'Filter by Artist'}
          </Text>
        </TouchableOpacity>
        {artistFilter ? (
          <TouchableOpacity style={styles.artistFilterClearButton} onPress={() => setArtistFilter('')}>
            <Text style={styles.artistFilterClear}>✕</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.statusFilterBar}
        contentContainerStyle={styles.statusFilterBarContent}
      >
        {RATING_FILTERS.map((r) => (
          <TouchableOpacity
            key={r.key ?? 'any'}
            style={[styles.filterChip, minRating === r.key && styles.filterChipActive]}
            onPress={() => setMinRating(r.key)}
          >
            <Text style={minRating === r.key ? styles.filterTextActive : styles.filterText}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.statusFilterBar}
        contentContainerStyle={styles.statusFilterBarContent}
      >
        {READ_STATUS_FILTERS.map((r) => (
          <TouchableOpacity
            key={r.key ?? 'any'}
            style={[styles.filterChip, readStatusFilter === r.key && styles.filterChipActive]}
            onPress={() => setReadStatusFilter(r.key)}
          >
            <Text style={readStatusFilter === r.key ? styles.filterTextActive : styles.filterText}>
              {r.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {allTags.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tagFilterBar}
          contentContainerStyle={styles.tagFilterBarContent}
        >
          {allTags.map((tag) => (
            <TouchableOpacity
              key={tag}
              style={[styles.filterChip, tagFilters.includes(tag) && styles.filterChipActive]}
              onPress={() => toggleTagFilter(tag)}
            >
              <Text style={tagFilters.includes(tag) ? styles.filterTextActive : styles.filterText}>
                #{tag}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}

      <FlatList
        style={styles.list}
        data={displayEntries}
        keyExtractor={(item) => `${item.media_type}:${item.source_id}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.row}
            onPress={() => setSelectedKey(`${item.media_type}:${item.source_id}`)}
          >
            {item.local_image_path ? (
              <Image source={{ uri: item.local_image_path }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]} />
            )}
            <View style={styles.meta}>
              <Text style={styles.name} numberOfLines={2}>
                {item.title || item.source_id}
              </Text>
              {item.author ? <Text style={styles.author}>{item.author}</Text> : null}
              <View style={styles.metaRow}>
                {item.score ? <Text style={styles.scoreBadge}>★ {item.score}</Text> : null}
                {progressText(item) ? <Text style={styles.progressBadge}>{progressText(item)}</Text> : null}
                {item.mal_conflicts ? <Text style={styles.conflictBadge}>⚠ differs from MAL</Text> : null}
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.typeBadge}>{item.media_type}</Text>
                {READ_STATUS_ICONS[item.read_status] ? (
                  <Text style={styles.readStatusBadge}>{READ_STATUS_ICONS[item.read_status]}</Text>
                ) : null}
                <Text style={styles.status}>
                  {item.sync_status === 'synced' ? '☁️ Synced' : '📴 Local only'}
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {entries.length === 0
              ? 'Nothing recorded yet — start browsing in one of the tabs above.'
              : 'No entries match your current filters.'}
          </Text>
        }
      />

      <DetailModal
        entry={selectedEntry}
        onClose={() => setSelectedKey(null)}
        onRate={rate}
        onSetTags={handleSetTags}
        onSetReadStatus={handleSetReadStatus}
        onUpdate={handleUpdate}
        onResolveConflict={handleResolveConflict}
        onOpenNext={handleOpenNext}
        onSetRepeating={handleSetRepeating}
        onPickAgain={randomOpened ? pickRandomNow : null}
        onDelete={handleDeleteEntry}
      />

      <RandomModal
        visible={randomVisible}
        choice={randomChoice}
        onChange={setRandomChoice}
        onPick={pickRandomNow}
        onClose={() => setRandomVisible(false)}
      />

      <Modal
        visible={artistModalVisible}
        animationType="slide"
        onRequestClose={() => setArtistModalVisible(false)}
      >
        <View style={styles.logModal}>
          <View style={styles.logHeader}>
            <Text style={styles.logTitle}>Filter by Artist</Text>
            <TouchableOpacity onPress={() => setArtistModalVisible(false)}>
              <Text style={styles.logClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.logScroll}>
            {artistFilter ? (
              <TouchableOpacity style={styles.artistClearRow} onPress={() => selectArtist('')}>
                <Text style={styles.artistClearRowText}>✕ Clear current filter</Text>
              </TouchableOpacity>
            ) : null}
            {MEDIA_TYPE_LIST.map((mediaConfig) => {
              const artists = artistGroups[mediaConfig.key];
              if (!artists || artists.length === 0) return null;
              return (
                <View key={mediaConfig.key}>
                  <Text style={styles.artistSectionHeader}>{mediaConfig.label}</Text>
                  {artists.map((artist) => (
                    <TouchableOpacity
                      key={artist}
                      style={[styles.artistRow, artistFilter === artist && styles.artistRowActive]}
                      onPress={() => selectArtist(artist)}
                    >
                      <Text
                        style={artistFilter === artist ? styles.artistRowTextActive : styles.artistRowText}
                      >
                        {artist}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              );
            })}
            {Object.keys(artistGroups).length === 0 ? (
              <Text style={styles.logLine}>No artists recorded yet.</Text>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  filterBar: { flexDirection: 'row', padding: 10, gap: 8 },
  filterBarWrap: { flexWrap: 'wrap' },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#eee',
  },
  filterChipActive: { backgroundColor: '#0f3460' },
  clearAllChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#fde2e2',
    marginLeft: 'auto',
  },
  clearAllText: { color: '#c0392b', fontSize: 13, fontWeight: '600' },
  listFileChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#e3ecfa',
  },
  listFileChipFirst: { marginLeft: 'auto' },
  listFileText: { color: '#0f3460', fontSize: 13, fontWeight: '600' },
  statusFilterBar: { flexGrow: 0 },
  statusFilterBarContent: { padding: 10, gap: 8 },
  filterText: { color: '#333', fontSize: 13 },
  filterTextActive: { color: '#fff', fontSize: 13, fontWeight: '600' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    marginBottom: 4,
  },
  artistFilterRow: { flexDirection: 'row', paddingHorizontal: 10, marginBottom: 4, gap: 8 },
  artistFilterButton: {
    flex: 1,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  artistFilterButtonText: { color: '#333', fontSize: 14 },
  artistFilterClearButton: {
    backgroundColor: '#fde2e2',
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  artistFilterClear: { color: '#c0392b', fontSize: 16, fontWeight: '600' },
  artistClearRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fde2e2',
  },
  artistClearRowText: { color: '#c0392b', fontSize: 14, fontWeight: '600' },
  artistSectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  artistRow: { paddingHorizontal: 16, paddingVertical: 12 },
  artistRowActive: { backgroundColor: '#e8edf5' },
  artistRowText: { fontSize: 15, color: '#222' },
  artistRowTextActive: { fontSize: 15, color: '#0f3460', fontWeight: '700' },
  logModal: { flex: 1, backgroundColor: '#fff' },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  logTitle: { fontSize: 17, fontWeight: '700' },
  logClose: { color: '#0f3460', fontSize: 15 },
  logScroll: { flex: 1 },
  logLine: { padding: 16, color: '#888', fontSize: 14 },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    alignItems: 'center',
  },
  thumb: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#eee' },
  thumbPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  meta: { marginLeft: 12, flex: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  author: { fontSize: 13, color: '#666', marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
  scoreBadge: { fontSize: 13, color: '#f5a623', fontWeight: '700' },
  conflictBadge: { fontSize: 12, color: '#b9770e' },
  reviewChip: { backgroundColor: '#fdf2d8' },
  reviewChipText: { color: '#b9770e', fontSize: 13, fontWeight: '600' },
  conflictBox: {
    backgroundColor: '#fdf6e3',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  conflictTitle: { fontSize: 14, fontWeight: '700', color: '#b9770e' },
  conflictHint: { fontSize: 12, color: '#8a6d3b', marginTop: 2, marginBottom: 6 },
  conflictRow: { marginTop: 6 },
  conflictLabel: { fontSize: 12, color: '#888', marginBottom: 4 },
  conflictChoices: { flexDirection: 'row', gap: 6 },
  conflictChoice: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f0d9a8',
    padding: 8,
  },
  conflictWhich: { fontSize: 11, color: '#888' },
  conflictValue: { fontSize: 13, color: '#333', marginTop: 2 },
  detailNextButton: {
    flex: 1,
    backgroundColor: '#e3ecfa',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  detailNextButtonText: { color: '#0f3460', fontSize: 14, fontWeight: '700' },
  randomCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 32,
  },
  randomHint: { fontSize: 12, color: '#888', marginTop: 4 },
  progressBadge: { fontSize: 12, color: '#555' },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  scoreChip: {
    width: 34,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
  },
  scoreChipActive: { backgroundColor: '#f5a623' },
  scoreText: { color: '#333', fontSize: 14 },
  scoreTextActive: { color: '#fff', fontSize: 14, fontWeight: '700' },
  scoreLabel: { fontSize: 13, color: '#555', marginTop: 6 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonText: { fontSize: 18, color: '#0f3460', fontWeight: '700' },
  countInput: {
    minWidth: 56,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    textAlign: 'center',
  },
  countOf: { fontSize: 13, color: '#888' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dateInput: {
    width: 120,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  dateButton: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: '#e3ecfa' },
  dateButtonText: { color: '#0f3460', fontSize: 13, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  commentsInput: {
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  typeBadge: {
    fontSize: 11,
    textTransform: 'uppercase',
    color: '#0f3460',
    backgroundColor: '#e8edf5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  status: { fontSize: 12, color: '#888' },
  empty: { textAlign: 'center', marginTop: 40, color: '#999', paddingHorizontal: 24 },
  detailOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  detailCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '85%',
  },
  detailImage: { width: '100%', height: 220, borderRadius: 10, backgroundColor: '#eee' },
  detailTitle: { fontSize: 20, fontWeight: '700', marginTop: 14 },
  detailAltTitle: { fontSize: 14, color: '#888', marginTop: 2, fontStyle: 'italic' },
  detailAuthor: { fontSize: 15, color: '#666', marginTop: 4 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  detailLabel: { fontSize: 13, color: '#888', marginTop: 12, marginBottom: 4 },
  detailValue: { fontSize: 14, color: '#333' },
  detailUrlButton: {
    marginTop: 14,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 10,
  },
  detailUrlText: { color: '#0f3460', fontSize: 13 },
  detailFooterRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  detailDeleteButton: {
    backgroundColor: '#fde2e2',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  detailDeleteButtonText: { color: '#c0392b', fontWeight: '600' },
  detailCloseButtonFlex: {
    flex: 1,
    backgroundColor: '#16213e',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  detailCloseButtonText: { color: '#fff', fontWeight: '600' },
  readStatusBadge: { fontSize: 13 },
  readStatusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  readStatusChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  readStatusChipActive: { backgroundColor: '#0f3460' },
  readStatusText: { color: '#333', fontSize: 13 },
  readStatusTextActive: { color: '#fff', fontSize: 13, fontWeight: '600' },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tagChip: {
    backgroundColor: '#e8edf5',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tagChipText: { color: '#0f3460', fontSize: 12 },
  tagInputRow: { flexDirection: 'row', gap: 8 },
  tagInput: {
    flex: 1,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  tagAddButton: {
    backgroundColor: '#16213e',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  tagAddButtonText: { color: '#fff', fontWeight: '600' },
  tagFilterBar: { marginBottom: 8 },
  tagFilterBarContent: { paddingHorizontal: 10, gap: 8 },
  fullImageOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: { width: '100%', height: '100%' },
});
