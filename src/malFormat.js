// MyAnimeList's list format, and how it maps onto an entry's columns.
// Pure data and functions (no imports), shared by db.js (migrations) and
// malList.js (export/import).
//
// Entry columns that mirror MAL's own list fields:
//   score            1-10, or null (MAL: 0)
//   read_status      'reading' | 'read' | 'on_hold' | 'dropped' | 'want_to_read'
//   start_date       'YYYY-MM-DD' (MAL allows 00 for an unknown month/day), or null
//   finish_date      same
//   progress         episodes watched / chapters read
//   progress_volumes volumes read (manga only)
//   total            the series' episode / chapter count (0 = unknown)
//   total_volumes    the series' volume count (manga only)
//   times_repeated   times rewatched / reread
//   repeating        1 while rewatching / rereading, else 0
//   priority         'low' | 'medium' | 'high'
//   comments         free text
//   series_type      'TV', 'Movie', 'OVA', ... (anime only, from MAL)
// MAL's remaining fields (my_id, storage, ...) stay in mal_data as JSON.

export const SCORE_LABELS = {
  10: 'Masterpiece',
  9: 'Great',
  8: 'Very Good',
  7: 'Good',
  6: 'Fine',
  5: 'Average',
  4: 'Bad',
  3: 'Very Bad',
  2: 'Horrible',
  1: 'Appalling',
};

export const PRIORITIES = ['low', 'medium', 'high'];

const NO_DATE = '0000-00-00';

// Per-type differences in MAL's format. `fields` are in the order MAL
// writes them; `cdata` ones are wrapped in <![CDATA[...]]>.
export const FORMATS = {
  anime: {
    item: 'anime',
    exportType: 1,
    idField: 'series_animedb_id',
    titleField: 'series_title',
    progressField: 'my_watched_episodes',
    totalField: 'series_episodes',
    volumesField: null,
    totalVolumesField: null,
    timesField: 'my_times_watched',
    repeatingField: 'my_rewatching',
    repeatingValues: ['0', '1'],
    priorityCase: (p) => p.toUpperCase(),
    statuses: {
      reading: 'Watching',
      read: 'Completed',
      on_hold: 'On-Hold',
      dropped: 'Dropped',
      want_to_read: 'Plan to Watch',
    },
    totals: {
      reading: 'user_total_watching',
      read: 'user_total_completed',
      on_hold: 'user_total_onhold',
      dropped: 'user_total_dropped',
      want_to_read: 'user_total_plantowatch',
    },
    totalAll: 'user_total_anime',
    fields: [
      ['series_animedb_id', ''],
      ['series_title', '', 'cdata'],
      ['series_type', ''],
      ['series_episodes', '0'],
      ['my_id', '0'],
      ['my_watched_episodes', '0'],
      ['my_start_date', NO_DATE],
      ['my_finish_date', NO_DATE],
      ['my_rated', ''],
      ['my_score', '0'],
      ['my_storage', ''],
      ['my_storage_value', '0.00'],
      ['my_status', ''],
      ['my_comments', '', 'cdata'],
      ['my_times_watched', '0'],
      ['my_rewatch_value', ''],
      ['my_priority', 'LOW'],
      ['my_tags', '', 'cdata'],
      ['my_rewatching', '0'],
      ['my_rewatching_ep', '0'],
      ['my_discuss', '1'],
      ['my_sns', 'default'],
      ['update_on_import', '0'],
    ],
  },
  manga: {
    item: 'manga',
    exportType: 2,
    idField: 'manga_mangadb_id',
    titleField: 'manga_title',
    progressField: 'my_read_chapters',
    totalField: 'manga_chapters',
    volumesField: 'my_read_volumes',
    totalVolumesField: 'manga_volumes',
    timesField: 'my_times_read',
    repeatingField: 'my_rereading',
    repeatingValues: ['NO', 'YES'],
    priorityCase: (p) => p.charAt(0).toUpperCase() + p.slice(1),
    statuses: {
      reading: 'Reading',
      read: 'Completed',
      on_hold: 'On-Hold',
      dropped: 'Dropped',
      want_to_read: 'Plan to Read',
    },
    totals: {
      reading: 'user_total_reading',
      read: 'user_total_completed',
      on_hold: 'user_total_onhold',
      dropped: 'user_total_dropped',
      want_to_read: 'user_total_plantoread',
    },
    totalAll: 'user_total_manga',
    fields: [
      ['manga_mangadb_id', ''],
      ['manga_title', '', 'cdata'],
      ['manga_volumes', '0'],
      ['manga_chapters', '0'],
      ['my_id', '0'],
      ['my_read_volumes', '0'],
      ['my_read_chapters', '0'],
      ['my_start_date', NO_DATE],
      ['my_finish_date', NO_DATE],
      ['my_scanalation_group', '', 'cdata'],
      ['my_score', '0'],
      ['my_storage', ''],
      ['my_retail_volumes', '0'],
      ['my_status', ''],
      ['my_comments', '', 'cdata'],
      ['my_times_read', '0'],
      ['my_tags', '', 'cdata'],
      ['my_priority', 'Low'],
      ['my_reread_value', ''],
      ['my_rereading', 'NO'],
      ['my_discuss', 'YES'],
      ['my_sns', 'default'],
      ['update_on_import', '0'],
    ],
  },
};

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 'YYYY-MM-DD' (00 allowed for month/day), or null for empty/unknown.
export function normalizeDate(value) {
  const v = (value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v === NO_DATE) return null;
  return v;
}

