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
  AppState,
  TextInput,
  Switch,
  BackHandler,
  Platform,
  Animated,
  PanResponder,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  getAllEntries,
  getEntry,
  setTags,
  updateEntryFields,
  parseTags,
  deleteEntry,
  getSetting,
  setSetting,
} from './db';
import { showToast } from './toast';
import { MEDIA_TYPES, MEDIA_TYPE_LIST } from './mediaTypes';
import { maybeBackupLibraryToDrive } from './backup';
import { isImportedSourceId, refreshFromAniList } from './malList';
import ToRateModal, { findToRate, skipRating } from './ToRate';
import { SCORE_LABELS, PRIORITIES, CONFLICT_FIELDS, todayString, malTypeOf } from './malFormat';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { groupKey, groupOrder, guessGroup } from './groups';
import {
  buildArtistList,
  loadFavoriteArtists,
  setFavoriteArtist,
  loadPictureFocus,
  focusFor,
  savePictureFocus,
  parseAuthors,
} from './artists';
import FocusImage from './FocusImage';
import RatePrompt from './RatePrompt';
import { TAP_SLOP } from './touch';
import { KeyboardPad } from './keyboard';
import { tourTarget } from './Tour';
import Icon, { IconText } from './Icon';
import ZoomableImage from './ZoomableImage';
import { offerUndo } from './undo';
import UndoBar from './UndoBar';
import { themed, themeColor, useDarkMode } from './theme';
import Marquee from './Marquee';

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
  { key: 'reading', label: 'reading' },
  { key: 'read', label: 'read' },
  { key: 'on_hold', label: 'on_hold' },
  { key: 'dropped', label: 'dropped' },
  { key: 'want_to_read', label: 'want' },
];
// Each status has an icon of the same name (src/Icon.js).

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

// A stored date (YYYY-MM-DD; MAL allows 00 for an unknown month or day)
// as a Date for the calendar to open on — an unknown month/day opens on
// the 1st — or today when there's none.
function dateForPicker(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m || m[1] === '0000') return new Date();
  return new Date(Number(m[1]), Math.max(1, Number(m[2])) - 1, Math.max(1, Number(m[3])));
}

const pad2 = (n) => String(n).padStart(2, '0');

