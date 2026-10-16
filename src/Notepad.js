import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  Modal,
  Alert,
  Linking,
  StyleSheet,
} from 'react-native';
import {
  INBOX_TITLE,
  addNote,
  getNotes,
  deleteNote,
  moveNote,
  getNotebooks,
  getNoteCounts,
  createNotebook,
  deleteNotebook,
} from './db';
import { syncNotepadToDrive, onNotepadSynced } from './notepadSync';

// Splits text into plain and link parts so links inside a note (or a
// note that's just a link) are tappable. Trailing punctuation is left
// out of the link, so "see https://example.com." doesn't open "example.com.".
const URL_SPLIT = /(https?:\/\/[^\s]*[^\s.,!?;:)\]'"])/gi;

function LinkifiedText({ content, style, linkStyle }) {
  const parts = content.split(URL_SPLIT);
  return (
    <Text style={style} selectable>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={linkStyle} onPress={() => Linking.openURL(part)}>
            {part}
          </Text>
        ) : (
          part
        )
      )}
    </Text>
  );
}

// Full-screen notepad (the 📝 button on the Library). Notes are lists of
// items (text or links). The Inbox is built in and is where everything
// shared from other apps lands — no unlock needed, so no picking a
// destination at share time; items get moved into a named note
// ("Grocery list"…) from here.
//
// Note NAMES are shared across devices (created/deleted everywhere);
// CONTENTS are only ever this device's own. Deleting an item removes it
// from Drive too; deleting a whole note keeps it in Drive. See
// notepadSync.js.
//
//
// refreshKey: bumped by App.js when something is shared in, so an
// already open notepad reloads.
export default function Notepad({ visible, onClose, refreshKey }) {
  const [notebooks, setNotebooks] = useState([]);
  const [counts, setCounts] = useState({ inbox: 0 });
  const [selectedId, setSelectedId] = useState(null); // null = Inbox
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  // In-sheet overlays rather than nested Modals (nested Modals are
  // unreliable on Android), and rather than Alert for the move picker
  // (Android's Alert can't show more than three buttons).
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [movingItem, setMovingItem] = useState(null);

  const reload = useCallback(() => {
    const books = getNotebooks();
    // The selected note may have just been deleted.
    const stillThere = selectedId == null || books.some((b) => b.id === selectedId);
    const current = stillThere ? selectedId : null;
    if (!stillThere) setSelectedId(null);
    setNotebooks(books);
    setCounts(getNoteCounts());
    setItems(getNotes(current));
  }, [selectedId]);

  useEffect(() => {
    if (visible) reload();
  }, [visible, refreshKey, reload]);

  // While open: pick up notes created/deleted on other devices — sync
  // once on opening, and reload whenever any sync changes the list.
  // Goes through a ref so switching tabs (which changes `reload`)
  // doesn't re-run this and hit Drive on every tap.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!visible) return undefined;
    const unsubscribe = onNotepadSynced(() => reloadRef.current());
    syncNotepadToDrive();
    return unsubscribe;
  }, [visible]);

  const changed = () => {
    reload();
    syncNotepadToDrive();
  };

  const selectedTitle =
    selectedId == null ? INBOX_TITLE : notebooks.find((b) => b.id === selectedId)?.title || INBOX_TITLE;

  const handleAdd = () => {
    const value = input.trim();
    if (!value) return;
    addNote(value, selectedId);
    setInput('');
    changed();
  };

  const handleDeleteItem = (item) => {
    Alert.alert('Delete this item?', 'It’s also removed from Drive.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteNote(item.id);
          changed();
        },
      },
    ]);
  };

  const handleMoveTo = (notebookId) => {
    moveNote(movingItem.id, notebookId);
    setMovingItem(null);
    changed();
  };

  const handleCreateNote = () => {
    try {
      const id = createNotebook(newNoteTitle);
      setNewNoteOpen(false);
      setNewNoteTitle('');
      setSelectedId(id);
      // Shares the new name so it appears (empty) on other devices.
      syncNotepadToDrive();
    } catch (err) {
      Alert.alert('Can’t create note', err.message);
    }
  };

  const handleDeleteNotebook = () => {
    const n = counts[selectedId] || 0;
    const buttons = [{ text: 'Cancel', style: 'cancel' }];
    if (n > 0) {
      buttons.push({
        text: `Move ${n} to ${INBOX_TITLE}`,
        onPress: () => {
          deleteNotebook(selectedId, true);
          setSelectedId(null);
          changed();
        },
      });
    }
    buttons.push({
      text: n > 0 ? 'Delete all' : 'Delete',
      style: 'destructive',
      onPress: () => {
        deleteNotebook(selectedId, false);
        setSelectedId(null);
        changed();
      },
    });
    const everywhere =
      'This note is also removed from your other devices when they next sync (their items in it move to their Inbox). Drive keeps this note and everything in it.';
    Alert.alert(
      `Delete "${selectedTitle}"?`,
      n > 0
        ? `It has ${n} item${n === 1 ? '' : 's'} here. Keep them in ${INBOX_TITLE}, or delete them too?\n\n${everywhere}`
        : everywhere,
      buttons
    );
  };

  // Back button closes an open overlay first, then the notepad.
  const handleRequestClose = () => {
    if (movingItem) setMovingItem(null);
    else if (newNoteOpen) setNewNoteOpen(false);
    else onClose();
  };

  const tabs = [{ id: null, title: INBOX_TITLE, count: counts.inbox || 0 }].concat(
    notebooks.map((b) => ({ id: b.id, title: b.title, count: counts[b.id] || 0 }))
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleRequestClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Notepad</Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>

        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
            {tabs.map((t) => {
              const active = t.id === selectedId;
              return (
                <TouchableOpacity
                  key={String(t.id)}
                  style={[styles.tab, active && styles.tabActive]}
                  onPress={() => setSelectedId(t.id)}
                >
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>
                    {t.id == null ? '📥 ' : ''}
                    {t.title}
                    {t.count > 0 ? ` · ${t.count}` : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity style={[styles.tab, styles.tabNew]} onPress={() => setNewNoteOpen(true)}>
              <Text style={styles.tabNewText}>＋ New</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>

        <View style={styles.noteHeader}>
          <Text style={styles.noteTitle} numberOfLines={1}>
            {selectedTitle}
          </Text>
          {selectedId != null ? (
            <TouchableOpacity onPress={handleDeleteNotebook} hitSlop={8}>
              <Text style={styles.deleteNoteText}>Delete note</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder={`Add to ${selectedTitle}… (text or a link)`}
            placeholderTextColor="#999"
            value={input}
            onChangeText={setInput}
            multiline
          />
          <TouchableOpacity style={styles.addButton} onPress={handleAdd}>
            <Text style={styles.addButtonText}>Add</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.empty}>
              {selectedId == null
                ? 'Nothing here yet. Add text or a link above, or select text or a link in another app and tap Share › Manga Tracker — it lands here without unlocking. Then use Move to file it into a note.'
                : 'This note is empty. Add items above, or move them here from the Inbox.'}
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.item}>
              <View style={styles.itemBody}>
                <LinkifiedText content={item.content} style={styles.itemText} linkStyle={styles.link} />
                <Text style={styles.itemDate}>{item.created_at}</Text>
              </View>
              <TouchableOpacity onPress={() => setMovingItem(item)} hitSlop={8} style={styles.itemAction}>
                <Text style={styles.moveText}>Move</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDeleteItem(item)} hitSlop={8} style={styles.itemAction}>
                <Text style={styles.deleteText}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
        />

        {newNoteOpen ? (
          <View style={styles.overlay}>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>New note</Text>
              <Text style={styles.sheetPreview}>Also appears, empty, on your other devices.</Text>
              <TextInput
                style={styles.sheetInput}
                placeholder="e.g. Grocery list"
                placeholderTextColor="#999"
                value={newNoteTitle}
                onChangeText={setNewNoteTitle}
                onSubmitEditing={handleCreateNote}
                autoFocus
                returnKeyType="done"
              />
              <View style={styles.sheetButtons}>
                <TouchableOpacity
                  onPress={() => {
                    setNewNoteOpen(false);
                    setNewNoteTitle('');
                  }}
                  style={styles.sheetButton}
                >
                  <Text style={styles.sheetCancel}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleCreateNote} style={styles.sheetButton}>
                  <Text style={styles.sheetConfirm}>Create</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ) : null}

        {movingItem ? (
          <View style={styles.overlay}>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>Move to…</Text>
              <Text style={styles.sheetPreview} numberOfLines={2}>
                {movingItem.content}
              </Text>
              <ScrollView style={styles.moveList}>
                {tabs
                  .filter((t) => t.id !== selectedId)
                  .map((t) => (
                    <TouchableOpacity key={String(t.id)} style={styles.moveRow} onPress={() => handleMoveTo(t.id)}>
                      <Text style={styles.moveRowText}>
                        {t.id == null ? '📥 ' : ''}
                        {t.title}
                      </Text>
                    </TouchableOpacity>
                  ))}
                {notebooks.length === 0 ? (
                  <Text style={styles.moveHint}>No notes yet — create one with ＋ New first.</Text>
                ) : null}
              </ScrollView>
              <TouchableOpacity onPress={() => setMovingItem(null)} style={styles.sheetButton}>
                <Text style={styles.sheetCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#1a1a2e',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  closeText: { color: '#e94560', fontSize: 15, fontWeight: '600' },
  tabs: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 18,
    backgroundColor: '#eef0f5',
  },
  tabActive: { backgroundColor: '#16213e' },
  tabText: { color: '#333', fontSize: 14 },
  tabTextActive: { color: '#fff', fontWeight: '600' },
  tabNew: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#16213e' },
  tabNewText: { color: '#16213e', fontSize: 14, fontWeight: '600' },
  noteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 12,
  },
  noteTitle: { flex: 1, fontSize: 19, fontWeight: '700', color: '#222' },
  deleteNoteText: { color: '#c0392b', fontSize: 14 },
  inputRow: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 14, gap: 10, alignItems: 'flex-end' },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: '#222',
    textAlignVertical: 'top',
  },
  addButton: { backgroundColor: '#16213e', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12 },
  addButtonText: { color: '#fff', fontWeight: '600' },
  // Items are separate soft cards with generous padding and line
  // height, rather than tight rows divided by hairlines.
  list: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 32 },
  empty: { color: '#888', textAlign: 'center', marginTop: 40, paddingHorizontal: 24, fontSize: 15, lineHeight: 23 },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    paddingVertical: 16,
    paddingLeft: 16,
    paddingRight: 8,
    marginBottom: 12,
    borderRadius: 12,
    backgroundColor: '#f6f7fb',
  },
  itemBody: { flex: 1, paddingRight: 4 },
  itemText: { fontSize: 16, lineHeight: 24, color: '#222' },
  link: { color: '#1a73e8', textDecorationLine: 'underline' },
  itemDate: { fontSize: 12, color: '#999', marginTop: 10 },
  itemAction: { paddingHorizontal: 10, paddingVertical: 4, minWidth: 40, alignItems: 'center' },
  moveText: { color: '#16213e', fontSize: 14, fontWeight: '600' },
  deleteText: { color: '#c0392b', fontSize: 17, fontWeight: '600' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: { backgroundColor: '#fff', borderRadius: 12, padding: 20, maxHeight: '80%' },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: '#222', marginBottom: 12 },
  sheetPreview: { fontSize: 13, color: '#666', marginBottom: 12 },
  sheetInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 15,
    color: '#222',
  },
  sheetButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  sheetButton: { paddingHorizontal: 12, paddingVertical: 10, alignSelf: 'flex-end' },
  sheetCancel: { color: '#666', fontSize: 15 },
  sheetConfirm: { color: '#16213e', fontSize: 15, fontWeight: '700' },
  moveList: { flexGrow: 0 },
  moveRow: { paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  moveRowText: { fontSize: 16, color: '#222' },
  moveHint: { color: '#888', fontSize: 13, paddingVertical: 12 },
});
