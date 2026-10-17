import { getArtistFavorites, setArtistFavorite, getSetting, setSetting } from './db';

// The Library's Artists view (EntryList.js): with one type chosen (Manga,
// Manhwa, Anime), one row per artist credited on that type's saved
// titles, with a cover picture and a favourite flag. scope is the media
// type's key, so the same name in Manga and Anime is two artists.

// The names in an entry's author field ("A, B" -> ['A', 'B']).
export function parseAuthors(authorField) {
  return (authorField || '')
    .split(',')
    .map((n) => n.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

// Favourites live in the artist_favorites table (db.js) and are backed up
// to Drive as favorite-artists.csv (backup.js).
export function loadFavoriteArtists(scope) {
  return new Set(getArtistFavorites(scope).filter((row) => row.favorite).map((row) => row.name));
}

export function setFavoriteArtist(name, favorite, scope) {
  setArtistFavorite(scope, name, favorite);
}

// Where each artist's picture is centred (FocusImage.js), as moved by hand
// in their details: { "<scope>|<name>": { cover, x, y, zoom } }. Kept on
// this phone only. A position belongs to one picture — if the artist's
// picture changes to another cover, it's shown centred again.
const FOCUS_KEY = 'pictureFocus';

export function loadPictureFocus() {
  try {
    return JSON.parse(getSetting(FOCUS_KEY, '{}')) || {};
  } catch (e) {
    return {};
  }
}

export function focusFor(all, scope, name, cover) {
  const saved = all[`${scope}|${name}`];
  return saved && saved.cover === cover ? { x: saved.x, y: saved.y, zoom: saved.zoom || 1 } : null;
}

// focus null = back to centred.
export function savePictureFocus(scope, name, cover, focus) {
  const all = loadPictureFocus();
  const key = `${scope}|${name}`;
  if (focus) all[key] = { cover, x: focus.x, y: focus.y, zoom: focus.zoom || 1 };
  else delete all[key];
  setSetting(FOCUS_KEY, JSON.stringify(all));
  return all;
}

// Returns [{ name, count, cover }] for every name credited on `entries`,
// favourites first, then A–Z. cover is a local image path or null.
//
// The cover is a random cover of theirs, chosen only from titles where
// they're the ONLY credited artist; titles with others are used only
// while they have no solo title with a cover. `previousPicks`
// ({ [name]: path }, updated in place) keeps each artist's picture
// steady between reloads: a previous pick is kept while it's still one
// of the allowed covers, so a picture taken from a shared title is
// replaced as soon as a solo one exists.
export function buildArtistList(entries, favorites, previousPicks = {}, random = Math.random) {
  const byName = new Map();
  entries.forEach((entry) => {
    const names = parseAuthors(entry.author);
    names.forEach((name) => {
      if (!byName.has(name)) byName.set(name, { name, count: 0, solo: [], shared: [] });
      const artist = byName.get(name);
      artist.count += 1;
      if (entry.local_image_path) {
        (names.length === 1 ? artist.solo : artist.shared).push(entry.local_image_path);
      }
    });
  });

  const list = Array.from(byName.values()).map(({ name, count, solo, shared }) => {
    const pool = solo.length > 0 ? solo : shared;
    let cover = null;
    if (pool.length > 0) {
      const previous = previousPicks[name];
      cover = previous && pool.includes(previous) ? previous : pool[Math.floor(random() * pool.length)];
    }
    if (cover) previousPicks[name] = cover;
    else delete previousPicks[name];
    return { name, count, cover };
  });

  list.sort((a, b) => {
    const favA = favorites.has(a.name) ? 0 : 1;
    const favB = favorites.has(b.name) ? 0 : 1;
    return favA - favB || a.name.localeCompare(b.name);
  });
  return list;
}
