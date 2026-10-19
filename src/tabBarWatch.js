// Run inside each browsing tab's page (MediaWebView.js) for the
// auto-hiding tab row in App.js and pull-to-refresh (Android's web view
// has none of its own). Reports, as { type: 'tabBar', kind }:
//   'scroll'  — the page (or a scrolling box inside it) moved; sent at
//               most every 0.4s. Taps (e.g. for the next page) aren't
//               movement and send nothing.
//   'pullTop' — a finger dragged down PULL_SHOW px while the page was
//               already at the very top, which brings the row back.
//   'library' — dragged up PULL_LIBRARY px past the very bottom of the page
//               and let go: App.js opens the Library.
// Pulling on to PULL_REFRESH px and letting go reloads the page; a small
// pill at the top says "Pull to refresh" / "Release to refresh" meanwhile.
// At the bottom a pill says "Pull up for Library" / "Release for Library".
// Safe to run twice on one page (it's injected before and after load).
export const TAB_BAR_WATCH_JS = `
  (function() {
    if (window.__tabBarWatch) return;
    window.__tabBarWatch = true;
    var PULL_SHOW = 80;
    var PULL_REFRESH = 160;
    var PULL_LIBRARY = 160;
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

    // At the bottom = the page and every scrolling box around the finger
    // are scrolled all the way down (a page that doesn't scroll counts).
    function atBottom(el) {
      for (; el && el !== document.documentElement; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
          var overflow = getComputedStyle(el).overflowY;
          if (overflow === 'auto' || overflow === 'scroll') return false;
        }
      }
      var se = document.scrollingElement || document.documentElement;
      var y = window.scrollY || (se && se.scrollTop) || 0;
      return y + window.innerHeight >= (se ? se.scrollHeight : 0) - 2;
    }

    // The pill, shown only while pulling: at the top for refresh, at the
    // bottom for the Library.
    var pill = null;
    function showPill(distance, bottom) {
      if (!pill) {
        pill = document.createElement('div');
        pill.style.cssText =
          'position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;' +
          'padding:6px 14px;border-radius:16px;background:rgba(22,33,62,0.92);color:#fff;' +
          'font:600 13px sans-serif;pointer-events:none;transition:opacity .15s;';
        (document.body || document.documentElement).appendChild(pill);
      }
      pill.style.top = bottom ? '' : '12px';
      pill.style.bottom = bottom ? '12px' : '';
      var limit = bottom ? PULL_LIBRARY : PULL_REFRESH;
      var ready = distance >= limit;
      pill.textContent = bottom
        ? (ready ? '\\ud83d\\udcda Release for Library' : '\\u2191 Pull up for Library')
        : (ready ? '\\u21bb Release to refresh' : '\\u2193 Pull to refresh');
      pill.style.opacity = String(Math.min(1, distance / limit + 0.2));
    }
    function hidePill() {
      if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
      pill = null;
    }

    var startY = null;
    var distance = 0;
    var shown = false;
    // Pulling up past the bottom: where the finger went down, when the page
    // was already at the bottom (null otherwise — a swipe that only
    // reaches the end on the way doesn't count, so reading to the last
    // page never jumps away by itself), and how far it has gone up since.
    var bottomY = null;
    var upDistance = 0;
    window.addEventListener('touchstart', function(e) {
      startY = e.touches.length === 1 && atTop(e.target) ? e.touches[0].clientY : null;
      distance = 0;
      shown = false;
      bottomY = e.touches.length === 1 && atBottom(e.target) ? e.touches[0].clientY : null;
      upDistance = 0;
    }, { capture: true, passive: true });
    window.addEventListener('touchmove', function(e) {
      if (bottomY === null) return;
      if (e.touches.length !== 1) { bottomY = null; hidePill(); return; }
      upDistance = bottomY - e.touches[0].clientY;
      if (upDistance < -20 || !atBottom(e.target)) {
        bottomY = null;
        upDistance = 0;
        hidePill();
        return;
      }
      if (upDistance > 20) showPill(upDistance, true);
      else if (startY === null) hidePill();
    }, { capture: true, passive: true });
    window.addEventListener('touchmove', function(e) {
      if (startY === null) return;
      if (e.touches.length !== 1 || !atTop(e.target)) {
        startY = null;
        hidePill();
        return;
      }
      distance = e.touches[0].clientY - startY;
      if (distance <= 20) {
        if (upDistance <= 20) hidePill(); // not while pulling up for the Library
        return;
      }
      showPill(distance);
      if (!shown && distance > PULL_SHOW) {
        shown = true;
        post('pullTop');
      }
    }, { capture: true, passive: true });
    function end() {
      var refresh = startY !== null && distance >= PULL_REFRESH;
      var library = bottomY !== null && upDistance >= PULL_LIBRARY;
      startY = null;
      bottomY = null;
      upDistance = 0;
      hidePill();
      if (refresh) {
        post('refresh');
        location.reload();
      } else if (library) {
        post('library');
      }
    }
    window.addEventListener('touchend', end, { capture: true, passive: true });
    // Android can cancel the touch when it takes over the drag; a pull that
    // already went far enough still counts.
    window.addEventListener('touchcancel', end, { capture: true, passive: true });
  })();
  true;
`;
