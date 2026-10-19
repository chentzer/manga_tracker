import * as FileSystem from 'expo-file-system/legacy';
// SDK 57: saveToLibraryAsync only works from the legacy entry point.
import * as MediaLibrary from 'expo-media-library/legacy';
import { suppressNextRelock } from './relockGuard';
import { saveFileToGallery } from './gallery';

// Hold a finger on a picture in a browsing tab (about half a second,
// without moving) to save it (MediaWebView.js / BrowserTab.js ask first). Finds the
// picture under the finger even when the page covers it with a
// see-through layer (e.g. a full-screen viewer): <img>, a video's poster,
// or a CSS background picture. Small icons (under 40px on screen) are
// skipped. blob: pictures can't be downloaded from outside the page, so
// they're read here and sent as data instead. Moving the finger
// (scrolling, pinching) cancels it; the page shifting on its own (e.g. a
// reader's pictures loading above) doesn't. Android's own long-press
// (contextmenu) also triggers it, since that can cancel the touch before
// the half second is up. Reports { type: 'holdImage', url | dataUrl | error }.
// Safe to run twice on one page (it's injected before and after load).
export const IMAGE_HOLD_JS = `
  (function () {
    if (window.__mtImageHold) return;
    window.__mtImageHold = true;
    var timer = null, startX = 0, startY = 0, held = false;
    function send(msg) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
    }
    function absolute(url) {
      try { return new URL(url, location.href).href; } catch (e) { return null; }
    }
    function pictureAt(x, y) {
      var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (!el || el === document.documentElement || el === document.body) continue;
        var box = el.getBoundingClientRect();
        if (box.width < 40 || box.height < 40) continue;
        if (el.tagName === 'IMG') {
          var src = el.currentSrc || el.src;
          if (!src || (/^data:/i.test(src) && el.naturalWidth < 50)) {
            src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || src;
          }
          if (src) return src;
        }
        if (el.tagName === 'VIDEO' && el.poster) return el.poster;
        var bg = window.getComputedStyle(el).backgroundImage;
        var m = bg && /url\\(["']?([^"')]+)["']?\\)/.exec(bg);
        if (m) return m[1];
      }
      return null;
    }
    // Sends the picture at startX/startY, if any; true if there was one.
    function hold() {
      timer = null;
      var src = pictureAt(startX, startY);
      if (!src) return false;
      held = true;
      if (/^blob:/i.test(src)) {
        fetch(src).then(function (r) { return r.blob(); }).then(function (b) {
          var reader = new FileReader();
          reader.onload = function () { send({ type: 'holdImage', dataUrl: reader.result }); };
          reader.readAsDataURL(b);
        }).catch(function () { send({ type: 'holdImage', error: 'blob' }); });
      } else if (/^data:/i.test(src)) {
        send({ type: 'holdImage', dataUrl: src });
      } else {
        var url = absolute(src);
        if (url) send({ type: 'holdImage', url: url });
      }
      return true;
    }
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    document.addEventListener('touchstart', function (e) {
      cancel();
      held = false;
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      timer = setTimeout(hold, 550);
    }, true);
    document.addEventListener('touchmove', function (e) {
      if (!timer) return;
      var t = e.touches[0];
      if (e.touches.length !== 1 || Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) cancel();
    }, true);
    document.addEventListener('touchend', cancel, true);
    document.addEventListener('touchcancel', cancel, true);
    document.addEventListener('contextmenu', function (e) {
      if (held) { e.preventDefault(); return; }
      cancel();
      if (e.clientX || e.clientY) { startX = e.clientX; startY = e.clientY; }
      if (hold()) e.preventDefault();
    }, true);
  })();
  true;
`;

// File extension for a downloaded picture: from its type, else from the
// address, else jpg. null if the type says it isn't a picture Android's
// gallery can hold (e.g. a web page or an SVG drawing).
export function pictureExtension(mimeType, url) {
  const type = (mimeType || '').toLowerCase().split(';')[0].trim();
  const byType = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/avif': 'avif',
  };
  if (byType[type]) return byType[type];
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return null;
  const m = /\.(jpe?g|png|webp|gif|bmp|heic|avif)(?:[?#]|$)/i.exec(url || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// "20261014_220215" for the file name.
export function timeStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Saves a held picture ({ url } or { dataUrl } from IMAGE_HOLD_JS) to the
// gallery folder `folder`, named "<label>_<time>". Returns the file name;
// throws with a reason to show if it can't be saved, or 'denied' when
// photo access isn't allowed.
export async function saveHeldPicture({ url, dataUrl }, pageUrl, folder, label) {
  let tempPath = null;
  let finalPath = null;
  try {
    // The permission dialog briefly counts as leaving the app (AppLock).
    suppressNextRelock();
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') throw new Error('denied');
    tempPath = `${FileSystem.cacheDirectory}held-picture-${Date.now()}`;
    let mimeType = null;
    if (dataUrl) {
      const m = /^data:([^;,]*)(;[^,]*)?,/.exec(dataUrl);
      if (!m || !/;base64/i.test(m[2] || '')) throw new Error("this picture's format can't be saved");
      mimeType = m[1];
      await FileSystem.writeAsStringAsync(tempPath, dataUrl.slice(m[0].length), {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      // The page is sent as Referer, since many sites refuse pictures
      // requested without it.
      const result = await FileSystem.downloadAsync(url, tempPath, {
        headers: pageUrl ? { Referer: pageUrl } : undefined,
      });
      if (result.status < 200 || result.status >= 300) throw new Error(`the site returned HTTP ${result.status}`);
      const headers = result.headers || {};
      mimeType = result.mimeType || headers['Content-Type'] || headers['content-type'] || null;
    }
    const ext = pictureExtension(mimeType, url);
    if (!ext) throw new Error("that isn't a picture the gallery can hold");
    const base = `${label}_${timeStamp()}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
    finalPath = `${FileSystem.cacheDirectory}${base}.${ext}`;
    await FileSystem.moveAsync({ from: tempPath, to: finalPath });
    tempPath = null;
    await saveFileToGallery(finalPath, folder);
    return `${base}.${ext}`;
  } finally {
    if (tempPath) FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
    if (finalPath) FileSystem.deleteAsync(finalPath, { idempotent: true }).catch(() => {});
  }
}