// The date (tap it for a calendar), with Today and clear buttons.
function DateField({ value, onChange }) {
  const pick = () => {
    DateTimePickerAndroid.open({
      value: dateForPicker(value),
      mode: 'date',
      maximumDate: new Date(),
      onChange: (event, date) => {
        if (event.type !== 'set' || !date) return;
        onChange(`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`);
      },
    });
  };
  return (
    <View style={styles.dateRow}>
      <TouchableOpacity style={styles.dateInput} onPress={pick}>
        <Text style={value ? styles.dateValue : styles.datePlaceholder}><Icon name="calendar" size={15} /> {value || 'Pick a date'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.dateButton} onPress={() => onChange(todayString())}>
        <Text style={styles.dateButtonText}>Today</Text>
      </TouchableOpacity>
      {value ? (
        <TouchableOpacity style={styles.dateButton} onPress={() => onChange(null)}>
          <Text style={styles.dateButtonText}>
            <Icon name="close" size={16} />
          </Text>
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

// Super Want to Read/Watch: a Want to entry you want more than the rest,
// set by double-tapping Want to in the details. It's Want to with priority
// 'high' (the Priority chips below show it too), so it syncs with the rest.
const SUPER_TAP_MS = 400;
function isSuperWant(entry) {
  return entry.read_status === 'want_to_read' && entry.priority === 'high';
}

// Labels come from the entry's own media type (e.g. "Read" for manga,
// "Watched" for anime) — the stored values are the same for every type,
// only the wording differs.
//
// Double-tapping Want to makes it Super (onSuper); one tap on Super takes
// it back to plain Want to.
function ReadStatusToggle({ status, superWant, mediaType, onChange, onSuper }) {
  const labels = getReadStatusLabels(mediaType);
  const options = READ_STATUSES.map((s) => ({ key: s.key, icon: s.key, label: labels[s.label] }));
  const lastWantTap = useRef(0);
  const press = (key) => {
    if (key === 'want_to_read' && onSuper) {
      const now = Date.now();
      const second = now - lastWantTap.current < SUPER_TAP_MS;
      lastWantTap.current = second ? 0 : now;
      if (second) return onSuper(true);
      if (superWant) return onSuper(false);
    }
    onChange(status === key ? null : key);
  };
  return (
    <View style={styles.readStatusRow}>
      {options.map((s) => {
        const isSuper = s.key === 'want_to_read' && superWant;
        return (
          <TouchableOpacity
            key={s.key}
            style={[styles.readStatusChip, status === s.key && styles.readStatusChipActive, isSuper && styles.superWantChip]}
            onPress={() => press(s.key)}
            accessibilityHint={s.key === 'want_to_read' && onSuper ? `Double-tap for Super ${s.label}` : undefined}
          >
            <Text style={status === s.key ? styles.readStatusTextActive : styles.readStatusText}>
              <IconText icon={isSuper ? 'super_want' : s.icon} size={15}>{isSuper ? `Super ${s.label}` : s.label}</IconText>
            </Text>
          </TouchableOpacity>
        );
      })}
      {onSuper ? (
        <Text style={styles.superWantHint}>Double-tap {labels.want} for Super {labels.want}.</Text>
      ) : null}
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
              <Text style={styles.tagChipText}>
                {tag} <Icon name="close" size={13} />
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <View style={styles.tagInputRow}>
        <TextInput
          style={styles.tagInput}
          placeholder="Add a tag…"
          placeholderTextColor={themeColor('#666')}
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
      {uri ? <ZoomableImage uri={uri} onClose={onClose} /> : null}
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
      <Text style={styles.conflictTitle}>
          <Icon name="warning" size={15} /> Differs from your MyAnimeList list
        </Text>
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

// Groups for types with `groupField` (Manga, Anime): entries saved one by
// one (volumes, parts, sequels) put together under a name you choose.
// Stored on each entry as group_name and group_order (src/groups.js).
//
// - The detail sheet shows an entry's group as one card (GroupDetails):
//   its name, a strip of the covers (this one ringed) and "N entries ›".
// - The group's own page (GroupModal) is a full screen with a back arrow:
//   the covers in a grid. Edit renames it in the title bar, sorts it from
//   one "Sort by" menu, reorders by dragging ≡, takes an entry out (with
//   Undo) and adds entries (AddEntriesSheet).
// - An entry in no group gets "Add to a group" (GroupPickerSheet): your
//   groups with a cover each, or a new one.
function GroupDetails({ entry, members, sameType, onWriteGroup, onLeave, onOpen }) {
  // The sheet for putting this entry in a group, and the group's own page
  // (null, 'view' or 'edit').
  const [picking, setPicking] = useState(false);
  const [groupView, setGroupView] = useState(null);
  useEffect(() => {
    setPicking(false);
    setGroupView(null);
  }, [entry.source_id, entry.media_type]);
  const name = entry.group_name;
  const groups = useMemo(() => groupsOf(sameType), [sameType]);

  // Not in a group yet: a one-tap suggestion from the title ("Summer Days
  // 4" -> the "Summer Days" group, or a new one with the other parts
  // already saved).
  const suggestion = useMemo(() => {
    if (name) return null;
    const guess = guessGroup(entry.title);
    if (!guess) return null;
    const existing = groups.find((g) => groupKey(g.name) === groupKey(guess.name));
    if (existing) return { label: `Add to “${existing.name}”`, name: existing.name, entries: [...existing.members, entry] };
    const others = sameType.filter(
      (e) =>
        e.source_id !== entry.source_id && !e.group_name && groupKey(guessGroup(e.title)?.name) === groupKey(guess.name)
    );
    if (!others.length) return null;
    const ordered = [entry, ...others].sort(
      (a, b) => (parseFloat(guessGroup(a.title).part) || 0) - (parseFloat(guessGroup(b.title).part) || 0)
    );
    return {
      label: `New group “${guess.name}” with ${others.length} other${others.length === 1 ? '' : 's'}`,
      name: guess.name,
      entries: ordered,
    };
  }, [name, entry, groups, sameType]);

  if (!name) {
    return (
      <>
        <Text style={styles.detailLabel}>Group</Text>
        <View style={styles.groupActions}>
          <TouchableOpacity style={styles.groupActionButton} onPress={() => setPicking(true)} accessibilityRole="button">
            <Text style={styles.groupLink}>
              <Icon name="groups" size={15} /> Add to a group…
            </Text>
          </TouchableOpacity>
        </View>
        {suggestion ? (
          <TouchableOpacity style={styles.groupSuggestion} onPress={() => onWriteGroup(suggestion.entries, suggestion.name)}>
            <Text style={styles.groupSuggestionText}>{suggestion.label}</Text>
          </TouchableOpacity>
        ) : null}
        <GroupPickerSheet
          visible={picking}
          groups={groups}
          onClose={() => setPicking(false)}
          onPick={(groupName) => {
            const trimmed = groupName.trim();
            if (!trimmed) return;
            const existing = groups.find((g) => groupKey(g.name) === groupKey(trimmed));
            onWriteGroup([...(existing ? existing.members : []), entry], existing ? existing.name : trimmed);
            setPicking(false);
          }}
        />
      </>
    );
  }

  // In a group: one card. Its header opens the group's page; each cover
  // opens that entry.
  return (
    <>
      <Text style={styles.detailLabel}>Group</Text>
      <View style={styles.groupCard}>
        <TouchableOpacity
          style={styles.groupCardHeader}
          onPress={() => setGroupView('view')}
          accessibilityRole="button"
          accessibilityLabel={`Open the group ${name}, ${countWord(members.length)}`}
        >
          <Marquee style={styles.groupName} containerStyle={styles.groupNameBox}>
            {name}
          </Marquee>
          <Text style={styles.groupOpen}>
            {countWord(members.length)} <Icon name="chevron-right" size={16} />
          </Text>
        </TouchableOpacity>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupStrip}>
          {members.map((p, i) => {
            const isThis = p.source_id === entry.source_id;
            return (
              <TouchableOpacity
                key={p.source_id}
                style={styles.groupStripItem}
                onPress={() => !isThis && onOpen(p)}
                disabled={isThis}
                accessibilityLabel={`${i + 1}. ${p.title || p.source_id}${isThis ? ' (this one)' : ''}`}
              >
                <GroupCover entry={p} style={[styles.groupStripCover, isThis && styles.groupCoverThis]} />
                <Text style={[styles.groupStripNumber, isThis && styles.groupStripNumberThis]}>{isThis ? 'This' : i + 1}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
      <View style={styles.groupActions}>
        <TouchableOpacity style={styles.groupActionButton} onPress={() => setGroupView('edit')} accessibilityRole="button">
          <Text style={styles.groupLink}>
            <Icon name="edit" size={15} /> Edit group
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.groupActionButton}
          accessibilityRole="button"
          onPress={() => {
            const before = members;
            onLeave(entry);
            offerUndo({
              message: `Taken out of “${name}”`,
              commit: () => {},
              undo: () => onWriteGroup(before, name),
            });
          }}
        >
          <Text style={[styles.groupLink, styles.groupLeave]}>Take out of group</Text>
        </TouchableOpacity>
      </View>
      <GroupModal
        visible={!!groupView}
        editing={groupView === 'edit'}
        onEditing={(on) => setGroupView(on ? 'edit' : 'view')}
        name={name}
        members={members}
        sameType={sameType}
        currentId={entry.source_id}
        onClose={() => setGroupView(null)}
        onOpen={(p) => {
          setGroupView(null);
          if (p.source_id !== entry.source_id) onOpen(p);
        }}
        onWriteGroup={onWriteGroup}
        onLeave={onLeave}
      />
    </>
  );
}

// "3 entries", "1 entry".
function countWord(n) {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

// Every group in a type: { name, members (in order) }, by name.
function groupsOf(sameType) {
  const byName = new Map();
  for (const e of sameType) {
    if (!e.group_name) continue;
    const key = groupKey(e.group_name);
    const g = byName.get(key) || { name: e.group_name, members: [] };
    g.members.push(e);
    byName.set(key, g);
  }
  return [...byName.values()]
    .map((g) => ({ ...g, members: g.members.sort(groupOrder) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function GroupCover({ entry, style }) {
  return entry.local_image_path ? (
    <Image source={{ uri: entry.local_image_path }} style={style} resizeMethod="resize" />
  ) : (
    <View style={[style, styles.thumbPlaceholder]} />
  );
}

// "Add to a group": your groups, each with its first cover and count,
// filtered by the box; or a new group of the name typed.
function GroupPickerSheet({ visible, groups, onClose, onPick }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (visible) setText('');
  }, [visible]);
  if (!visible) return null;
  const query = groupKey(text);
  const matches = groups.filter((g) => !query || groupKey(g.name).includes(query));
  const exact = groups.some((g) => groupKey(g.name) === query);
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardPad style={styles.detailOverlay}>
        <View style={styles.detailCard}>
          <Text style={styles.groupSheetTitle}>Add to a group</Text>
          <TextInput
            style={[styles.tagInput, styles.groupSheetSearch]}
            value={text}
            onChangeText={setText}
            placeholder="Search your groups, or name a new one"
            placeholderTextColor={themeColor('#666')}
            returnKeyType="done"
            onSubmitEditing={() => text.trim() && onPick(matches.length === 1 && query ? matches[0].name : text)}
          />
          <ScrollView keyboardShouldPersistTaps="handled">
            {text.trim() && !exact ? (
              <TouchableOpacity style={styles.groupPickRow} onPress={() => onPick(text)} accessibilityRole="button">
                <View style={[styles.groupPickCover, styles.groupPickNew]}>
                  <Icon name="plus" size={22} color="#1d1f20" />
                </View>
                <Text style={styles.groupPickName} numberOfLines={2}>
                  New group “{text.trim()}”
                </Text>
              </TouchableOpacity>
            ) : null}
            {matches.map((g) => (
              <TouchableOpacity key={g.name} style={styles.groupPickRow} onPress={() => onPick(g.name)} accessibilityRole="button">
                <GroupCover entry={g.members[0]} style={styles.groupPickCover} />
                <View style={styles.groupPageText}>
                  <Text style={styles.groupPickName} numberOfLines={2}>
                    {g.name}
                  </Text>
                  <Text style={styles.groupSubText}>{countWord(g.members.length)}</Text>
                </View>
              </TouchableOpacity>
            ))}
            {!matches.length && !text.trim() ? (
              <Text style={styles.groupHint}>No groups yet. Type a name to make one.</Text>
            ) : null}
          </ScrollView>
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onClose}>
              <Text style={styles.detailCloseButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardPad>
    </Modal>
  );
}

// Ways a group can be put in order ("Sort by" in Edit); dragging ≡ makes
// it Custom.
const GROUP_SORTS = [
  { key: 'part', label: 'Part number' },
  { key: 'title', label: 'Title A–Z' },
  { key: 'added', label: 'Date added' },
];
function sortGroup(members, how) {
  const partNumber = (e) => {
    const guess = guessGroup(e.title);
    const n = parseFloat(guess ? guess.part : String(e.title || '').match(/\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(n) ? n : Infinity;
  };
  const byTitle = (a, b) =>
    String(a.title || a.source_id).localeCompare(String(b.title || b.source_id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  const sorted = [...members];
  if (how === 'part') sorted.sort((a, b) => partNumber(a) - partNumber(b) || byTitle(a, b));
  if (how === 'title') sorted.sort(byTitle);
  if (how === 'added') sorted.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return sorted;
}
// Which sort the group's order is in now ('custom' when none).
function currentGroupSort(members) {
  const ids = members.map((m) => m.source_id).join('\n');
  const found = GROUP_SORTS.find((s) => sortGroup(members, s.key).map((m) => m.source_id).join('\n') === ids);
  return found ? found.key : 'custom';
}

// A group's own page, full screen. View: the covers in a grid, each
// opening its entry. Edit: rename in the title bar, Sort by, drag ≡ to
// reorder, ✕ to take one out (Undo), + Add entries.
function GroupModal({ visible, editing, onEditing, name, members, sameType, currentId, onClose, onOpen, onWriteGroup, onLeave }) {
  const [rename, setRename] = useState(name || '');
  const [adding, setAdding] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [scrollOn, setScrollOn] = useState(true);
  // Taken out, waiting for the Undo bar to go (then really taken out).
  const [leaving, setLeaving] = useState([]);
  useEffect(() => {
    setRename(name || '');
    setAdding(false);
    setSortOpen(false);
  }, [name, editing, visible]);
  if (!visible) return null;

  const shown = members.filter((m) => !leaving.includes(m.source_id));
  const saveName = () => {
    const trimmed = rename.trim();
    if (trimmed && trimmed !== name) onWriteGroup(members, trimmed);
  };
  const takeOut = (p) => {
    setLeaving((l) => [...l, p.source_id]);
    offerUndo({
      message: `Taken out of “${name}”`,
      commit: () => {
        onLeave(p);
        setLeaving((l) => l.filter((id) => id !== p.source_id));
      },
      undo: () => setLeaving((l) => l.filter((id) => id !== p.source_id)),
    });
  };
  const sortKey = currentGroupSort(shown);
  const sortLabel = sortKey === 'custom' ? 'Custom' : GROUP_SORTS.find((s) => s.key === sortKey).label;

  return (
    <Modal visible animationType="slide" onRequestClose={editing ? () => { saveName(); onEditing(false); } : onClose}>
      <KeyboardPad style={styles.groupScreen}>
        <View style={styles.groupBar}>
          <TouchableOpacity style={styles.groupBarButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back">
            <Icon name="arrow-left" size={24} color="#ffffff" />
          </TouchableOpacity>
          {editing ? (
            <TextInput
              style={styles.groupBarInput}
              value={rename}
              onChangeText={setRename}
              onSubmitEditing={saveName}
              onBlur={saveName}
              placeholder="Group name"
              placeholderTextColor="#b8c0d8"
              returnKeyType="done"
              accessibilityLabel="Group name"
            />
          ) : (
            <Marquee style={styles.groupBarTitle} containerStyle={styles.groupNameBox}>
              {name}
            </Marquee>
          )}
          <TouchableOpacity
            style={styles.groupBarButton}
            onPress={() => {
              if (editing) saveName();
              onEditing(!editing);
            }}
            accessibilityRole="button"
          >
            <Text style={styles.groupBarAction}>{editing ? 'Done' : 'Edit'}</Text>
          </TouchableOpacity>
        </View>

        {editing ? (
          <View style={styles.groupEditBar}>
            <TouchableOpacity style={styles.groupEditChip} onPress={() => setSortOpen(true)} accessibilityRole="button">
              <Text style={styles.groupEditChipText}>
                Sort: {sortLabel} <Icon name="menu-down" size={16} />
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.groupEditChip} onPress={() => setAdding(true)} accessibilityRole="button">
              <Text style={styles.groupEditChipText}>
                <Icon name="plus" size={16} /> Add entries
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <ScrollView style={styles.groupScroll} contentContainerStyle={styles.groupScrollContent} scrollEnabled={scrollOn}>
          <Text style={styles.groupSubText}>
            {countWord(shown.length)}
            {editing ? ' · drag ≡ to reorder' : ''}
          </Text>
          {editing ? (
            <DragList
              items={shown}
              currentId={currentId}
              onDragging={(on) => setScrollOn(!on)}
              onReorder={(ordered) => onWriteGroup([...ordered, ...members.filter((m) => leaving.includes(m.source_id))], name)}
              onTakeOut={takeOut}
            />
          ) : (
            <View style={styles.groupGrid}>
              {shown.map((p, i) => (
                <TouchableOpacity
                  key={p.source_id}
                  style={styles.groupGridItem}
                  onPress={() => onOpen(p)}
                  accessibilityLabel={`${i + 1}. ${p.title || p.source_id}`}
                >
                  <GroupCover entry={p} style={[styles.groupGridCover, p.source_id === currentId && styles.groupCoverThis]} />
                  <Text style={styles.groupGridTitle} numberOfLines={2}>
                    <Text style={styles.groupGridNumber}>{i + 1}. </Text>
                    {p.title || p.source_id}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </ScrollView>

        {sortOpen ? (
          <TouchableOpacity style={styles.groupMenuOverlay} activeOpacity={1} onPress={() => setSortOpen(false)}>
            <View style={styles.groupMenu}>
              <Text style={styles.groupMenuTitle}>Sort by</Text>
              {GROUP_SORTS.map((s) => (
                <TouchableOpacity
                  key={s.key}
                  style={styles.groupMenuRow}
                  onPress={() => {
                    onWriteGroup(sortGroup(members, s.key), name);
                    setSortOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: sortKey === s.key }}
                >
                  <Text style={styles.groupMenuText}>{s.label}</Text>
                  {sortKey === s.key ? <Icon name="check" size={20} color="#1d1f20" /> : null}
                </TouchableOpacity>
              ))}
              {sortKey === 'custom' ? <Text style={styles.groupHint}>Now: your own order.</Text> : null}
            </View>
          </TouchableOpacity>
        ) : null}

        <AddEntriesSheet
          visible={adding}
          name={name}
          sameType={sameType}
          onClose={() => setAdding(false)}
          onAdd={(added) => {
            onWriteGroup([...members, ...added], name);
            setAdding(false);
          }}
        />
        <UndoBar />
      </KeyboardPad>
    </Modal>
  );
}

// Edit's list: each entry with its cover, ≡ to drag it to a new place
// (or, with a screen reader, the Move up / Move down actions) and ✕ to
// take it out. Built on PanResponder: the dragged row follows the finger,
// the rows it passes slide out of its way, and letting go saves the new
// order.
function DragList({ items, currentId, onDragging, onReorder, onTakeOut }) {
  const heights = useRef({});
  const [drag, setDrag] = useState(null); // { index, to }
  const dy = useRef(new Animated.Value(0)).current;
  const dragRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The latest callbacks, for the handlers made once below.
  const callbacks = useRef({});
  callbacks.current = { onReorder, onDragging };

  // Where the dragged row would land, `moved` px from where it started.
  const targetIndex = (from, moved) => {
    const list = itemsRef.current;
    let to = from;
    let left = moved;
    if (moved > 0) {
      while (to < list.length - 1) {
        const h = heights.current[list[to + 1].source_id] || 72;
        if (left < h / 2) break;
        left -= h;
        to += 1;
      }
    } else {
      while (to > 0) {
        const h = heights.current[list[to - 1].source_id] || 72;
        if (-left < h / 2) break;
        left += h;
        to -= 1;
      }
    }
    return to;
  };
  const finish = (moved) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    dy.setValue(0);
    callbacks.current.onDragging(false);
    if (!d) return;
    const to = targetIndex(d.index, moved);
    if (to === d.index) return;
    const next = [...itemsRef.current];
    const [it] = next.splice(d.index, 1);
    next.splice(to, 0, it);
    callbacks.current.onReorder(next);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const move = (from, to) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onReorder(next);
  };
  const responders = useRef({}).current;
  const responderFor = (index) => {
    const key = `${index}`;
    if (!responders[key]) {
      responders[key] = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragRef.current = { index };
          setDrag({ index, to: index });
          callbacks.current.onDragging(true);
        },
        onPanResponderMove: (e, g) => {
          dy.setValue(g.dy);
          const to = targetIndex(index, g.dy);
          setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
        },
        onPanResponderRelease: (e, g) => finishRef.current(g.dy),
        onPanResponderTerminate: (e, g) => finishRef.current(g.dy),
      });
    }
    return responders[key];
  };
  const draggedHeight = drag ? heights.current[items[drag.index]?.source_id] || 72 : 0;

  return (
    <View>
      {items.map((p, i) => {
        let shift = 0;
        if (drag && i !== drag.index) {
          if (drag.index < drag.to && i > drag.index && i <= drag.to) shift = -draggedHeight;
          if (drag.index > drag.to && i < drag.index && i >= drag.to) shift = draggedHeight;
        }
        const isDragged = drag && i === drag.index;
        return (
          <Animated.View
            key={p.source_id}
            onLayout={(e) => {
              heights.current[p.source_id] = e.nativeEvent.layout.height;
            }}
            style={[
              styles.groupPageRow,
              p.source_id === currentId && styles.groupRowThisBg,
              isDragged && styles.groupRowDragged,
              { transform: [{ translateY: isDragged ? dy : shift }] },
            ]}
          >
            <View
              {...responderFor(i).panHandlers}
              style={styles.groupTool}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={`Move ${p.title || p.source_id}`}
              accessibilityActions={[
                { name: 'increment', label: 'Move down' },
                { name: 'decrement', label: 'Move up' },
              ]}
              onAccessibilityAction={(e) => move(i, e.nativeEvent.actionName === 'increment' ? i + 1 : i - 1)}
            >
              <Icon name="drag-horizontal-variant" size={24} color={themeColor('#666')} />
            </View>
            <Text style={styles.groupNumber}>{i + 1}</Text>
            <GroupCover entry={p} style={styles.groupPageThumb} />
            <View style={styles.groupPageText}>
              <Text style={styles.groupPageItemTitle} numberOfLines={2}>
                {p.title || p.source_id}
              </Text>
            </View>
            <TouchableOpacity onPress={() => onTakeOut(p)} style={styles.groupTool} accessibilityRole="button" accessibilityLabel="Take out of the group">
              <Icon name="close" size={20} color="#c0392b" />
            </TouchableOpacity>
          </Animated.View>
        );
      })}
    </View>
  );
}

// "+ Add entries": likely matches (the group's name in the title) first,
// or a search; tick as many as you like, then Add.
function AddEntriesSheet({ visible, name, sameType, onClose, onAdd }) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    if (visible) {
      setSearch('');
      setPicked([]);
    }
  }, [visible]);
  if (!visible) return null;
  const query = groupKey(search);
  const outside = sameType.filter((e) => groupKey(e.group_name) !== groupKey(name));
  const likely = outside.filter((e) => groupKey(guessGroup(e.title)?.name) === groupKey(name));
  const list = query ? outside.filter((e) => groupKey(e.title).includes(query)).slice(0, 40) : likely;
  const toggle = (e) =>
    setPicked((p) => (p.some((x) => x.source_id === e.source_id) ? p.filter((x) => x.source_id !== e.source_id) : [...p, e]));
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardPad style={styles.detailOverlay}>
        <View style={styles.detailCard}>
          <Text style={styles.groupSheetTitle}>Add to “{name}”</Text>
          <TextInput
            style={[styles.tagInput, styles.groupSheetSearch]}
            value={search}
            onChangeText={setSearch}
            placeholder="Search titles…"
            placeholderTextColor={themeColor('#666')}
          />
          {!query && likely.length ? <Text style={styles.groupHint}>Looks like part of this group:</Text> : null}
          <ScrollView keyboardShouldPersistTaps="handled">
            {list.map((e) => {
              const on = picked.some((x) => x.source_id === e.source_id);
              return (
                <TouchableOpacity
                  key={e.source_id}
                  style={styles.groupPickRow}
                  onPress={() => toggle(e)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                >
                  <Icon name={on ? 'checked' : 'unchecked'} size={24} color="#1d1f20" />
                  <GroupCover entry={e} style={styles.groupPickCover} />
                  <View style={styles.groupPageText}>
                    <Text style={styles.groupPickName} numberOfLines={2}>
                      {e.title || e.source_id}
                    </Text>
                    {e.group_name ? (
                      <Text style={styles.groupSubText} numberOfLines={1}>
                        Now in “{e.group_name}” — moves here
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            {!list.length ? (
              <Text style={styles.groupHint}>{query ? 'Nothing matches.' : 'Type part of a title to find entries to add.'}</Text>
            ) : null}
          </ScrollView>
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onClose}>
              <Text style={styles.detailCloseButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.groupAddButton, !picked.length && styles.groupButtonOff]}
              onPress={() => onAdd(picked)}
              disabled={!picked.length}
              accessibilityRole="button"
            >
              <Text style={styles.groupButtonText}>{picked.length ? `Add ${picked.length}` : 'Add'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardPad>
    </Modal>
  );
}

// An entry's genres (comma-separated, from AniList by MAL id).
function parseGenres(genres) {
  return (genres || '').split(',').map((g) => g.trim()).filter(Boolean);
}

// The detail sheet's main button: "Start reading" before the first
// chapter, "Continue reading · ch N" after, "Reread" once completed, with 🔍 when the title's page
// on the site isn't known yet (imported from MyAnimeList), since it
// searches for it instead.
function nextButtonLabel(entry, words) {
  const icon = isImportedSourceId(entry.source_id) ? 'search' : 'play';
  // Completed: starts a reread from the first chapter.
  if (entry.read_status === 'read' && !entry.repeating) return { icon, label: words.again };
  const verb = entry.media_type === 'anime' ? 'watching' : 'reading';
  const label = entry.repeating
    ? `${words.again} ${words.short} ${(entry.repeat_progress || 0) + 1}`
    : entry.progress
      ? `Continue ${verb} · ${words.short} ${entry.progress + 1}`
      : `Start ${verb}`;
  return { icon, label };
}

// An entry's page on MyAnimeList (anime or manga list, by its MAL id).
function malUrlOf(entry) {
  return `https://myanimelist.net/${malTypeOf(entry.media_type)}/${entry.mal_id}`;
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
  onOpenUrl,
  onSetRepeating,
  onPickAgain,
  onToggleFavorite,
  onDelete,
  groupMembers = [],
  sameTypeEntries = [],
  onWriteGroup,
  onLeaveGroup,
  onOpenEntry,
}) {
  const [fullImageVisible, setFullImageVisible] = useState(false);

  if (!entry) return null;
  const tags = parseTags(entry.tags);
  const words = progressWords(entry.media_type);
  const update = (fields) => onUpdate(entry, fields);
  return (
    <Modal visible={!!entry} animationType="slide" onRequestClose={onClose} transparent>
      <KeyboardPad style={styles.detailOverlay}>
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

            <TouchableOpacity
              style={[styles.heartButton, entry.favorite ? styles.heartButtonActive : null]}
              onPress={() => onToggleFavorite(entry)}
            >
              <Text style={[styles.heartButtonText, entry.favorite ? styles.heartButtonTextActive : null]}>
                {entry.favorite ? (
                  <><Icon name="heart" size={16} /> Favourite</>
                ) : (
                  <><Icon name="heartOutline" size={16} /> Add to Favourites</>
                )}
              </Text>
            </TouchableOpacity>

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
            {entry.source_url && !isImportedSourceId(entry.source_id) ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Site</Text>
                <TouchableOpacity style={styles.detailLinkWrap} onPress={() => onOpenUrl(entry)}>
                  <Text style={styles.detailLink} numberOfLines={1}>
                    {entry.source_url.replace(/^https?:\/\/(www\.)?/i, '')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {entry.mal_id ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>MyAnimeList</Text>
                <TouchableOpacity
                  style={styles.detailLinkWrap}
                  onPress={() => Linking.openURL(malUrlOf(entry))}
                >
                  <Text style={styles.detailLink} numberOfLines={1}>
                    {malUrlOf(entry).replace(/^https:\/\//, '')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {parseGenres(entry.genres).length > 0 ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Genres</Text>
                <Text style={[styles.detailValue, styles.detailGenres]}>
                  {parseGenres(entry.genres).join(', ')}
                </Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Added</Text>
              <Text style={styles.detailValue}>{entry.created_at}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Sync</Text>
              <Text style={styles.detailValue}>
                {entry.sync_status === 'synced' ? (
                  <><Icon name="cloud" size={15} /> Synced to Drive</>
                ) : (
                  <><Icon name="localOnly" size={15} /> Local only</>
                )}
              </Text>
            </View>

            <Text style={styles.detailLabel}>
              {entry.media_type === 'anime' ? 'Watch status' : 'Read status'}
            </Text>
            <ReadStatusToggle
              status={entry.read_status}
              superWant={isSuperWant(entry)}
              mediaType={entry.media_type}
              onChange={(status) => onSetReadStatus(entry, status)}
              onSuper={(on) => update(on ? { read_status: 'want_to_read', priority: 'high' } : { priority: 'low' })}
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

            {MEDIA_TYPES[entry.media_type]?.groupField ? (
              <GroupDetails
                entry={entry}
                members={groupMembers}
                sameType={sameTypeEntries}
                onWriteGroup={onWriteGroup}
                onLeave={onLeaveGroup}
                onOpen={onOpenEntry}
              />
            ) : null}

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
          </ScrollView>

          {onPickAgain ? (
            <TouchableOpacity style={styles.pickAgainButton} onPress={onPickAgain}>
              <Text style={styles.pickAgainButtonText}>
                <Icon name="random" size={16} /> Pick again
              </Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailNextButton} onPress={() => onOpenNext(entry)}>
              <Text style={styles.detailNextButtonText}><IconText icon={nextButtonLabel(entry, words).icon} size={17}>{nextButtonLabel(entry, words).label}</IconText></Text>
            </TouchableOpacity>
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
      </KeyboardPad>

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
  { key: 'updated', label: 'Last updated' },
  { key: 'newest', label: 'Newest' },
  { key: 'rating', label: 'Top Rated' },
];
// key: a minimum score, or 'favorite' for ♥ favourites only.
// The chips are drawn small, so the filters don't push the list down; this
// makes each one 48 dp to tap.
const CHIP_SLOP = { top: 9, bottom: 9 };
const RATING_FILTERS = [
  { key: null, label: 'Any score' },
  { key: 'favorite', icon: 'heart', label: 'Favourites' },
  // Entries with no cover on the phone: opening the page fills one in.
  { key: 'noCover', icon: 'noCover', label: 'No cover' },
  { key: 9, icon: 'star', label: '9+' },
  { key: 8, icon: 'star', label: '8+' },
  { key: 7, icon: 'star', label: '7+' },
  { key: 6, icon: 'star', label: '6+' },
  { key: 5, icon: 'star', label: '5+' },
];
const READ_STATUS_FILTERS = [
  { key: null, label: 'Any status' },
  { key: 'reading', icon: 'reading', label: 'Reading/Watching' },
  { key: 'read', icon: 'read', label: 'Read/Watched' },
  { key: 'on_hold', icon: 'on_hold', label: 'On Hold' },
  { key: 'dropped', icon: 'dropped', label: 'Dropped' },
  { key: 'want_to_read', icon: 'want_to_read', label: 'Want to Read/Watch' },
  { key: 'super_want', icon: 'super_want', label: 'Super Want' },
];

// One entry in the Library's list. Memoised: a long list redraws only the
// rows whose details, or whether they're picked, changed. dark isn't read
// here but redraws the row when Dark mode is switched.
const EntryRow = React.memo(function EntryRow({ item, picking, isPicked, showType, onPress, onLongPress, dark }) { // eslint-disable-line no-unused-vars
  const superWant = isSuperWant(item);
  return (
    <TouchableOpacity
      style={[
        styles.row,
        item.favorite || superWant ? styles.rowOutlined : null,
        item.favorite ? styles.rowFavorite : null,
        superWant ? (item.favorite ? styles.rowBoth : styles.rowSuperWant) : null,
        isPicked && styles.rowPicked,
      ]}
      onPress={() => onPress(item)}
      // Hold a title to select it, then tap others to add them.
      onLongPress={() => onLongPress(item)}
      accessibilityRole="button"
      accessibilityState={picking ? { selected: isPicked } : undefined}
    >
      {picking ? (
        <Text style={styles.pickMark}>
          <Icon name={isPicked ? 'checked' : 'unchecked'} size={24} />
        </Text>
      ) : null}
      {item.local_image_path ? (
        <Image source={{ uri: item.local_image_path }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]} />
      )}
      <View style={styles.meta}>
        {item.favorite || superWant ? (
          <View style={styles.rowLabels}>
            {item.favorite ? (
              <Text style={styles.rowLabelFavorite}>
                <Icon name="heart" size={12} /> FAVOURITE
              </Text>
            ) : null}
            {superWant ? (
              <Text style={styles.rowLabelSuper}>
                <Icon name="super_want" size={12} /> SUPER WANT
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text style={styles.name} numberOfLines={2}>
          {item.title || item.source_id}
        </Text>
        {item.author ? <Text style={styles.author}>{item.author}</Text> : null}
        <View style={styles.metaRow}>
          {item.score ? (
            <Text style={styles.scoreBadge}>
              <Icon name="star" size={13} /> {item.score}
            </Text>
          ) : null}
          {progressText(item) ? <Text style={styles.progressBadge}>{progressText(item)}</Text> : null}
          {item.mal_conflicts ? (
            <Text style={styles.conflictBadge}>
              <Icon name="warning" size={13} /> differs from MAL
            </Text>
          ) : null}
          {item.group_name ? (
            <Text style={styles.progressBadge} numberOfLines={1}>
              {item.group_name}
            </Text>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          {/* Its kind, when the list shows them all. */}
          {showType ? <Text style={styles.typeBadge}>{MEDIA_TYPES[item.media_type]?.label || item.media_type}</Text> : null}
          {/* Super Want has its label above. */}
          {item.read_status && !superWant ? (
            <Text style={styles.readStatusBadge}>
              <Icon name={item.read_status} size={15} />
            </Text>
          ) : null}
          {/* Only what's not in Drive yet: most rows are, so it was noise. */}
          {item.sync_status === 'synced' ? null : (
            <Text style={styles.status}>
              <Icon name="localOnly" size={12} /> Local only
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

// The 🎲 Random button's choices. Each row allows several choices at once
// (e.g. Manga + Anime); a row with nothing chosen means "any".
const RANDOM_STATUS_CHOICES = [
  { key: 'read', icon: 'read', label: 'Read/Watched' },
  { key: 'want_to_read', icon: 'want_to_read', label: 'Want to Read/Watch' },
  { key: 'reading', icon: 'reading', label: 'Reading/Watching' },
];
// 'favorite': ♥ favourite entries; 'low': scored 1–5; 0: no score.
const RANDOM_RATING_CHOICES = [
  { key: 'favorite', icon: 'heart', label: 'Favourite' },
  { key: 10, icon: 'star', label: '10' },
  { key: 9, icon: 'star', label: '9' },
  { key: 8, icon: 'star', label: '8' },
  { key: 7, icon: 'star', label: '7' },
  { key: 6, icon: 'star', label: '6' },
  { key: 'low', icon: 'star', label: '1–5' },
  { key: 0, label: 'No score' },
];
// What Random picks: a title, or an artist credited on the matching titles.
const RANDOM_KIND_CHOICES = [
  { key: 'entry', icon: 'books', label: 'Title' },
  { key: 'artist', icon: 'people', label: 'Artist' },
];
const EMPTY_RANDOM_CHOICE = { types: [], statuses: [], ratings: [], kind: 'entry' };

// Random's choices are kept (setting `randomChoice`) and come back the
// next time it's opened. Anything no longer offered is dropped on reading.
function loadRandomChoice() {
  try {
    const saved = JSON.parse(getSetting('randomChoice', '') || 'null');
    if (!saved) return EMPTY_RANDOM_CHOICE;
    const keep = (list, choices) =>
      Array.isArray(list) ? list.filter((k) => choices.some((c) => c.key === k)) : [];
    return {
      types: keep(saved.types, MEDIA_TYPE_LIST),
      statuses: keep(saved.statuses, RANDOM_STATUS_CHOICES),
      ratings: keep(saved.ratings, RANDOM_RATING_CHOICES),
      kind: RANDOM_KIND_CHOICES.some((k) => k.key === saved.kind) ? saved.kind : 'entry',
    };
  } catch (e) {
    return EMPTY_RANDOM_CHOICE;
  }
}
const EMPTY_SET = new Set();

// How many titles, e.g. "1 title" / "3 titles".
function titleCount(n) {
  return `${n} title${n === 1 ? '' : 's'}`;
}

// Details for one artist in the Artists view: their picture (tap to see
// it whole; ✥ Move picture to choose which part shows in the list), how
// many saved titles they're on, a Favourite toggle (favourites go to the
// top of the list) and a button to list their titles.
function ArtistDetailModal({ artist, isFavorite, onToggleFavorite, onShowTitles, onClose, onPickAgain, focus, onSaveFocus }) {
  const [fullImageVisible, setFullImageVisible] = useState(false);
  // Moving the picture: the position being tried (null when not moving).
  const [draftFocus, setDraftFocus] = useState(null);
  const moving = draftFocus !== null;
  useEffect(() => setDraftFocus(null), [artist?.name]);
  if (!artist) return null;
  return (
    <Modal visible={!!artist} animationType="slide" onRequestClose={onClose} transparent>
      <KeyboardPad style={styles.detailOverlay}>
        <View style={styles.detailCard}>
          <ScrollView scrollEnabled={!moving}>
            {artist.cover && moving ? (
              <>
                {/* Same shape as the list's picture, so you see what the list will show. */}
                <FocusImage uri={artist.cover} style={styles.focusEditor} focus={draftFocus} onPanFocus={setDraftFocus} />
                <View style={styles.zoomRow}>
                  <Text style={styles.linkHint}>Drag to move · zoom:</Text>
                  {[1, 1.5, 2, 3].map((z) => (
                    <TouchableOpacity
                      key={z}
                      style={[styles.zoomChip, (draftFocus.zoom || 1) === z && styles.zoomChipActive]}
                      onPress={() => setDraftFocus((d) => ({ ...d, zoom: z }))}
                    >
                      <Text style={(draftFocus.zoom || 1) === z ? styles.zoomTextActive : styles.zoomText}>{z}×</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.linkHint}>This is how it shows in the list.</Text>
                <View style={styles.focusButtons}>
                  <TouchableOpacity style={styles.focusButton} onPress={() => setDraftFocus(null)}>
                    <Text style={styles.focusButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.focusButton}
                    onPress={() => {
                      onSaveFocus(artist, null);
                      setDraftFocus(null);
                    }}
                  >
                    <Text style={styles.focusButtonText}>Centre</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.focusButton, styles.focusSave]}
                    onPress={() => {
                      onSaveFocus(artist, draftFocus);
                      setDraftFocus(null);
                    }}
                  >
                    <Text style={styles.focusSaveText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : artist.cover ? (
              <TouchableOpacity onPress={() => setFullImageVisible(true)} activeOpacity={0.9}>
                <FocusImage uri={artist.cover} style={styles.detailImage} focus={focus} />
              </TouchableOpacity>
            ) : (
              <View style={[styles.detailImage, styles.thumbPlaceholder]} />
            )}
            {artist.cover && !moving ? (
              <TouchableOpacity onPress={() => setDraftFocus(focus || { x: 0.5, y: 0.5, zoom: 1 })} hitSlop={TAP_SLOP}>
                <Text style={styles.moveText}>
                  <Icon name="move" size={15} /> Move picture
                </Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.detailTitle}>{artist.name}</Text>
            <Text style={styles.artistDetailCount}>{titleCount(artist.count)} saved</Text>

            <TouchableOpacity
              style={[styles.favoriteButton, isFavorite && styles.favoriteButtonActive]}
              onPress={() => onToggleFavorite(artist.name)}
            >
              <Text style={[styles.favoriteButtonText, isFavorite && styles.favoriteButtonTextActive]}>
                {isFavorite ? (
                    <><Icon name="star" size={16} /> Favourite</>
                  ) : (
                    <><Icon name="starOutline" size={16} /> Add to Favourites</>
                  )}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.detailUrlButton} onPress={() => onShowTitles(artist.name)}>
              <Text style={styles.detailUrlText}>
                  <Icon name="books" size={15} /> Show their titles
                </Text>
            </TouchableOpacity>
          </ScrollView>

          {onPickAgain ? (
            <TouchableOpacity style={styles.pickAgainButton} onPress={onPickAgain}>
              <Text style={styles.pickAgainButtonText}>
                <Icon name="random" size={16} /> Pick again
              </Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onClose}>
              <Text style={styles.detailCloseButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardPad>

      <FullImageModal uri={artist.cover} visible={fullImageVisible} onClose={() => setFullImageVisible(false)} />
    </Modal>
  );
}

// Whether an entry matches the Random window's rating row (any of the
// chosen ones; none chosen = any).
function matchesRandomRating(entry, ratings) {
  if (ratings.length === 0) return true;
  const score = entry.score || 0;
  return ratings.some((r) =>
    r === 'favorite' ? !!entry.favorite : r === 'low' ? score >= 1 && score <= 5 : score === r
  );
}

function toggled(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function RandomModal({ visible, choice, onChange, onPick, onClose }) {
  const chip = (active, label, onPress, icon = null) => (
    <TouchableOpacity
      key={`${icon}${label}`}
      style={[styles.filterChip, active && styles.filterChipActive]}
      hitSlop={CHIP_SLOP}
      onPress={onPress}
    >
      <Text style={active ? styles.filterTextActive : styles.filterText}>
        <IconText icon={icon} size={15}>{label}</IconText>
      </Text>
    </TouchableOpacity>
  );
  // "Any" chip for a row: on when nothing in the row is chosen; tapping it
  // clears the row.
  const anyChip = (list, clear) => chip(list.length === 0, 'Any', clear);
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardPad style={styles.detailOverlay}>
        <View style={styles.randomCard}>
          <ScrollView>
            <Text style={styles.detailTitle}>
              <Icon name="random" size={20} /> Random
            </Text>
            <Text style={styles.randomHint}>Choose any number in each row — none means any.</Text>

            <Text style={styles.detailLabel}>Category</Text>
            <View style={styles.readStatusRow}>
              {anyChip(choice.types, () => onChange({ ...choice, types: [] }))}
              {MEDIA_TYPE_LIST.map((m) =>
                chip(choice.types.includes(m.key), m.label, () =>
                  onChange({ ...choice, types: toggled(choice.types, m.key) })
                )
              )}
            </View>

            <Text style={styles.detailLabel}>Status</Text>
            <View style={styles.readStatusRow}>
              {anyChip(choice.statuses, () => onChange({ ...choice, statuses: [] }))}
              {RANDOM_STATUS_CHOICES.map((r) =>
                chip(
                  choice.statuses.includes(r.key),
                  r.label,
                  () => onChange({ ...choice, statuses: toggled(choice.statuses, r.key) }),
                  r.icon
                )
              )}
            </View>

            <Text style={styles.detailLabel}>Rating</Text>
            <View style={styles.readStatusRow}>
              {anyChip(choice.ratings, () => onChange({ ...choice, ratings: [] }))}
              {RANDOM_RATING_CHOICES.map((r) =>
                chip(
                  choice.ratings.includes(r.key),
                  r.label,
                  () => onChange({ ...choice, ratings: toggled(choice.ratings, r.key) }),
                  r.icon
                )
              )}
            </View>

            <Text style={styles.detailLabel}>Pick a</Text>
            <View style={styles.readStatusRow}>
              {RANDOM_KIND_CHOICES.map((k) =>
                chip(choice.kind === k.key, k.label, () => onChange({ ...choice, kind: k.key }), k.icon)
              )}
            </View>
            <Text style={styles.randomHint}>
              Artist picks someone credited on your titles that match the choices above (Favourite:
              your favourite artists).
            </Text>
          </ScrollView>
          <View style={styles.detailFooterRow}>
            <TouchableOpacity style={styles.detailCloseButtonFlex} onPress={onClose}>
              <Text style={styles.detailCloseButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.detailCloseButtonFlex, styles.randomPickButton]} onPress={onPick}>
              <Text style={styles.detailCloseButtonText}>
                <Icon name="random" size={16} /> Pick
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardPad>
    </Modal>
  );
}

export default function EntryList({ active = true, reloadKey = 0, focusKey = null, onFocusHandled, onOpenInTab }) {
  const dark = useDarkMode(); // redraws in the other colours when Dark mode is switched
  const [entries, setEntries] = useState([]);
  // Entries deleted but still offered for Undo (undo.js): hidden until then.
  const hiddenKeys = useRef(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState(null); // null = all types
  const [sort, setSort] = useState('updated');
  const [artistFilter, setArtistFilter] = useState('');
  const [artistModalVisible, setArtistModalVisible] = useState(false);
  const [minRating, setMinRating] = useState(null);
  const [readStatusFilter, setReadStatusFilter] = useState(null);
  // The Library's search box: part of a title or alternative title.
  const [titleQuery, setTitleQuery] = useState('');
  const [tagFilters, setTagFilters] = useState([]); // array of selected tag strings (AND logic)
  const [genreFilters, setGenreFilters] = useState([]); // selected genres (AND logic, like tags)
  const [selectedKey, setSelectedKey] = useState(null); // `${media_type}:${source_id}` or null
  const [conflictsOnly, setConflictsOnly] = useState(false); // "To review" chip
  // Select mode (hold a title): the keys picked, or null when not
  // selecting; statusSheet: the Status… choice is open.
  const [picked, setPicked] = useState(null);
  const [statusSheet, setStatusSheet] = useState(false);

  // ⭐ To rate (ToRate.js): titles waiting for a score, across every type.
  const [toRate, setToRate] = useState({ finished: [], unrated: [], count: 0 });
  const [toRateVisible, setToRateVisible] = useState(false);
  useEffect(() => {
    if (toRateVisible && !toRate.count) setToRateVisible(false); // all rated or skipped
  }, [toRateVisible, toRate.count]);

  const load = useCallback(() => {
    setEntries(getAllEntries(filter).filter((e) => !hiddenKeys.current.has(`${e.media_type}:${e.source_id}`)));
    setToRate(findToRate(getAllEntries()));
  }, [filter]);

  useEffect(load, [load]);
  // For Undo's commit, which runs after `load` may have changed.
  const loadRef = useRef(load);
  loadRef.current = load;

  // Series you're reading that are still coming out have no total. Opening
  // the Library asks AniList about them again (each at most once a day —
  // needsAniList in malList.js), so one that has ended gets its total, and
  // if you're already at its last chapter it shows under ⭐ To rate.
  useEffect(() => {
    if (!active) return;
    const ongoing = getAllEntries().filter(
      (e) => e.mal_id && !e.total && ['reading', 'on_hold'].includes(e.read_status)
    );
    if (!ongoing.length) return;
    refreshFromAniList(ongoing)
      .then(() => {
        if (ongoing.some((e) => e.total)) {
          load();
          backupSilently();
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  // Bumped by App.js after changes made from Settings (MAL import, Drive
  // restore), which can happen while the Library is already showing.
  useEffect(() => {
    if (reloadKey) load();
  }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setTitleQuery('');
    setReadStatusFilter(null);
    setTagFilters([]);
    setGenreFilters([]);
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
    const query = titleQuery.trim().toLowerCase();
    if (query && ![e.title, e.alt_title, e.source_id].some((v) => String(v || '').toLowerCase().includes(query))) {
      return false;
    }
    if (artistFilter.trim()) {
      const needle = artistFilter.trim().toLowerCase();
      if (!e.author || !e.author.toLowerCase().includes(needle)) return false;
    }
    if (minRating === 'favorite') {
      if (!e.favorite) return false;
    } else if (minRating === 'noCover') {
      if (e.local_image_path) return false;
    } else if (minRating !== null && (e.score || 0) < minRating) return false;
    if (readStatusFilter === 'super_want') {
      if (!isSuperWant(e)) return false;
    } else if (readStatusFilter !== null && e.read_status !== readStatusFilter) return false;
    if (conflictsOnly && !e.mal_conflicts) return false;
    if (tagFilters.length > 0) {
      const entryTags = parseTags(e.tags).map((t) => t.toLowerCase());
      const hasAllSelected = tagFilters.every((t) => entryTags.includes(t.toLowerCase()));
      if (!hasAllSelected) return false;
    }
    if (genreFilters.length > 0) {
      const entryGenres = parseGenres(e.genres);
      if (!genreFilters.every((g) => entryGenres.includes(g))) return false;
    }
    return true;
  });

  // Last updated: the entry's updated_at (any change to it, here, in the
  // extension or from Drive), newest first; entries without one fall
  // back to when they were added.
  // (created_at is SQLite's "YYYY-MM-DD HH:MM:SS", in UTC.)
  const updatedTime = (e) => {
    const t = String(e.updated_at || e.created_at || '').replace(' ', 'T');
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`) || 0;
  };
  const displayEntries =
    sort === 'rating'
      ? [...filteredEntries].sort((a, b) => (b.score || 0) - (a.score || 0))
      : sort === 'updated'
        ? [...filteredEntries].sort((a, b) => updatedTime(b) - updatedTime(a))
        : filteredEntries;

  // Every distinct tag currently in use, for the filter chip row —
  // computed from the (type-filtered) entries list, so it naturally
  // narrows when switching between the Manga/Anime/All chips above.
  // Favourite tags (lowercased) come first, marked ★; hold a tag chip to
  // make it one or not (saved on this phone).
  const [favoriteTags, setFavoriteTags] = useState(() => {
    try {
      return new Set(JSON.parse(getSetting('favoriteTags', '[]')) || []);
    } catch (e) {
      return new Set();
    }
  });
  const toggleFavoriteTag = useCallback(
    (tag) => {
      const next = new Set(favoriteTags);
      const key = tag.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSetting('favoriteTags', JSON.stringify([...next]));
      setFavoriteTags(next);
      if (Platform.OS === 'android') {
        showToast(next.has(key) ? `#${tag} is a favourite tag` : `#${tag} is no longer a favourite`);
      }
    },
    [favoriteTags]
  );
  const allTags = useMemo(() => {
    const set = new Set();
    entries.forEach((e) => parseTags(e.tags).forEach((t) => set.add(t)));
    const fav = (tag) => (favoriteTags.has(tag.toLowerCase()) ? 1 : 0);
    return Array.from(set).sort((a, b) => fav(b) - fav(a) || a.localeCompare(b));
  }, [entries, favoriteTags]);

  // Every genre in use, for the genre chip row (narrows with the type chips too).
  const allGenres = useMemo(() => {
    const set = new Set();
    entries.forEach((e) => parseGenres(e.genres).forEach((g) => set.add(g)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const toggleGenreFilter = useCallback((genre) => {
    setGenreFilters((prev) =>
      prev.includes(genre) ? prev.filter((g) => g !== genre) : [...prev, genre]
    );
  }, []);

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
  // A few seconds after the last change, so tapping through ratings is one
  // sync of the whole library rather than one each. At once if you've left
  // the app (the wait might not finish).
  const backupTimer = useRef(null);
  const backupNow = useCallback(() => {
    clearTimeout(backupTimer.current);
    backupTimer.current = null;
    maybeBackupLibraryToDrive().then((result) => {
      if (result.attempted && !result.success) {
        Alert.alert('Drive backup failed', result.error || 'Unknown error — try Backup Now in Settings.');
      }
    });
  }, []);
  const backupSilently = useCallback(() => {
    if (AppState.currentState !== 'active') {
      backupNow();
      return;
    }
    clearTimeout(backupTimer.current);
    backupTimer.current = setTimeout(backupNow, 3000);
  }, [backupNow]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && backupTimer.current) backupNow();
    });
    return () => sub.remove();
  }, [backupNow]);

  const rate = useCallback(
    (item, score) => {
      updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, { score }));
      load(); // refresh so the tapped star reflects immediately
      backupSilently();
    },
    [load, backupSilently]
  );

  // Asking for a score when a title is finished (RatePrompt.js): { item,
  // heading, message } while it shows.
  const [ratePrompt, setRatePrompt] = useState(null);
  const askToRate = useCallback((item, message) => {
    setRatePrompt({ item, heading: `Rate "${item.title || item.alt_title || item.source_id}"`, message });
  }, []);
  // A score (or null: none) from the question. With `complete` (⭐ To rate's
  // finished titles) the title is also marked Completed, as the status
  // button does.
  const finishRatePrompt = (score) => {
    const { item, complete } = ratePrompt;
    setRatePrompt(null);
    const fields = score ? { score } : {};
    if (complete) {
      fields.read_status = 'read';
      if (!item.finish_date) fields.finish_date = todayString();
      if (item.total) fields.progress = item.total;
      if (item.total_volumes) fields.progress_volumes = item.total_volumes;
    }
    if (!Object.keys(fields).length) return;
    updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, fields));
    load();
    backupSilently();
  };

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
      // Just completed: how was it?
      if (status === 'read' && item.read_status !== 'read') {
        askToRate(item, `You've completed it${item.score ? ` — your score so far is ${item.score}` : ''}. How was it?`);
      }
    },
    [load, backupSilently, askToRate]
  );

  const handleUpdate = useCallback(
    (item, fields) => {
      updateEntryFields(item.source_id, item.media_type, settlingConflicts(item, fields));
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  // Groups: `ordered` becomes the group called `name`, in that order
  // (group_order 0, 1, 2, …). Used for making, adding to, renaming and
  // reordering a group.
  const handleWriteGroup = useCallback(
    (ordered, name) => {
      ordered.forEach((e, i) => updateEntryFields(e.source_id, e.media_type, { group_name: name, group_order: i }));
      load();
      backupSilently();
    },
    [load, backupSilently]
  );
  const handleLeaveGroup = useCallback(
    (item) => {
      updateEntryFields(item.source_id, item.media_type, { group_name: null, group_order: null });
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

  // "▶ Start reading" / "▶ Continue reading · ch N" (watching for anime):
  // opens the episode/chapter after your progress in its tab (openNext in mediaTypes.js; the tab says if it
  // doesn't exist yet).
  const handleOpenNext = useCallback(
    (item) => {
      const config = MEDIA_TYPES[item.media_type];
      const title = item.title || item.alt_title || item.source_id;
      // Sites mostly list English titles, which imported titles keep as
      // their alternate title.
      const searchTitle = item.alt_title || item.title || item.source_id;
      const unit = item.media_type === 'anime' ? 'episode' : 'chapter';
      let repeating = item.read_status === 'read' && !!item.repeating;
      // Completed: "Reread" turns on rereading from the first chapter.
      if (item.read_status === 'read' && !repeating) {
        handleUpdate(item, { repeating: 1, repeat_progress: 0 });
        item = { ...item, repeating: 1, repeat_progress: 0 };
        repeating = true;
      }
      // During a rewatch/reread, the next one after its own position.
      const n = ((repeating ? item.repeat_progress : item.progress) || 0) + 1;
      if (item.total && n > item.total) {
        Alert.alert(`No next ${unit}`, `"${title}" has ${item.total} ${unit}s and you're at ${n - 1}.`);
        return;
      }
      // Not opened on the site yet (imported from MyAnimeList): searches
      // for it there. Opening it once from the results links it, and the
      // button opens the chapter itself from then on.
      if (isImportedSourceId(item.source_id)) {
        setSelectedKey(null);
        // The tab's title search, with Next › for its other sites.
        onOpenInTab?.(item.media_type, { url: config.buildSearchUrl(searchTitle), search: searchTitle });
        return;
      }
      setSelectedKey(null);
      // From the beginning (Start reading, or a reread that hasn't started):
      // the site's first chapter, whatever it's numbered (openFirst).
      if (n === 1 && config.openFirst) {
        onOpenInTab?.(item.media_type, { ...config.openFirst(item), expect: item.source_id });
        return;
      }
      // A reread that hasn't started (types without openFirst) opens the
      // first one from the series page, not via the last one's Next button.
      const target =
        repeating && !item.repeat_progress ? { ...item, progress: 0, last_progress_url: null } : item;
      onOpenInTab?.(item.media_type, { ...config.openNext(target, n), expect: item.source_id });
    },
    [onOpenInTab, handleUpdate]
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
        {
          text: 'Yes, count it',
          onPress: () => {
            stop(true);
            askToRate(item, `${noun === 'rewatch' ? 'Rewatch' : 'Reread'} counted. Still the same score?`);
          },
        },
      ]);
    },
    [handleUpdate, askToRate]
  );

  // Artists view (artists.js): with a type chosen, 🎭 Artists shows one
  // row per artist instead of the titles. Per type: 'artists' or 'items'.
  const [sectionViews, setSectionViews] = useState({});
  const setSectionView = useCallback((type, view) => setSectionViews((v) => ({ ...v, [type]: view })), []);
  const showingArtists = !!filter && sectionViews[filter] === 'artists';
  // Groups view (types with groups — groupField): one row per group, each
  // opening its own page (GroupModal).
  const showingGroups = !!MEDIA_TYPES[filter]?.groupField && sectionViews[filter] === 'groups';
  // The group whose page is open: { type, name, editing }.
  const [openGroup, setOpenGroup] = useState(null);
  // Favourite artists per type, as Sets of names.
  const loadAllFavorites = () => {
    const all = {};
    MEDIA_TYPE_LIST.forEach((m) => {
      all[m.key] = loadFavoriteArtists(m.key);
    });
    return all;
  };
  const [favoritesByType, setFavoritesByType] = useState(loadAllFavorites);
  const favsOf = (type) => favoritesByType[type] || EMPTY_SET;
  // Hand-moved picture positions (FocusImage.js / artists.js).
  const [pictureFocus, setPictureFocus] = useState(() => loadPictureFocus());
  // Each artist's current picture per type, kept between reloads.
  const coverPicks = useRef({});
  const artistsOf = useCallback(
    (type, list) => {
      if (!coverPicks.current[type]) coverPicks.current[type] = {};
      return buildArtistList(list.filter((e) => e.media_type === type), favoritesByType[type] || EMPTY_SET, coverPicks.current[type]);
    },
    [favoritesByType]
  );
  const artistList = useMemo(() => (filter ? artistsOf(filter, entries) : []), [filter, entries, artistsOf]);
  // Search box above the Artists list; cleared when the type changes.
  const [peopleQuery, setPeopleQuery] = useState('');
  useEffect(() => setPeopleQuery(''), [filter]);
  const shownArtists = useMemo(() => {
    const q = peopleQuery.trim().toLowerCase();
    return q ? artistList.filter((a) => a.name.toLowerCase().includes(q)) : artistList;
  }, [artistList, peopleQuery]);
  // The artist whose details are open: { type, name }.
  const [selectedArtistRef, setSelectedArtistRef] = useState(null);
  const selectedArtist = useMemo(() => {
    if (!selectedArtistRef) return null;
    const list = artistsOf(selectedArtistRef.type, getAllEntries(selectedArtistRef.type));
    return list.find((a) => a.name === selectedArtistRef.name) || null;
  }, [selectedArtistRef, artistsOf, entries]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFavoriteArtist = useCallback(
    (name) => {
      if (!selectedArtistRef) return;
      const type = selectedArtistRef.type;
      setFavoriteArtist(name, !favsOf(type).has(name), type);
      setFavoritesByType(loadAllFavorites());
      backupSilently();
    },
    [selectedArtistRef, favoritesByType, backupSilently] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const saveFocus = useCallback(
    (artist, focus) => {
      if (!selectedArtistRef) return;
      setPictureFocus(savePictureFocus(selectedArtistRef.type, artist.name, artist.cover, focus));
    },
    [selectedArtistRef]
  );
  // From an artist's details: back to that type's titles, filtered to them.
  const showArtistTitles = useCallback(
    (name) => {
      const type = selectedArtistRef ? selectedArtistRef.type : filter;
      setSelectedArtistRef(null);
      setRandomOpened(false);
      setFilter(type);
      setSectionView(type, 'items');
      setArtistFilter(name);
    },
    [selectedArtistRef, filter, setSectionView]
  );

  // 🎲 Random: its window, its choices, and what this round has shown.
  const [randomVisible, setRandomVisible] = useState(false);
  const [randomChoice, setRandomChoice] = useState(loadRandomChoice);
  const changeRandomChoice = useCallback((choice) => {
    setRandomChoice(choice);
    setSetting('randomChoice', JSON.stringify(choice));
  }, []);
  const randomShown = useRef(new Set());
  // What Random last opened ('entry' / 'artist'), for "Pick again".
  const [randomOpened, setRandomOpened] = useState(false);

  // Picks with the Random window's choices and opens the pick's details: a
  // title, or (Pick a: Artist) an artist credited on the matching titles —
  // where the Rating row's ♥ means your ★ favourite artists. Skips what
  // this round has shown until every match has been, and never repeats
  // the one on screen.
  const pickRandomNow = useCallback(() => {
    const byType = getAllEntries(null).filter(
      (e) =>
        (randomChoice.types.length === 0 || randomChoice.types.includes(e.media_type)) &&
        (randomChoice.statuses.length === 0 || randomChoice.statuses.includes(e.read_status))
    );
    const artistMode = randomChoice.kind === 'artist';
    let items;
    if (artistMode) {
      const SEP = '\u0000';
      const namesOf = (list) => list.flatMap((e) => parseAuthors(e.author).map((n) => `${e.media_type}${SEP}${n}`));
      const ratings = randomChoice.ratings;
      const others = ratings.filter((r) => r !== 'favorite');
      if (ratings.length === 0) items = namesOf(byType);
      else {
        items = [
          ...(others.length ? namesOf(byType.filter((e) => matchesRandomRating(e, others))) : []),
          ...(ratings.includes('favorite')
            ? namesOf(byType).filter((key) => {
                const [type, name] = key.split(SEP);
                return favsOf(type).has(name);
              })
            : []),
        ];
      }
      items = Array.from(new Set(items));
    } else {
      items = byType.filter((e) => matchesRandomRating(e, randomChoice.ratings)).map((e) => `${e.media_type}:${e.source_id}`);
    }
    if (items.length === 0) {
      Alert.alert('Nothing to pick', 'Nothing in your Library matches those choices.');
      return;
    }
    const current = artistMode
      ? selectedArtistRef && `${selectedArtistRef.type}\u0000${selectedArtistRef.name}`
      : selectedKey;
    let options = items.filter((item) => !randomShown.current.has(item));
    if (options.length === 0) {
      // Every match has been shown: start over, avoiding the one on screen.
      randomShown.current = new Set();
      options = items.length > 1 ? items.filter((item) => item !== current) : items;
    }
    const pick = options[Math.floor(Math.random() * options.length)];
    randomShown.current.add(pick);
    setRandomVisible(false);
    setRandomOpened(artistMode ? 'artist' : 'entry');
    if (artistMode) {
      const [type, name] = pick.split('\u0000');
      setSelectedKey(null);
      setSelectedArtistRef({ type, name });
    } else {
      setSelectedArtistRef(null);
      setSelectedKey(pick);
    }
  }, [randomChoice, selectedKey, selectedArtistRef, favoritesByType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each press of 🎲 Random starts a new round, with the choices left
  // last time.
  const openRandom = useCallback(() => {
    randomShown.current = new Set();
    setRandomVisible(true);
  }, []);

  // ♥ in an entry's details.
  const handleToggleFavorite = useCallback(
    (item) => {
      updateEntryFields(item.source_id, item.media_type, { favorite: item.favorite ? 0 : 1 });
      load();
      backupSilently();
    },
    [load, backupSilently]
  );

  // The filter section folds away into one bar: what's on, plus ✕ to
  // clear it all.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterSummary = [
    ...(artistFilter ? [{ icon: 'people', text: artistFilter }] : []),
    ...(minRating === 'noCover' ? [{ icon: 'noCover' }] : minRating === 'favorite' ? [{ icon: 'heart' }] : minRating ? [{ icon: 'star', text: `${minRating}+` }] : []),
    ...(readStatusFilter ? [{ icon: readStatusFilter }] : []),
    ...(conflictsOnly ? [{ icon: 'warning' }] : []),
    ...genreFilters.map((g) => ({ text: g })),
    ...tagFilters.map((t) => ({ text: `#${t}` })),
  ];
  const clearFilters = () => {
    setArtistFilter('');
    setMinRating(null);
    setReadStatusFilter(null);
    setConflictsOnly(false);
    setTagFilters([]);
    setGenreFilters([]);
  };

  // "Pick again" is only offered on details opened by Random.
  useEffect(() => {
    if (!selectedKey && !selectedArtistRef) setRandomOpened(false);
  }, [selectedKey, selectedArtistRef]);

  // Gone at once, with Undo for a few seconds (undo.js); only then is it
  // deleted with its thumbnail, and from the Drive backup.
  const handleDeleteEntry = useCallback(
    (item) => {
      const key = `${item.media_type}:${item.source_id}`;
      hiddenKeys.current.add(key);
      setSelectedKey(null); // close the detail modal since its entry is gone
      load();
      offerUndo({
        message: `Deleted "${item.title || item.source_id}"`,
        commit: async () => {
          if (item.local_image_path) {
            await FileSystem.deleteAsync(item.local_image_path, { idempotent: true }).catch(() => {});
          }
          deleteEntry(item.source_id, item.media_type);
          hiddenKeys.current.delete(key);
          loadRef.current();
          backupSilently(); // reflect the removal in the Drive CSV too
        },
        undo: () => {
          hiddenKeys.current.delete(key);
          loadRef.current();
        },
      });
    },
    [load, backupSilently]
  );

  // ---------- Select mode: changing several entries at once ----------

  const keyOf = (e) => `${e.media_type}:${e.source_id}`;
  const pickedEntries = useMemo(
    () => (picked ? entries.filter((e) => picked.has(keyOf(e))) : []),
    [picked, entries]
  );
  const togglePick = (key) =>
    setPicked((p) => {
      const next = new Set(p || []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const stopPicking = () => {
    setPicked(null);
    setStatusSheet(false);
  };
  // Back leaves select mode first.
  useEffect(() => {
    if (!picked) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      stopPicking();
      return true;
    });
    return () => sub.remove();
  }, [picked]);

  // Applies change(entry) to every picked entry; each returns how to put
  // it back, or null when it didn't apply. Then Undo for a few seconds
  // (undo.js) puts them all back.
  const applyToPicked = (message, change) => {
    const restores = pickedEntries.map(change).filter(Boolean);
    stopPicking();
    if (!restores.length) {
      Alert.alert('Nothing changed', 'The selected titles were already like that.');
      return;
    }
    load();
    backupSilently();
    offerUndo({
      message: `${message}: ${restores.length} title${restores.length === 1 ? '' : 's'}`,
      commit: () => {},
      undo: () => {
        restores.forEach((r) => r());
        loadRef.current();
        backupSilently();
      },
    });
  };

  // Like a single status change (handleSetReadStatus): starting fills in
  // the start date, completing the finish date and full progress.
  const bulkSetStatus = (status) =>
    applyToPicked('Status changed', (e) => {
      if ((e.read_status || null) === status) return null;
      const before = {
        read_status: e.read_status || null,
        start_date: e.start_date || null,
        finish_date: e.finish_date || null,
        progress: e.progress ?? null,
        progress_volumes: e.progress_volumes ?? null,
      };
      const fields = { read_status: status };
      if (status === 'reading' && !e.start_date) fields.start_date = todayString();
      if (status === 'read') {
        if (!e.finish_date) fields.finish_date = todayString();
        if (e.total) fields.progress = e.total;
        if (e.total_volumes) fields.progress_volumes = e.total_volumes;
      }
      updateEntryFields(e.source_id, e.media_type, settlingConflicts(e, fields));
      return () => updateEntryFields(e.source_id, e.media_type, before);
    });

  // Favourite turns on for all, unless all already are: then off.
  const bulkFavorite = () => {
    const on = !pickedEntries.every((e) => e.favorite);
    applyToPicked(on ? 'Made favourites' : 'Favourites removed', (e) => {
      if (!!e.favorite === on) return null;
      updateEntryFields(e.source_id, e.media_type, { favorite: on ? 1 : 0 });
      return () => updateEntryFields(e.source_id, e.media_type, { favorite: on ? 0 : 1 });
    });
  };

  // Gone at once with Undo, like a single delete (handleDeleteEntry).
  const bulkDelete = () => {
    const items = pickedEntries;
    if (!items.length) return;
    items.forEach((e) => hiddenKeys.current.add(keyOf(e)));
    stopPicking();
    load();
    offerUndo({
      message: `Deleted ${items.length} title${items.length === 1 ? '' : 's'}`,
      commit: async () => {
        for (const e of items) {
          if (e.local_image_path) await FileSystem.deleteAsync(e.local_image_path, { idempotent: true }).catch(() => {});
          deleteEntry(e.source_id, e.media_type);
          hiddenKeys.current.delete(keyOf(e));
        }
        loadRef.current();
        backupSilently();
      },
      undo: () => {
        items.forEach((e) => hiddenKeys.current.delete(keyOf(e)));
        loadRef.current();
      },
    });
  };

  // The statuses offered: the titles' own words when they're all one
  // type, else both words.
  const bulkStatusOptions = () => {
    const types = [...new Set(pickedEntries.map((e) => e.media_type))];
    const one = types.length === 1 ? getReadStatusLabels(types[0]) : null;
    const both = { reading: 'Reading / Watching', read: 'Read / Watched', on_hold: 'On Hold', dropped: 'Dropped', want: 'Want to Read / Watch' };
    return [
      ...READ_STATUSES.map((s) => ({ key: s.key, icon: s.key, label: (one || both)[s.label] || both[s.label] })),
      { key: null, label: 'No status' },
    ];
  };

  // Looked up by key rather than kept as a snapshot object, so the modal
  // reflects rating changes made while it's open instead of going stale.
  // Random can pick outside the current type filter, so fall back to the
  // database.
  const selectedEntry = selectedKey
    ? entries.find((e) => `${e.media_type}:${e.source_id}` === selectedKey) ||
      getEntry(selectedKey.slice(selectedKey.indexOf(':') + 1), selectedKey.split(':')[0])
    : null;
  const conflictCount = entries.filter((e) => e.mal_conflicts).length;
  // Groups: every entry of the open one's type (whatever the type filter
  // shows), and the members of its group, in order. `entries` is a
  // dependency so changes show straight away.
  const selectedType = selectedEntry?.media_type;
  const sameTypeEntries = useMemo(
    () => (selectedType && MEDIA_TYPES[selectedType]?.groupField ? getAllEntries(selectedType) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedType, entries]
  );
  const groupMembers = useMemo(() => {
    const name = groupKey(selectedEntry?.group_name);
    if (!name) return [];
    return sameTypeEntries.filter((e) => groupKey(e.group_name) === name).sort(groupOrder);
  }, [sameTypeEntries, selectedEntry]);
  // Groups view: every entry of the type (the open group's too), every
  // group in it A–Z with its entries in order, how many, and a cover.
  const groupsType = showingGroups ? filter : openGroup?.type;
  const groupsTypeEntries = useMemo(
    () => (groupsType ? getAllEntries(groupsType) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupsType, entries]
  );
  const groupList = useMemo(() => {
    if (!showingGroups) return [];
    const byKey = new Map();
    groupsTypeEntries.forEach((e) => {
      if (!e.group_name) return;
      const key = groupKey(e.group_name);
      const g = byKey.get(key) || byKey.set(key, { name: e.group_name, members: [] }).get(key);
      g.members.push(e);
    });
    return [...byKey.values()]
      .map((g) => {
        const members = g.members.sort(groupOrder);
        return { ...g, members, count: members.length, cover: members.find((m) => m.local_image_path)?.local_image_path || null };
      })
      .filter((g) => {
        const words = peopleQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return words.every((w) => g.name.toLowerCase().includes(w));
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [showingGroups, groupsTypeEntries, peopleQuery]);
  const openGroupMembers = useMemo(
    () =>
      openGroup ? groupsTypeEntries.filter((e) => groupKey(e.group_name) === groupKey(openGroup.name)).sort(groupOrder) : [],
    [openGroup, groupsTypeEntries]
  );

  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const togglePickRef = useRef(togglePick);
  const handleRowPress = useCallback((item) => {
    const key = `${item.media_type}:${item.source_id}`;
    if (pickedRef.current) togglePickRef.current(key);
    else setSelectedKey(key);
  }, []);
  const handleRowLongPress = useCallback((item) => {
    const key = `${item.media_type}:${item.source_id}`;
    if (pickedRef.current) togglePickRef.current(key);
    else setPicked(new Set([key]));
  }, []);
  const renderEntryRow = useCallback(
    ({ item }) => (
      <EntryRow
        item={item}
        picking={!!picked}
        isPicked={!!picked && picked.has(`${item.media_type}:${item.source_id}`)}
        showType={filter === null}
        onPress={handleRowPress}
        onLongPress={handleRowLongPress}
        dark={dark}
      />
    ),
    [picked, filter, handleRowPress, handleRowLongPress, dark]
  );
  // Random picks a title: beside the search box in every view.
  const randomButton = (
    <TouchableOpacity
      ref={tourTarget('library.random')}
      style={styles.randomIconButton}
      onPress={openRandom}
      accessibilityRole="button"
      accessibilityLabel="Random: pick a title for me"
    >
      <Text style={styles.randomIconText}><Icon name="random" size={24} /></Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Only while something is waiting for a score (ToRate.js). */}
      {toRate.count ? (
        <View style={styles.topButtons}>
          <TouchableOpacity style={[styles.toRateButton, styles.topButton]} onPress={() => setToRateVisible(true)} accessibilityRole="button">
            <Text style={styles.toRateButtonText}>
              <Icon name="starOutline" size={16} /> To rate · {toRate.count}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View ref={tourTarget('library.types')} style={[styles.filterBar, styles.filterBarWrap]}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key ?? 'all'}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            hitSlop={CHIP_SLOP}
            onPress={() => setFilter(f.key)}
          >
            <Text style={filter === f.key ? styles.filterTextActive : styles.filterText}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {filter ? (
        <View style={styles.filterBar}>
          {[
            { key: 'items', icon: 'books', label: 'Titles' },
            { key: 'artists', icon: 'people', label: 'Artists' },
            ...(MEDIA_TYPES[filter]?.groupField ? [{ key: 'groups', icon: 'groups', label: 'Groups' }] : []),
          ].map((v) => {
            const active = (sectionViews[filter] || 'items') === v.key;
            return (
              <TouchableOpacity
                key={v.key}
                style={[styles.filterChip, active && styles.filterChipActive]}
                hitSlop={CHIP_SLOP}
                onPress={() => setSectionView(filter, v.key)}
              >
                <Text style={active ? styles.filterTextActive : styles.filterText}>
                  <IconText icon={v.icon} size={15}>{v.label}</IconText>
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {showingGroups ? (
        <>
          <View style={styles.peopleSearchRow}>
            <TextInput
              style={[styles.tagInput, { flex: 1 }]}
              value={peopleQuery}
              onChangeText={setPeopleQuery}
              placeholder="Search groups…"
              placeholderTextColor={themeColor('#666')}
              autoCorrect={false}
              returnKeyType="search"
            />
            {peopleQuery ? (
              <TouchableOpacity style={styles.artistFilterClearButton} onPress={() => setPeopleQuery('')} accessibilityLabel="Clear">
                <Text style={styles.artistFilterClear}><Icon name="close" size={18} /></Text>
              </TouchableOpacity>
            ) : null}
            {randomButton}
          </View>
          <FlatList
            extraData={dark}
            style={styles.list}
            data={groupList}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => groupKey(item.name)}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => setOpenGroup({ type: filter, name: item.name, editing: false })}
                onLongPress={() => setOpenGroup({ type: filter, name: item.name, editing: true })}
              >
                {item.cover ? (
                  <Image source={{ uri: item.cover }} style={styles.thumb} resizeMethod="resize" />
                ) : (
                  <View style={[styles.thumb, styles.thumbPlaceholder]} />
                )}
                <View style={styles.meta}>
                  <Marquee style={styles.groupRowName} containerStyle={styles.groupRowNameBox}>
                    {item.name}
                  </Marquee>
                  <Text style={styles.author} numberOfLines={1}>
                    {titleCount(item.count)} · {item.members.map((m) => m.title || m.source_id).join(' · ')}
                  </Text>
                </View>
                <Text style={styles.groupOpen}>›</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                {peopleQuery ? 'No group matches.' : 'No groups yet — open a title and use Add to a group… in its details.'}
              </Text>
            }
          />
        </>
      ) : showingArtists ? (
        <>
          <View style={styles.peopleSearchRow}>
            <TextInput
              style={[styles.tagInput, { flex: 1 }]}
              value={peopleQuery}
              onChangeText={setPeopleQuery}
              placeholder="Search artists…"
              placeholderTextColor={themeColor('#666')}
              autoCorrect={false}
              returnKeyType="search"
            />
            {peopleQuery ? (
              <TouchableOpacity style={styles.artistFilterClearButton} onPress={() => setPeopleQuery('')} accessibilityLabel="Clear">
                <Text style={styles.artistFilterClear}><Icon name="close" size={18} /></Text>
              </TouchableOpacity>
            ) : null}
            {randomButton}
          </View>
          <FlatList
            extraData={dark}
            style={styles.list}
            data={shownArtists}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.name}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.artistListRow}
                onPress={() => setSelectedArtistRef({ type: filter, name: item.name })}
              >
                {item.cover ? (
                  <FocusImage
                    uri={item.cover}
                    style={styles.artistListImage}
                    focus={focusFor(pictureFocus, filter, item.name, item.cover)}
                  />
                ) : (
                  <View style={[styles.artistListImage, styles.thumbPlaceholder]} />
                )}
                <View style={styles.meta}>
                  <Text style={styles.artistListName} numberOfLines={3}>
                    {item.name}
                  </Text>
                  <Text style={styles.author}>{titleCount(item.count)}</Text>
                </View>
                {favsOf(filter).has(item.name) ? (
                  <Text style={styles.favoriteStar}>
                    <Icon name="star" size={18} />
                  </Text>
                ) : null}
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>
                No artists yet — they appear here from the authors of your saved titles.
              </Text>
            }
          />
        </>
      ) : (
        <>
      {/* Search and the Filters button share a row, so the list keeps the
          screen; what's on shows under them, with ✕ to clear it. */}
      <View style={styles.filterToggleRow}>
        <TextInput
          style={styles.tagInput}
          value={titleQuery}
          onChangeText={setTitleQuery}
          placeholder="Search titles…"
          placeholderTextColor={themeColor('#666')}
          autoCorrect={false}
          returnKeyType="search"
        />
        {titleQuery ? (
          <TouchableOpacity style={styles.artistFilterClearButton} onPress={() => setTitleQuery('')} accessibilityLabel="Clear search">
            <Text style={styles.artistFilterClear}><Icon name="close" size={18} /></Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          ref={tourTarget('library.filters')}
          style={styles.filterToggle}
          onPress={() => setFiltersOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityState={{ expanded: filtersOpen }}
        >
          <Text style={styles.filterToggleText} numberOfLines={1}>
            <Icon name="filters" size={16} /> Filters
          </Text>
          <Text style={styles.filterToggleArrow}><Icon name={filtersOpen ? 'chevronUp' : 'chevronDown'} size={16} /></Text>
        </TouchableOpacity>
        {randomButton}
      </View>
      {activeFilterSummary.length ? (
        <View style={styles.filterSummaryRow}>
          <Text style={styles.filterSummaryText} numberOfLines={1}>
            {activeFilterSummary.map((s, i) => (
              <React.Fragment key={i}>
                {i ? ' · ' : ''}
                <IconText icon={s.icon} size={14}>{s.text}</IconText>
              </React.Fragment>
            ))}
          </Text>
          <TouchableOpacity onPress={clearFilters} hitSlop={TAP_SLOP} accessibilityRole="button" accessibilityLabel="Clear filters">
            <Text style={styles.artistFilterClear}><Icon name="close" size={18} /></Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {filtersOpen ? (
      <View style={styles.filterPanel}>
      <View style={[styles.filterBar, styles.filterBarWrap]}>
        {SORTS.map((s) => (
          <TouchableOpacity
            key={s.key}
            style={[styles.filterChip, sort === s.key && styles.filterChipActive]}
            hitSlop={CHIP_SLOP}
            onPress={() => setSort(s.key)}
          >
            <Text style={sort === s.key ? styles.filterTextActive : styles.filterText}>
              <IconText icon={s.icon} size={15}>{s.label}</IconText>
            </Text>
          </TouchableOpacity>
        ))}
        {conflictCount > 0 || conflictsOnly ? (
          <TouchableOpacity
            style={[styles.filterChip, styles.reviewChip, conflictsOnly && styles.filterChipActive]}
            hitSlop={CHIP_SLOP}
            onPress={() => setConflictsOnly((v) => !v)}
          >
            <Text style={conflictsOnly ? styles.filterTextActive : styles.reviewChipText}>
              <Icon name="warning" size={15} /> To review ({conflictCount})
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.artistFilterRow}>
        <TouchableOpacity
          style={styles.artistFilterButton}
          onPress={openArtistFilter}
        >
          <Text style={styles.artistFilterButtonText}>
            <Icon name="people" size={16} /> {artistFilter ? `Artist: ${artistFilter}` : 'Filter by Artist'}
          </Text>
        </TouchableOpacity>
        {artistFilter ? (
          <TouchableOpacity style={styles.artistFilterClearButton} onPress={() => setArtistFilter('')} accessibilityLabel="Clear">
            <Text style={styles.artistFilterClear}><Icon name="close" size={18} /></Text>
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
            hitSlop={CHIP_SLOP}
            onPress={() => setMinRating(r.key)}
          >
            <Text style={minRating === r.key ? styles.filterTextActive : styles.filterText}>
              <IconText icon={r.icon} size={15}>{r.label}</IconText>
            </Text>
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
            hitSlop={CHIP_SLOP}
            onPress={() => setReadStatusFilter(r.key)}
          >
            <Text style={readStatusFilter === r.key ? styles.filterTextActive : styles.filterText}>
              <IconText icon={r.icon} size={15}>{r.label}</IconText>
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {allGenres.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tagFilterBar}
          contentContainerStyle={styles.tagFilterBarContent}
        >
          {allGenres.map((genre) => (
            <TouchableOpacity
              key={genre}
              style={[styles.filterChip, genreFilters.includes(genre) && styles.filterChipActive]}
              hitSlop={CHIP_SLOP}
              onPress={() => toggleGenreFilter(genre)}
            >
              <Text style={genreFilters.includes(genre) ? styles.filterTextActive : styles.filterText}>
                {genre}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
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
              hitSlop={CHIP_SLOP}
              onPress={() => toggleTagFilter(tag)}
              onLongPress={() => toggleFavoriteTag(tag)}
              accessibilityHint={favoriteTags.has(tag.toLowerCase()) ? 'Hold to remove from favourite tags' : 'Hold to make it a favourite tag'}
            >
              <Text style={tagFilters.includes(tag) ? styles.filterTextActive : styles.filterText}>
                {favoriteTags.has(tag.toLowerCase()) ? <><Icon name="star" size={13} /> </> : null}#{tag}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
      </View>
      ) : null}

      {picked ? (
        <View style={styles.selectBar}>
          <View style={styles.selectTop}>
            <TouchableOpacity onPress={stopPicking} hitSlop={TAP_SLOP} accessibilityRole="button" accessibilityLabel="Stop selecting">
              <Text style={styles.selectClose}>
                <Icon name="close" size={22} />
              </Text>
            </TouchableOpacity>
            <Text style={styles.selectCount}>{picked.size} selected</Text>
            <TouchableOpacity
              style={styles.selectAll}
              onPress={() =>
                setPicked(picked.size === displayEntries.length ? new Set() : new Set(displayEntries.map(keyOf)))
              }
            >
              <Text style={styles.selectAllText}>
                {picked.size === displayEntries.length && picked.size > 0 ? 'Select none' : `Select all (${displayEntries.length})`}
              </Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectActions}>
            {[
              { icon: 'want_to_read', label: 'Status…', onPress: () => setStatusSheet(true) },
              pickedEntries.length && pickedEntries.every((e) => e.favorite)
                ? { icon: 'heartOutline', label: 'Unfavourite', onPress: bulkFavorite }
                : { icon: 'heart', label: 'Favourite', onPress: bulkFavorite },
              { icon: 'delete', label: 'Delete', onPress: bulkDelete, danger: true },
            ].map((a) => (
              <TouchableOpacity
                key={a.label}
                style={[styles.selectAction, !pickedEntries.length && styles.selectActionOff]}
                onPress={a.onPress}
                disabled={!pickedEntries.length}
              >
                <Text style={[styles.selectActionText, a.danger && styles.selectActionDanger]}>
                  <IconText icon={a.icon} size={16}>{a.label}</IconText>
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <FlatList
        ref={tourTarget('library.list')}
        extraData={picked}
        style={styles.list}
        data={displayEntries}
        keyExtractor={(item) => `${item.media_type}:${item.source_id}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={renderEntryRow}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {entries.length === 0
              ? 'Nothing recorded yet. Open a site tab, and the titles you visit are saved here.'
              : 'No entries match your current filters.'}
          </Text>
        }
      />
        </>
      )}

      {/* Groups view: the group whose row was tapped (held: opens in Edit). */}
      <GroupModal
        visible={!!openGroup && openGroupMembers.length > 0}
        editing={!!openGroup?.editing}
        onEditing={(on) => setOpenGroup((g) => (g ? { ...g, editing: on } : g))}
        name={openGroup?.name}
        members={openGroupMembers}
        sameType={groupsTypeEntries}
        currentId={null}
        onClose={() => setOpenGroup(null)}
        onOpen={(p) => {
          setOpenGroup(null);
          setSelectedKey(`${p.media_type}:${p.source_id}`);
        }}
        onWriteGroup={(ordered, name) => {
          handleWriteGroup(ordered, name);
          setOpenGroup((g) => (g ? { ...g, name } : g)); // follows a rename
        }}
        onLeave={handleLeaveGroup}
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
        onOpenUrl={(item) => {
          setSelectedKey(null);
          onOpenInTab?.(item.media_type, { url: item.source_url });
        }}
        onSetRepeating={handleSetRepeating}
        onPickAgain={randomOpened === 'entry' ? pickRandomNow : null}
        onToggleFavorite={handleToggleFavorite}
        onDelete={handleDeleteEntry}
        groupMembers={groupMembers}
        sameTypeEntries={sameTypeEntries}
        onWriteGroup={handleWriteGroup}
        onLeaveGroup={handleLeaveGroup}
        onOpenEntry={(e) => setSelectedKey(`${e.media_type}:${e.source_id}`)}
      />

      {/* Select mode's Status… choice. */}
      <Modal visible={statusSheet && !!picked} transparent animationType="fade" onRequestClose={() => setStatusSheet(false)}>
        <TouchableOpacity style={styles.selectSheetOverlay} activeOpacity={1} onPress={() => setStatusSheet(false)}>
          <View style={styles.selectSheet}>
            <Text style={styles.selectSheetTitle}>
              Set status of {pickedEntries.length} title{pickedEntries.length === 1 ? '' : 's'}
            </Text>
            <ScrollView>
              {bulkStatusOptions().map((o) => (
                <TouchableOpacity key={String(o.key)} style={styles.selectSheetRow} onPress={() => bulkSetStatus(o.key)}>
                  <Text style={styles.selectSheetRowText}>
                    <IconText icon={o.icon} size={17}>{o.label}</IconText>
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.selectSheetCancel} onPress={() => setStatusSheet(false)}>
              <Text style={styles.selectSheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <ToRateModal
        visible={toRateVisible}
        list={toRate}
        onRate={(item, { complete }) =>
          complete
            ? setRatePrompt({
                item,
                complete: true,
                heading: `Finished "${item.title || item.alt_title || item.source_id}"?`,
                message: `You're at the last ${item.media_type === 'anime' ? 'episode' : 'chapter'} (${item.progress} of ${
                  item.total
                }). Rate it to mark it Completed:`,
                closeLabel: 'Not yet',
              })
            : askToRate(item, 'How was it?')
        }
        onSkip={(item) => {
          skipRating(item);
          load();
        }}
        onClose={() => setToRateVisible(false)}
      />

      <RatePrompt
        prompt={
          ratePrompt && {
            ...ratePrompt,
            score: ratePrompt.item.score,
            actions: ratePrompt.complete
              ? [{ label: 'Just mark Completed', onPress: () => finishRatePrompt(null) }]
              : undefined,
          }
        }
        onRate={finishRatePrompt}
        onClose={() => setRatePrompt(null)}
      />

      <ArtistDetailModal
        artist={selectedArtist}
        isFavorite={!!selectedArtist && !!selectedArtistRef && favsOf(selectedArtistRef.type).has(selectedArtist.name)}
        onToggleFavorite={toggleFavoriteArtist}
        onShowTitles={showArtistTitles}
        onClose={() => setSelectedArtistRef(null)}
        onPickAgain={randomOpened === 'artist' ? pickRandomNow : null}
        focus={
          selectedArtist && selectedArtistRef
            ? focusFor(pictureFocus, selectedArtistRef.type, selectedArtist.name, selectedArtist.cover)
            : null
        }
        onSaveFocus={saveFocus}
      />

      <RandomModal
        visible={randomVisible}
        choice={randomChoice}
        onChange={changeRandomChoice}
        onPick={pickRandomNow}
        onClose={() => setRandomVisible(false)}
      />

      <Modal
        visible={artistModalVisible}
        animationType="slide"
        onRequestClose={() => setArtistModalVisible(false)}
      >
        <KeyboardPad style={styles.logModal}>
          <View style={styles.logHeader}>
            <Text style={styles.logTitle}>Filter by Artist</Text>
            <TouchableOpacity onPress={() => setArtistModalVisible(false)}>
              <Text style={styles.logClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.logScroll}>
            {artistFilter ? (
              <TouchableOpacity style={styles.artistClearRow} onPress={() => selectArtist('')}>
                <Text style={styles.artistClearRowText}>
                  <Icon name="close" size={15} /> Clear current filter
                </Text>
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
        </KeyboardPad>
      </Modal>
    </View>
  );
}

const styles = themed(StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  filterBar: { flexDirection: 'row', padding: 10, gap: 8 },
  filterBarWrap: { flexWrap: 'wrap' },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#eee',
  },
  filterChipActive: { backgroundColor: '#1d1f20' },
  statusFilterBar: { flexGrow: 0 },
  statusFilterBarContent: { padding: 10, gap: 8 },
  filterText: { color: '#333', fontSize: 14 },
  filterTextActive: { color: '#fff', fontSize: 14, fontWeight: '600' },
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
    minWidth: 48,
    alignItems: 'center',
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
    fontSize: 14,
    fontWeight: '700',
    color: '#666',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  artistRow: { paddingHorizontal: 16, paddingVertical: 12 },
  artistRowActive: { backgroundColor: '#e8edf5' },
  artistRowText: { fontSize: 16, color: '#222' },
  artistRowTextActive: { fontSize: 16, color: '#1d1f20', fontWeight: '700' },
  logModal: { flex: 1, backgroundColor: '#fff' },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  logTitle: { fontSize: 22, fontWeight: '700' },
  logClose: { color: '#1d1f20', fontSize: 16 },
  logScroll: { flex: 1 },
  logLine: { padding: 16, color: '#666', fontSize: 14 },
  list: { flex: 1 },
  // Select mode (hold a title).
  rowPicked: { backgroundColor: '#ececec', borderColor: '#1d1f20', borderWidth: 2, padding: 12 },
  pickMark: { color: '#1d1f20', marginRight: 10, minWidth: 24 },
  selectBar: { backgroundColor: '#1d1f20', paddingVertical: 6 },
  selectTop: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 12, minHeight: 48 },
  selectClose: { color: '#fff' },
  selectCount: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1 },
  selectAll: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  selectAllText: { color: '#fff', fontSize: 14, textDecorationLine: 'underline' },
  selectActions: { paddingHorizontal: 8, gap: 8 },
  selectAction: {
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
    marginVertical: 4,
  },
  selectActionOff: { opacity: 0.5 },
  selectActionText: { color: '#1d1f20', fontSize: 14, fontWeight: '600' },
  selectActionDanger: { color: '#c0392b' },
  selectSheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  selectSheet: { backgroundColor: '#fff', borderRadius: 12, padding: 20, maxHeight: '80%' },
  selectSheetTitle: { fontSize: 22, fontWeight: '700', color: '#222', marginBottom: 8 },
  selectSheetRow: { minHeight: 48, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  selectSheetRowText: { fontSize: 16, color: '#222' },
  selectSheetCancel: { alignSelf: 'flex-end', minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, marginTop: 8 },
  selectSheetCancelText: { color: '#666', fontSize: 16 },
  // Each entry is a rounded card.
  row: {
    flexDirection: 'row',
    padding: 13,
    marginHorizontal: 10,
    marginVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  // A coloured border and label: pink for ♥ favourites, red for 🔥 Super
  // Want; an entry that's both is pink on the top and left, red on the bottom
  // and right, with both labels. The padding keeps the content in place.
  rowOutlined: { borderWidth: 2, padding: 12 },
  rowLabels: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, marginBottom: 3 },
  rowLabelFavorite: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: '#c2184b' },
  rowLabelSuper: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, color: '#b3261e' },
  rowFavorite: { borderColor: '#e94560' },
  rowSuperWant: { borderColor: '#b3261e' },
  rowBoth: { borderBottomColor: '#b3261e', borderRightColor: '#b3261e' },
  thumb: { width: 80, height: 80, borderRadius: 8, backgroundColor: '#eee' },
  // Groups (GroupDetails, GroupModal and their sheets).
  groupActionButton: { minHeight: 48, justifyContent: 'center' },
  groupAddButton: { flex: 1, minHeight: 48, backgroundColor: '#1d1f20', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  groupBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1d1f20', paddingHorizontal: 4, minHeight: 56 },
  groupBarAction: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  groupBarButton: { minWidth: 48, minHeight: 48, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  groupBarInput: { flex: 1, color: '#ffffff', fontSize: 22, borderBottomWidth: 2, borderBottomColor: '#ffffff', paddingVertical: 6 },
  groupBarTitle: { fontSize: 22, fontWeight: '700', color: '#ffffff' },
  groupButtonText: { color: '#fff', fontWeight: '600' },
  groupButtonOff: { opacity: 0.4 },
  groupCard: { borderWidth: 1, borderColor: '#dde3ee', borderRadius: 12, padding: 10, marginTop: 4 },
  groupCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  groupCoverThis: { borderWidth: 3, borderColor: '#1d1f20' },
  groupEditBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  groupEditChip: { minHeight: 40, borderWidth: 1, borderColor: '#1d1f20', borderRadius: 24, paddingHorizontal: 14, justifyContent: 'center' },
  groupEditChipText: { color: '#1d1f20', fontWeight: '700', fontSize: 14 },
  groupGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6, marginTop: 8 },
  groupGridCover: { width: '100%', aspectRatio: 0.72, borderRadius: 8, backgroundColor: '#eee' },
  groupGridItem: { width: '33.33%', paddingHorizontal: 6, marginBottom: 14 },
  groupGridNumber: { color: '#666', fontWeight: '700' },
  groupGridTitle: { fontSize: 14, color: '#222', marginTop: 4 },
  groupHint: { fontSize: 14, color: '#666', marginBottom: 8 },
  groupMenu: { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16 },
  groupMenuOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 32 },
  groupMenuRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  groupMenuText: { fontSize: 16, color: '#222' },
  groupMenuTitle: { fontSize: 16, fontWeight: '700', color: '#222', paddingVertical: 10 },
  groupNumber: { minWidth: 28, fontWeight: '700', color: '#1d1f20' },
  groupPickCover: { width: 40, height: 56, borderRadius: 4, backgroundColor: '#eee' },
  groupPickName: { fontSize: 16, color: '#222', fontWeight: '600', flexShrink: 1 },
  groupPickNew: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#eef1f8' },
  groupPickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 6 },
  groupRowDragged: { backgroundColor: '#eef1f8', elevation: 6, zIndex: 10 },
  groupRowThisBg: { backgroundColor: '#eef1f8' },
  groupScreen: { flex: 1, backgroundColor: '#fff' },
  groupScroll: { flex: 1 },
  groupScrollContent: { padding: 16, paddingBottom: 80 },
  groupSheetSearch: { flex: 0, marginBottom: 8 },
  groupSheetTitle: { fontSize: 22, fontWeight: '700', color: '#222', marginBottom: 10 },
  groupStrip: { gap: 8, paddingTop: 4 },
  groupStripCover: { width: 56, height: 78, borderRadius: 8, backgroundColor: '#eee' },
  groupStripItem: { alignItems: 'center', minWidth: 48 },
  groupStripNumber: { fontSize: 12, color: '#666', marginTop: 2 },
  groupStripNumberThis: { color: '#1d1f20', fontWeight: '700' },
  groupSubText: { color: '#666', fontSize: 14 },
  thumbPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  meta: { marginLeft: 12, flex: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  author: { fontSize: 14, color: '#666', marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
  scoreBadge: { fontSize: 14, color: '#b26a00', fontWeight: '700' },
  conflictBadge: { fontSize: 12, color: '#b9770e' },
  reviewChip: { backgroundColor: '#fdf2d8' },
  reviewChipText: { color: '#b9770e', fontSize: 14, fontWeight: '600' },
  conflictBox: {
    backgroundColor: '#fdf6e3',
    borderRadius: 12,
    padding: 10,
    marginBottom: 12,
  },
  conflictTitle: { fontSize: 14, fontWeight: '700', color: '#b9770e' },
  conflictHint: { fontSize: 12, color: '#8a6d3b', marginTop: 2, marginBottom: 6 },
  conflictRow: { marginTop: 6 },
  conflictLabel: { fontSize: 12, color: '#666', marginBottom: 4 },
  conflictChoices: { flexDirection: 'row', gap: 6 },
  conflictChoice: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f0d9a8',
    padding: 8,
  },
  conflictWhich: { fontSize: 11, color: '#666' },
  conflictValue: { fontSize: 14, color: '#333', marginTop: 2 },
  detailNextButton: {
    flex: 1,
    backgroundColor: '#e3ecfa',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  detailNextButtonText: { color: '#1d1f20', fontSize: 14, fontWeight: '700' },
  randomCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 32,
    maxHeight: '85%',
    flexShrink: 1,
  },
  randomHint: { fontSize: 12, color: '#666', marginTop: 4 },
  randomPickButton: { backgroundColor: '#d62f4b' },
  topButtons: { flexDirection: 'row', gap: 8, marginHorizontal: 10, marginTop: 8 },
  topButton: { flex: 1, marginHorizontal: 0, marginTop: 0 },
  toRateButton: { paddingVertical: 8, borderRadius: 8, alignItems: 'center', backgroundColor: '#1d1f20' },
  toRateButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pickAgainButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#e8edf5',
  },
  pickAgainButtonText: { color: '#1d1f20', fontWeight: '700', fontSize: 16 },
  filterToggleRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingBottom: 6 },
  filterToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 48,
  },
  filterToggleText: { color: '#333', fontSize: 14, fontWeight: '600' },
  filterSummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingBottom: 8 },
  filterSummaryText: { flex: 1, color: '#333', fontSize: 14 },
  randomIconButton: {
    minWidth: 48,
    minHeight: 48,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  randomIconText: { color: '#333' },
  filterToggleArrow: { color: '#666', fontSize: 14, marginLeft: 8 },
  filterPanel: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  artistListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  artistListImage: { width: 180, height: 120, borderRadius: 8, backgroundColor: '#eee' },
  artistListName: { fontSize: 22, fontWeight: '700', color: '#222' },
  favoriteStar: { fontSize: 22, color: '#b26a00', marginLeft: 8 },
  artistDetailCount: { fontSize: 14, color: '#666', marginTop: 4 },
  favoriteButton: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f5a623',
  },
  favoriteButtonActive: { backgroundColor: '#f5a623' },
  favoriteButtonText: { color: '#c47f00', fontWeight: '700', fontSize: 16 },
  favoriteButtonTextActive: { color: '#fff' },
  focusEditor: { width: '100%', aspectRatio: 1.5, borderRadius: 12, backgroundColor: '#eee', marginBottom: 6 },
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  zoomChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: '#eee' },
  zoomChipActive: { backgroundColor: '#1d1f20' },
  zoomText: { color: '#333', fontSize: 12 },
  zoomTextActive: { color: '#fff', fontSize: 12, fontWeight: '700' },
  linkHint: { fontSize: 11, color: '#666', marginBottom: 6 },
  focusButtons: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  focusButton: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: '#eee' },
  focusButtonText: { color: '#333', fontWeight: '600' },
  focusSave: { backgroundColor: '#1d1f20' },
  focusSaveText: { color: '#fff', fontWeight: '700' },
  moveText: { color: '#1a73e8', fontSize: 14, fontWeight: '600', marginTop: 8 },
  peopleSearchRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingBottom: 8 },
  heartButton: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e94560',
  },
  heartButtonActive: { backgroundColor: '#d62f4b' },
  heartButtonText: { color: '#e94560', fontWeight: '700', fontSize: 16 },
  heartButtonTextActive: { color: '#fff' },
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
  scoreLabel: { fontSize: 14, color: '#555', marginTop: 6 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonText: { fontSize: 22, color: '#1d1f20', fontWeight: '700' },
  countInput: {
    minWidth: 56,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    textAlign: 'center',
  },
  countOf: { fontSize: 14, color: '#666' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dateInput: {
    minWidth: 140,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  dateValue: { fontSize: 14, color: '#222' },
  datePlaceholder: { fontSize: 14, color: '#666' },
  dateButton: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: '#e3ecfa' },
  dateButtonText: { color: '#1d1f20', fontSize: 14, fontWeight: '600' },
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
    color: '#1d1f20',
    backgroundColor: '#e8edf5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  status: { fontSize: 12, color: '#666' },
  empty: { textAlign: 'center', marginTop: 40, color: '#666', paddingHorizontal: 24 },
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
    // Gets shorter, rather than going under the keyboard (KeyboardPad).
    flexShrink: 1,
  },
  detailImage: { width: '100%', height: 220, borderRadius: 12, backgroundColor: '#eee' },
  detailTitle: { fontSize: 22, fontWeight: '700', marginTop: 14 },
  detailAltTitle: { fontSize: 14, color: '#666', marginTop: 2, fontStyle: 'italic' },
  detailAuthor: { fontSize: 16, color: '#666', marginTop: 4 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  detailLabel: { fontSize: 14, color: '#666', marginTop: 12, marginBottom: 4 },
  detailValue: { fontSize: 14, color: '#333' },
  detailUrlButton: {
    marginTop: 14,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    padding: 10,
  },
  detailUrlText: { color: '#1d1f20', fontSize: 14 },
  // Site / MyAnimeList rows: the link takes the rest of the row.
  detailLinkWrap: { flex: 1, marginLeft: 16, alignItems: 'flex-end', justifyContent: 'center' },
  detailLink: { fontSize: 14, color: '#1d1f20', textDecorationLine: 'underline' },
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
    backgroundColor: '#1d1f20',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  detailCloseButtonText: { color: '#fff', fontWeight: '600' },
  readStatusBadge: { fontSize: 14 },
  readStatusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  readStatusChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f0f0f0',
  },
  readStatusChipActive: { backgroundColor: '#1d1f20' },
  superWantChip: { backgroundColor: '#b3261e' },
  superWantHint: { width: '100%', fontSize: 12, color: '#666' },
  readStatusText: { color: '#333', fontSize: 14 },
  readStatusTextActive: { color: '#fff', fontSize: 14, fontWeight: '600' },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tagChip: {
    backgroundColor: '#e8edf5',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tagChipText: { color: '#1d1f20', fontSize: 12 },
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
    backgroundColor: '#1d1f20',
    borderRadius: 8,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  tagAddButtonText: { color: '#fff', fontWeight: '600' },
  tagFilterBar: { marginBottom: 8 },
  // Genres can be a long list: they wrap under their label.
  detailGenres: { flex: 1, marginLeft: 16, textAlign: 'right' },
  tagFilterBarContent: { paddingHorizontal: 10, gap: 8 },
  groupLink: { fontSize: 14, fontWeight: '600', color: '#1a73e8' },
  groupLeave: { color: '#c0392b' },
  groupName: { fontSize: 16, fontWeight: '700', color: '#1d1f20' },
  groupNameBox: { flex: 1 },
  groupOpen: { fontSize: 16, fontWeight: '700', color: '#1a73e8' },
  groupRowName: { fontSize: 16, fontWeight: '700', color: '#222' },
  groupRowNameBox: { alignSelf: 'stretch' },
  groupPageRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 4, borderRadius: 8 },
  groupPageThumb: { width: 44, height: 60, borderRadius: 4, backgroundColor: '#eee' },
  groupPageText: { flex: 1 },
  groupPageItemTitle: { color: '#333', fontSize: 14, fontWeight: '600' },
  groupTool: { minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  groupActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, marginTop: 8 },
  groupHint: { fontSize: 14, color: '#666', marginTop: 8 },
  groupButtonOff: { opacity: 0.4 },
  groupSuggestion: {
    alignSelf: 'flex-start',
    marginTop: 10,
    backgroundColor: '#1d1f20',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  groupSuggestionText: { color: '#fff', fontSize: 14, fontWeight: '600' },
}));
