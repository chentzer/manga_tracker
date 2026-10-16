// Groups (types with `groupField` in mediaTypes.js): books saved one by
// one (volumes, parts, sequels) put together under a name you choose,
// listed in the detail sheet of every book in the group (EntryList.js).
// Stored on each entry as group_name and group_order (its place).

// Group names match whatever their case or surrounding spaces.
export function groupKey(text) {
  return String(text || '').trim().toLowerCase();
}

// Order within a group: the order you arranged, then oldest first.
export function groupOrder(a, b) {
  const oa = a.group_order ?? Infinity;
  const ob = b.group_order ?? Infinity;
  if (oa !== ob) return oa - ob;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

// A guess at a title's group and part, for the one-tap suggestion:
// bracketed groups at either end ("[Circle]", "[English]", "(Vol. 2)")
// are dropped, then a trailing number is the part — with an optional
// "Vol.", "Part", "Ch.", "#"... in front of it, or a Roman numeral.
//   "[Circle] Summer Days 4 [English]" -> { name: "Summer Days", part: "4" }
//   "Summer Days Vol. 2"               -> { name: "Summer Days", part: "2" }
// null when there's no trailing number.
export function guessGroup(title) {
  if (!title) return null;
  let t = String(title).trim();
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/^\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*/, '').replace(/\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*$/, '');
    if (t === before) break;
  }
  const match = t.match(
    /^(.*?\S)[\s:~\-–,]+(?:(?:vol(?:ume)?|part|pt|ch(?:apter)?|ep(?:isode)?|no|#)\.?\s*)?(\d+(?:\.\d+)?|[IVX]{1,4})$/i
  );
  // A trailing year ("Summer Days 2024") isn't a part.
  if (!match || /^(19|20)\d{2}$/.test(match[2])) return null;
  const name = match[1].replace(/[\s:~\-–,]+$/, '').trim();
  // Nothing left but a "Vol." / "Part" word: no group name to suggest.
  if (!name || /^(vol(ume)?|part|pt|ch(apter)?|ep(isode)?|no)\.?$/i.test(name)) return null;
  return { name, part: match[2] };
}
