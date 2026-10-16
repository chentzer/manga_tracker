// Run inside each browsing tab's page (MediaWebView.js) for the
// auto-hiding tab row in App.js and pull-to-refresh (Android's web view
// has none of its own). Reports, as { type: 'tabBar', kind }:
//   'scroll'  — the page (or a scrolling box inside it) moved; sent at
//               most every 0.4s. Taps (e.g. for the next page) aren't
//               movement and send nothing.
//   'pullTop' — a finger dragged down PULL_SHOW px while the page was
//               already at the very top, which brings the row back.
// Pulling on to PULL_REFRESH px and letting go reloads the page; a small
// pill at the top says "Pull to refresh" / "Release to refresh" meanwhile.
// Safe to run twice on one page (it's injected before and after load).
export const TAB_BAR_WATCH_JS = `
  (function() {
    if (window.__tabBarWatch) return;
    window.__tabBarWatch = true;
    var PULL_SHOW = 80;
    var PULL_REFRESH = 160;
    function post(kind) {
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tabBar', kind: kind }));
      } catch (e) {}
    }
    var lastScroll = 0;
    window.addEventListener('scroll', function() {
      var now = Date.now();
      if (now - lastScroll < 400) return;
      lastScroll = now;
      post('scroll');
    }, { capture: true, passive: true });

    // At the top = the page and every scrolling box around the finger
    // are scrolled all the way up.
    function atTop(el) {
      for (; el && el !== document.documentElement; el = el.parentElement) {
        if (el.scrollTop > 0) return false;
      }
      var se = document.scrollingElement || document.documentElement;
      return (window.scrollY || (se && se.scrollTop) || 0) <= 0;
    }

    // The "Pull to refresh" pill, shown only while pulling.
    var pill = null;
    function showPill(distance) {
      if (!pill) {
        pill = document.createElement('div');
        pill.style.cssText =
          'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
          'padding:6px 14px;border-radius:16px;background:rgba(22,33,62,0.92);color:#fff;' +
          'font:600 13px sans-serif;pointer-events:none;transition:opacity .15s;';
        (document.body || document.documentElement).appendChild(pill);
      }
      var ready = distance >= PULL_REFRESH;
      pill.textContent = ready ? '\\u21bb Release to refresh' : '\\u2193 Pull to refresh';
      pill.style.opacity = String(Math.min(1, distance / PULL_REFRESH + 0.2));
    }
    function hidePill() {
      if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
      pill = null;
    }

    var startY = null;
    var distance = 0;
    var shown = false;
    window.addEventListener('touchstart', function(e) {
      startY = e.touches.length === 1 && atTop(e.target) ? e.touches[0].clientY : null;
      distance = 0;
      shown = false;
    }, { capture: true, passive: true });
    window.addEventListener('touchmove', function(e) {
      if (startY === null) return;
      if (e.touches.length !== 1 || !atTop(e.target)) {
        startY = null;
        hidePill();
        return;
      }
      distance = e.touches[0].clientY - startY;
      if (distance <= 20) { hidePill(); return; }
      showPill(distance);
      if (!shown && distance > PULL_SHOW) {
        shown = true;
        post('pullTop');
      }
    }, { capture: true, passive: true });
    function end() {
      var refresh = startY !== null && distance >= PULL_REFRESH;
      startY = null;
      hidePill();
      if (refresh) {
        post('refresh');
        location.reload();
      }
    }
    window.addEventListener('touchend', end, { capture: true, passive: true });
    // Android can cancel the touch when it takes over the drag; a pull that
    // already went far enough still counts.
    window.addEventListener('touchcancel', end, { capture: true, passive: true });
  })();
  true;
`;
