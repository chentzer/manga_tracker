// The app's icons: Material Design Icons (@expo/vector-icons), one set
// everywhere instead of emoji, so they match each other and take the
// colour of the text they sit in (or `color`).
//
// <Icon name="heart" /> works on its own or inside a <Text>, where it
// sits in the line like a character and takes that text's colour.
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

// What each icon is for → its Material Design Icons name.
export const ICONS = {
  browse: 'compass-outline',
  browseOn: 'compass',
  library: 'bookshelf',
  browser: 'web',
  notepad: 'note-text-outline',
  notepadOn: 'note-text',
  settings: 'cog-outline',
  cloud: 'cloud-check-outline',
  localOnly: 'cloud-off-outline',
  check: 'check',
  chevronLeft: 'chevron-left',
  chevronRight: 'chevron-right',
  chevronUp: 'chevron-up',
  chevronDown: 'chevron-down',
  noCover: 'image-off-outline',
  lock: 'lock-outline',
  warning: 'alert-outline',
  close: 'close',
  reload: 'refresh',
  save: 'bookmark-plus-outline',
  books: 'book-open-page-variant-outline',
  videos: 'filmstrip',
  people: 'account-star-outline',
  star: 'star',
  starOutline: 'star-outline',
  edit: 'pencil-outline',
  clock: 'clock-outline',
  heart: 'heart',
  heartOutline: 'heart-outline',
  hidden: 'eye-off-outline',
  shown: 'eye-outline',
  random: 'dice-5-outline',
  move: 'arrow-all',
  link: 'link-variant',
  downloaded: 'download',
  language: 'translate',
  groups: 'folder-multiple-outline',
  filters: 'filter-variant',
  tag: 'tag-outline',
  folderMove: 'folder-move-outline',
  delete: 'delete-outline',
  checked: 'checkbox-marked',
  unchecked: 'checkbox-blank-outline',
  search: 'magnify',
  inbox: 'tray-arrow-down',
  code: 'code-tags',
  image: 'image-move',
  play: 'play',
  calendar: 'calendar-month-outline',
  upload: 'upload',
  person: 'account-outline',
  event: 'calendar-check-outline',
  // read statuses (one set for reading and watching: a play circle
  // beside the pause / check / cross circles)
  reading: 'play-circle-outline',
  read: 'check-circle-outline',
  on_hold: 'pause-circle-outline',
  dropped: 'close-circle-outline',
  want_to_read: 'bookmark-outline',
  // Super Want to Read/Watch: Want to with priority 'high' (EntryList.js).
  super_want: 'fire',
};

export default function Icon({ name, size = 18, color, style }) {
  return <MaterialCommunityIcons name={ICONS[name] || name} size={size} color={color} style={style} />;
}

// An icon then words, for labels kept as data ({ icon, label }).
export function IconText({ icon, children, size, color }) {
  if (!icon) return children ?? null;
  return (
    <>
      <Icon name={icon} size={size} color={color} />
      {children != null && children !== '' ? <>{' '}{children}</> : null}
    </>
  );
}
