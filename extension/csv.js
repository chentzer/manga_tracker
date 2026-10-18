// The app's backup files (MangaTracker/<type>-backup.csv on Drive), read
// and written the same way as src/backup.js does.

// The app's columns, in its order (src/backup.js COLUMNS). A file that
// lacks some keeps its own order and gets the rest added at the end.
export const COLUMNS = [
  'media_type',
  'source_id',
  'title',
  'alt_title',
  'author',
  'score',
  'tags',
  'read_status',
  'source_url',
  'sync_status',
  'created_at',
  'mal_id',
  'mal_data',
  'start_date',
  'finish_date',
  'progress',
  'progress_volumes',
  'total',
  'total_volumes',
  'times_repeated',
  'repeating',
  'priority',
  'comments',
  'series_type',
  'genres',
  'is_adult',
  'mal_conflicts',
  'last_progress_url',
  'repeat_progress',
  'anilist_checked',
  'group_name',
  'group_order',
  'favorite',
  'updated_at',
  'deleted_at',
];

function escapeField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// Quoted fields may hold commas, quotes and line breaks.
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// { header, rows } — rows as objects of strings keyed by column.
export function parseCsv(text) {
  const raw = parseRows((text || '').trim());
  const header = raw.length ? raw[0] : [];
  const rows = raw.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = r[i] !== undefined ? r[i] : '';
    });
    return obj;
  });
  COLUMNS.forEach((c) => {
    if (!header.includes(c)) header.push(c);
  });
  return { header, rows };
}

export function toCsv(header, rows) {
  return [header.join(','), ...rows.map((row) => header.map((c) => escapeField(row[c])).join(','))].join('\n');
}

// Same as the app's normalizeTitle (src/malList.js): case, spaces and
// punctuation don't count.
export function normalizeTitle(title) {
  return (title || '').toLowerCase().replace(/[\s!-/:-@[-`{-~]+/g, '');
}