export function statusFromMal(mediaType, malStatus) {
  const wanted = (malStatus || '').toLowerCase();
  const match = Object.entries(FORMATS[mediaType].statuses).find(([, label]) => label.toLowerCase() === wanted);
  return match ? match[0] : null;
}

// The entry columns an item from a MAL export fills in.
export function columnsFromMalItem(mediaType, item) {
  const f = FORMATS[mediaType];
  const priority = (item.my_priority || '').toLowerCase();
  return {
    score: toInt(item.my_score) || null,
    read_status: statusFromMal(mediaType, item.my_status),
    start_date: normalizeDate(item.my_start_date),
    finish_date: normalizeDate(item.my_finish_date),
    progress: toInt(item[f.progressField]),
    progress_volumes: f.volumesField ? toInt(item[f.volumesField]) : 0,
    total: toInt(item[f.totalField]),
    total_volumes: f.totalVolumesField ? toInt(item[f.totalVolumesField]) : 0,
    times_repeated: toInt(item[f.timesField]),
    repeating: item[f.repeatingField] === f.repeatingValues[1] ? 1 : 0,
    priority: PRIORITIES.includes(priority) ? priority : 'low',
    comments: item.my_comments || null,
    series_type: mediaType === 'anime' ? item.series_type || null : null,
    tags: item.my_tags || null,
  };
}

// The MAL fields for one entry: its mal_data (whatever came in from an
// import), overridden by the entry's own columns.
export function malItemFromEntry(mediaType, entry) {
  const f = FORMATS[mediaType];
  let malData = {};
  try {
    malData = entry.mal_data ? JSON.parse(entry.mal_data) : {};
  } catch (e) {
    malData = {};
  }
  const status = f.statuses[entry.read_status] ? entry.read_status : 'want_to_read';
  const values = {
    ...malData,
    [f.idField]: entry.mal_id,
    [f.titleField]: malData[f.titleField] || entry.title || entry.alt_title || '',
    [f.progressField]: entry.progress || 0,
    [f.totalField]: entry.total || 0,
    [f.timesField]: entry.times_repeated || 0,
    [f.repeatingField]: f.repeatingValues[entry.repeating ? 1 : 0],
    my_start_date: entry.start_date || NO_DATE,
    my_finish_date: entry.finish_date || NO_DATE,
    my_score: entry.score || 0,
    // MAL needs a status; an unset one goes in as "plan to".
    my_status: f.statuses[status],
    my_priority: f.priorityCase(PRIORITIES.includes(entry.priority) ? entry.priority : 'low'),
    my_comments: entry.comments || '',
    my_tags: entry.tags || '',
  };
  if (f.volumesField) values[f.volumesField] = entry.progress_volumes || 0;
  if (f.totalVolumesField) values[f.totalVolumesField] = entry.total_volumes || 0;
  if (mediaType === 'anime') values.series_type = entry.series_type || malData.series_type || '';
  return values;
}
