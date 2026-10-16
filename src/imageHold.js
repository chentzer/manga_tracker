// Hold a finger on a picture in a browsing tab (about half a second,
// without moving) to save it (MediaWebView.js asks first). Finds the
// picture under the finger even when the page covers it with a
// see-through layer (e.g. a full-screen viewer): <img>, a video's poster,
// or a CSS background picture. Small icons (under 40px on screen) are
// skipped. blob: pictures can't be downloaded from outside the page, so
// they're read here and sent as data instead. Pinching or scrolling
// cancels it. Reports { type: 'holdImage', url | dataUrl | error }.
// Safe to run twice on one page (it's injected before and after load).
export const IMAGE_HOLD_JS = `
  (function () {
    if (window.__mtImageHold) return;
    window.__mtImageHold = true;
    var timer = null, startX = 0, startY = 0;
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
    function hold() {
      timer = null;
      var src = pictureAt(startX, startY);
      if (!src) return;
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
    }
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    document.addEventListener('touchstart', function (e) {
      cancel();
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
    window.addEventListener('scroll', cancel, true);
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
