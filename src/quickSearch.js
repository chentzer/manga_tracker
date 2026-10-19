// A manga, manhwa or anime title highlighted in another app → "Search
// AniManga Tracker" (or shared here → Search): works out which tab it
// belongs to. App.js then opens it there.
//
// 1. The Library is looked at: an entry whose title or alt title is
//    exactly the text opens that entry; if every partial match (title, alt
//    title or author) is in one tab, that tab's search opens.
// 2. Otherwise you pick the tab, the ones with Library matches first.
// Pure (no React Native), so it can be checked with plain node.

// Lowercase, accents and punctuation dropped, spaces collapsed.
export function normalize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function fieldsOf(entry) {
  return [entry.title, entry.alt_title, ...String(entry.author || '').split(',')].map(normalize).filter(Boolean);
}

// What to do with a text, given the Library's entries and the tabs it can
// be searched in (in the order offered):
//   { kind: 'entry', entry }             — exactly one entry is named so
//   { kind: 'search', key, query }       — matches only in one tab
//   { kind: 'pick', query, order, counts } — you choose; order is the tabs
//     with the most matches first, counts the matches per tab.
export function classify(text, entries, tabs) {
  const query = String(text || '').replace(/\s+/g, ' ').trim();
  const wanted = normalize(query);
  const counts = {};
  const exact = [];
  if (wanted.length >= 2) {
    for (const entry of entries) {
      if (!tabs.includes(entry.media_type)) continue;
      const fields = fieldsOf(entry);
      if ([entry.title, entry.alt_title].map(normalize).includes(wanted)) exact.push(entry);
      // Partial: the text is part of a field, or (a long highlighted
      // title with extra words) a field is part of the text.
      const partial = fields.some(
        (f) => (wanted.length >= 3 && f.includes(wanted)) || (f.length >= 6 && wanted.includes(f))
      );
      if (partial) counts[entry.media_type] = (counts[entry.media_type] || 0) + 1;
    }
  }
  // A title that's exactly one entry's: that entry. (The same title as
  // both a manga and an anime falls through to the picker.)
  if (exact.length === 1) return { kind: 'entry', entry: exact[0] };
  const found = Object.keys(counts);
  if (found.length === 1) return { kind: 'search', key: found[0], query };
  const order = [...tabs].sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  return { kind: 'pick', query, order, counts };
}
