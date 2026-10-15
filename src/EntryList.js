import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { getAllEntries, setScore, setTags, setReadStatus, parseTags, deleteEntry, clearAllEntries } from './db';
import { MEDIA_TYPES, MEDIA_TYPE_LIST } from './mediaTypes';
import { maybeBackupLibraryToDrive } from './backup';

const STARS = [1, 2, 3, 4, 5];
// Fallback for any media type that doesn't define its own readStatusLabels.
const DEFAULT_READ_STATUS_LABELS = { read: 'Read', want: 'Want to Read' };

function getReadStatusLabels(mediaType) {
  return MEDIA_TYPES[mediaType]?.readStatusLabels || DEFAULT_READ_STATUS_LABELS;
}

function StarRating({ score, onRate, size = 16 }) {
  return (
    <View style={styles.stars}>
      {STARS.map((n) => (
        <TouchableOpacity key={n} onPress={() => onRate(score === n ? null : n)} hitSlop={4}>
          <Text style={[styles.star, { fontSize: size }, n <= (score || 0) && styles.starFilled]}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// Labels come from the entry's own media type (e.g. "Read" for manga,
// "Watched" for anime) — the underlying stored value is always 'read'
// or 'want_to_read' regardless of type, only the wording differs.
function ReadStatusToggle({ status, mediaType, onChange }) {
  const labels = getReadStatusLabels(mediaType);
  const options = [
    { key: 'read', label: `📖 ${labels.read}` },
    { key: 'want_to_read', label: `📌 ${labels.want}` },
  ];
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

function DetailModal({ entry, onClose, onRate, onSetTags, onSetReadStatus, onDelete }) {
  const [fullImageVisible, setFullImageVisible] = useState(false);

  if (!entry) return null;
  const tags = parseTags(entry.tags);
  return (
    <Modal visible={!!entry} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.detailOverlay}>
        <View style={styles.detailCard}>
          <ScrollView>
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
              <Text style={styles.detailValue}>{entry.media_type}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Code</Text>
              <Text style={styles.detailValue}>{entry.source_id}</Text>
            </View>
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

            <Text style={styles.detailLabel}>Rating</Text>
            <StarRating score={entry.score} onRate={(score) => onRate(entry, score)} size={24} />

            <Text style={styles.detailLabel}>
              {entry.media_type === 'anime' ? 'Watch status' : 'Read status'}
            </Text>
            <ReadStatusToggle
              status={entry.read_status}
              mediaType={entry.media_type}
              onChange={(status) => onSetReadStatus(entry, status)}
            />

            <Text style={styles.detailLabel}>Tags</Text>
            <TagEditor tags={tags} onChange={(newTags) => onSetTags(entry, newTags)} />

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
  { key: null, label: 'Any rating' },
  { key: 4, label: '★4+' },
  { key: 3, label: '★3+' },
  { key: 2, label: '★2+' },
  { key: 1, label: '★1+' },
];
const READ_STATUS_FILTERS = [
  { key: null, label: 'Any status' },
  { key: 'read', label: '📖 Read/Watched' },
  { key: 'want_to_read', label: '📌 Want to Read/Watch' },
];

export default function EntryList({ active = true, focusKey = null, onFocusHandled }) {
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
      setScore(item.source_id, item.media_type, score);
      load(); // refresh so the tapped star reflects immediately
      backupSilently();
    },
    [load, backupSilently]
  );

  const handleSetTags = useCallback(
    (item, newTags) => {
      setTags(item.source_id, item.media_type, newTags);
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  const handleSetReadStatus = useCallback(
    (item, status) => {
      setReadStatus(item.source_id, item.media_type, status);
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

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
  const selectedEntry = selectedKey
    ? entries.find((e) => `${e.media_type}:${e.source_id}` === selectedKey) || null
    : null;

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
      <View style={styles.filterBar}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key ?? 'all'}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={filter === f.key ? styles.filterTextActive : styles.filterText}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.filterBar}>
        {SORTS.map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.filterChip, sort === s.key && styles.filterChipActive]}
            onPress={() => setSort(s.key)}
          >
            <Text style={sort === s.key ? styles.filterTextActive : styles.filterText}>{s.label}</Text>
          </TouchableOpacity>
        ))}
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

      <View style={styles.filterBar}>
        {RATING_FILTERS.map((r) => (
          <TouchableOpacity
            key={r.key ?? 'any'}
            style={[styles.filterChip, minRating === r.key && styles.filterChipActive]}
            onPress={() => setMinRating(r.key)}
          >
            <Text style={minRating === r.key ? styles.filterTextActive : styles.filterText}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.filterBar}>
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
      </View>

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
              <StarRating score={item.score} onRate={(score) => rate(item, score)} />
              <View style={styles.metaRow}>
                <Text style={styles.typeBadge}>{item.media_type}</Text>
                {item.read_status ? (
                  <Text style={styles.readStatusBadge}>
                    {item.read_status === 'read' ? '📖' : '📌'}
                  </Text>
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
        onDelete={handleDeleteEntry}
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
  stars: { flexDirection: 'row', marginTop: 4 },
  star: { fontSize: 16, color: '#ccc', marginRight: 2 },
  starFilled: { color: '#f5a623' },
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
  readStatusRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
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
