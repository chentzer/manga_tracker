// The same touch controls on any <video>, in every browsing tab
// (MediaWebView.js, BrowserTab.js). Double-tap the left half to rewind,
// right half to fast-forward — YouTube-style, since most players' own
// controls aren't designed for touch-friendly seeking. Harmless on a page
// with no <video>, since there'd just be nothing for a tap to land on. A
// video inside another site's frame is out of its reach.
//
// The site's player must not see a double tap as well: it would show
// its controls (or run its own double-tap seek) on top of ours, as
// some players do. So a tap over a <video> is held back, listening on
// window in the capturing phase (this runs before the page's own
// scripts, so it's first): pointerdown and touchstart go through, but
// the tap's ending (pointerup, touchend and the mouse/click events the
// browser makes from it) waits up to DOUBLE_TAP_MS. A second tap in
// that time seeks: the first tap is cancelled for the player
// (pointercancel / touchcancel) and the second one never reaches it.
// Otherwise the held events are sent on to where they were going,
// unchanged, so a single tap still shows the controls, just 300 ms
// later. A drag (the seek bar, scrolling), a long press, a second
// finger and taps on a link (video previews on list pages) aren't held.
//
// The player's own "dblclick" handler (commonly for toggling
// fullscreen) is blocked too,
// for the same "landed over a video" area.
//
// A clearly sideways swipe anywhere on the video seeks as well: right
// skips ahead, left rewinds (not from the player's seek bar or sliders,
// which it would fight with). Either way a seek starts seek mode for
// SEEK_MODE_MS: each tap anywhere on the video seeks again the same way,
// kept from the player, and a label adds it up ("+10s", "+20s"…).
//
// A single tap is for the player's controls. Most players show and hide
// them on a tap by themselves. Clappr's pauses on a tap and only
// shows them on a mouse hover, which a phone doesn't have, so a tap on its
// video is kept from it and shows or hides them here. Any other player
// that pauses a playing video on a tap is set playing again and asked for
// its controls, as a mouse hover would.
export const VIDEO_GESTURES_JS = `
    (function() {
      if (window.__mangaTrackerSeekInstalled) return;
      window.__mangaTrackerSeekInstalled = true;

      var DOUBLE_TAP_MS = 300;
      var SEEK_SECONDS = 5;
      var replayed = new WeakSet(); // events this script sent itself
      var tap = null; // the tap being held: { x, y, start, target, pointerId, pointerType, touch, held, ended }
      var timer = null; // after a held tap ends: sends it on unless a second tap comes
      var swallowing = false; // the second tap of a double tap: hidden from the page
      var SWIPE_MIN_PX = 60;
      var SEEK_MODE_MS = 1000;
      var seekMode = null; // after a seek: { dir, total, timer }
      var label = null; // the "+10s" on the video
      var swipe = null; // the touch that may be a swipe: { x, y, video }
      var modeTapDir = 0; // a tap in seek mode: seeks this way when it ends

      // Finds whichever <video> the tap actually landed within,
      // even if its real target was an overlay/controls element
      // layered on top of it rather than the <video> itself.
      function findVideoUnderPoint(x, y) {
        var videos = document.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) {
          var rect = videos[i].getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return videos[i];
          }
        }
        return null;
      }

      function showLabel(text) {
        if (!label) {
          label = document.createElement('div');
          label.style.cssText =
            'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;' +
            'padding:8px 16px;border-radius:20px;background:rgba(0,0,0,0.7);color:#fff;' +
            'font:bold 20px sans-serif;pointer-events:none;';
        }
        label.textContent = text;
        // In full screen only what's inside the full-screen element shows.
        var full = document.fullscreenElement;
        var parent = full && full.tagName !== 'VIDEO' ? full : document.body;
        if (parent && label.parentNode !== parent) parent.appendChild(label);
      }

      function endSeekMode() {
        seekMode = null;
        if (label && label.parentNode) label.parentNode.removeChild(label);
      }

      // dir: 1 skips ahead, -1 rewinds. Adds up while seek mode goes the same way.
      function seekBy(video, dir) {
        var duration = video.duration || Infinity;
        video.currentTime = Math.min(duration, Math.max(0, video.currentTime + dir * SEEK_SECONDS));
        var total = seekMode && seekMode.dir === dir ? seekMode.total + SEEK_SECONDS : SEEK_SECONDS;
        if (seekMode) clearTimeout(seekMode.timer);
        seekMode = { dir: dir, total: total, timer: setTimeout(endSeekMode, SEEK_MODE_MS) };
        showLabel((dir > 0 ? '+' : '\u2212') + total + 's');
      }

      function seek(video, x) {
        var rect = video.getBoundingClientRect();
        seekBy(video, x - rect.left < rect.width / 2 ? -1 : 1);
      }

      // The player's seek bar, volume and the like: a drag there isn't a swipe.
      function isSlider(target) {
        return !!(
          target.closest &&
          target.closest('input[type="range"], [role="slider"], [class*="progress"], [class*="seek"], [class*="slider"], [class*="volume"], [data-seekbar], [data-volume]')
        );
      }

      function send(target, e) {
        replayed.add(e);
        try { target.dispatchEvent(e); } catch (err) {}
      }

      // A copy of a held event (an event can't be sent twice).
      function copyOf(e) {
        var init = {};
        for (var k in e) init[k] = e[k];
        ['touches', 'targetTouches', 'changedTouches'].forEach(function(k) {
          if (e[k]) init[k] = Array.prototype.slice.call(e[k]);
        });
        return new e.constructor(e.type, init);
      }

      // Sends the held tap on, as it was.
      function release() {
        clearTimeout(timer);
        timer = null;
        var t = tap;
        tap = null;
        if (!t) return;
        t.held.forEach(function(e) {
          try { send(e.target, copyOf(e)); } catch (err) {}
        });
      }

      // A single tap on Clappr's video: its controls, shown or hidden.
      function toggleClapprControls(t) {
        var player = t.target.tagName === 'VIDEO' && t.target.closest && t.target.closest('[data-player]');
        var controls = player && player.querySelector('.media-control');
        if (!controls) return false;
        cancel(t);
        if (controls.classList.contains('media-control-hide')) {
          t.target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: t.x, clientY: t.y }));
        } else {
          controls.classList.add('media-control-hide');
        }
        return true;
      }

      // No second tap came: it was a single tap.
      function singleTap() {
        var t = tap;
        if (t && toggleClapprControls(t)) {
          timer = null;
          tap = null;
          return;
        }
        var video = t && findVideoUnderPoint(t.x, t.y);
        var wasPlaying = video && !video.paused;
        var onButton = t && t.target.closest && t.target.closest('button, [role="button"], a, input, select');
        release();
        if (!wasPlaying || onButton) return;
        setTimeout(function() {
          if (!video.paused) return;
          video.play().catch(function() {});
          t.target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: t.x, clientY: t.y }));
        }, 150);
      }

      // The player saw the first tap start; tell it the tap was called off.
      function cancel(t) {
        try {
          send(t.target, new PointerEvent('pointercancel', {
            bubbles: true, pointerId: t.pointerId, pointerType: t.pointerType, isPrimary: true
          }));
        } catch (err) {}
        if (t.touch) {
          try {
            send(t.target, new TouchEvent('touchcancel', {
              bubbles: true, touches: [], targetTouches: [], changedTouches: [t.touch]
            }));
          } catch (err) {}
        }
      }

      window.addEventListener('touchstart', function(e) {
        if (replayed.has(e)) return;
        var t = e.touches[0];
        var video = e.touches.length === 1 ? findVideoUnderPoint(t.clientX, t.clientY) : null;
        var link = e.target.closest && e.target.closest('a[href]');
        swipe = video && !link && !isSlider(e.target) ? { x: t.clientX, y: t.clientY, video: video } : null;
      }, true);

      window.addEventListener('touchend', function(e) {
        if (replayed.has(e)) return;
        var start = swipe;
        var tapDir = modeTapDir;
        swipe = null;
        modeTapDir = 0;
        var t = e.changedTouches[0];
        var dx = start && t ? t.clientX - start.x : 0;
        var dy = start && t ? t.clientY - start.y : 0;
        if (start && Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
          seekBy(start.video, dx > 0 ? 1 : -1);
          e.stopPropagation();
        } else if (tapDir && t) {
          var video = findVideoUnderPoint(t.clientX, t.clientY);
          if (video) seekBy(video, tapDir);
        }
      }, true);

      window.addEventListener('pointerdown', function(e) {
        if (replayed.has(e) || !e.isPrimary) return;
        var video = findVideoUnderPoint(e.clientX, e.clientY);
        if (seekMode && video) {
          // A tap in seek mode: seeks when it ends (touchend), unless it's a
          // swipe, and never reaches the player.
          release();
          swallowing = true;
          modeTapDir = seekMode.dir;
          e.stopPropagation();
          return;
        }
        if (tap && tap.ended && video) {
          // The second tap: seek, and keep both taps from the player.
          clearTimeout(timer);
          timer = null;
          cancel(tap);
          tap = null;
          swallowing = true;
          e.stopPropagation();
          seek(video, e.clientX);
          return;
        }
        release();
        swallowing = false;
        if (!video || (e.target.closest && e.target.closest('a[href]'))) return;
        tap = {
          x: e.clientX, y: e.clientY, start: Date.now(), target: e.target,
          pointerId: e.pointerId, pointerType: e.pointerType, touch: null, held: [], ended: false
        };
      }, true);

      window.addEventListener('touchstart', function(e) {
        if (replayed.has(e)) return;
        if (swallowing) return e.stopPropagation();
        if (e.touches.length > 1) return release();
        if (tap && !tap.ended && !tap.touch) tap.touch = e.changedTouches[0];
      }, true);

      window.addEventListener('pointermove', function(e) {
        if (replayed.has(e)) return;
        if (swallowing) return e.stopPropagation();
        if (tap && !tap.ended && Math.abs(e.clientX - tap.x) + Math.abs(e.clientY - tap.y) > 10) release();
      }, true);

      window.addEventListener('touchmove', function(e) {
        if (e.touches.length > 1) swipe = null;
        if (swallowing && !replayed.has(e)) e.stopPropagation();
      }, true);

      ['pointerup', 'touchend', 'mousedown', 'mouseup', 'click'].forEach(function(type) {
        window.addEventListener(type, function(e) {
          if (replayed.has(e)) return;
          if (swallowing) {
            e.stopPropagation();
            // No mouse events or click from it either.
            if (type === 'touchend' && e.cancelable) e.preventDefault();
            if (type === 'click') e.preventDefault();
            return;
          }
          if (!tap) return;
          if (!tap.ended && Date.now() - tap.start > 500) return release(); // a long press
          e.stopPropagation();
          if (type === 'click') e.preventDefault(); // its copy does what it would have
          tap.held.push(e);
          if (type === 'pointerup') {
            tap.ended = true;
            timer = setTimeout(singleTap, DOUBLE_TAP_MS);
          }
        }, true);
      });

      document.addEventListener(
        'dblclick',
        function(e) {
          if (findVideoUnderPoint(e.clientX, e.clientY)) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        true
      );
    })();
    true;
  `;
