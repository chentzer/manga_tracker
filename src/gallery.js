import { Album } from 'expo-media-library';

// Everything the app saves to the phone's gallery goes under
// Pictures/Manga Tracker/, with one subfolder per tab, e.g.
// Pictures/Manga Tracker/Manga/. Used by "Save Page Image", hold to save
// (MediaWebView.js) and screenshot filing (screenshots.js).
//
// SDK 57 note: the old MediaLibrary functions (saveToLibraryAsync,
// createAlbumAsync, …) now throw at runtime unless imported from
// 'expo-media-library/legacy'; this uses the new Album API instead.
export const GALLERY_ROOT = 'Manga Tracker';

// Album names on Android may only contain letters, digits, '_', spaces,
// hyphens and '/' (expo-media-library rejects anything else), so any
// other character in a tab label is replaced with a space.
function cleanAlbumPart(text) {
  return (text || '')
    .replace(/[^A-Za-z0-9_ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The gallery folder for a tab, e.g. 'Manga' -> "Manga Tracker/Manga";
// no label (the Library) -> "Manga Tracker".
export function galleryFolderFor(tabLabel) {
  const clean = cleanAlbumPart(tabLabel);
  return clean ? `${GALLERY_ROOT}/${clean}` : GALLERY_ROOT;
}

// Makes text safe as a file name: drops characters that are invalid in
// file names or would break the file:// URI it's passed as (/ \ : * ? "
// < > | # %), plus control characters; collapses spaces; caps length.
export function safeFileName(text, maxLength = 120) {
  const clean = String(text || '')
    .replace(/[\\/:*?"<>|#%\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return clean || 'image';
}

// The library works out the file's type (JPEG, PNG…) from its name with
// Android's MimeTypeMap.getFileExtensionFromUrl, which gives up — no type
// — when the name has anything but letters, digits and _ . - ( ) %: a
// space, Japanese text, "!", etc. With no type Android refuses to add it
// to the gallery. Percent-encoding just the name (space -> %20) passes
// that check; Android decodes it back for the real file and for the
// gallery item's name, so the photo still shows the normal readable name.
export function encodeFileUriName(fileUri) {
  const slash = fileUri.lastIndexOf('/');
  const name = fileUri.slice(slash + 1);
  const encoded = encodeURIComponent(name).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return fileUri.slice(0, slash + 1) + encoded;
}

// Copies a local file (file:///…) into the given gallery folder. The
// gallery item takes the file's own name, so name the file first. A
// name already taken in that folder gets a unique suffix automatically.
// Repeated calls with the same folder just add files to it.
export async function saveFileToGallery(fileUri, folder) {
  return Album.create(folder, [encodeFileUriName(fileUri)]);
}
