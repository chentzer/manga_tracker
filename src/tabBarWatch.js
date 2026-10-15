// Run inside each browsing tab's page (MediaWebView.js) for the
// auto-hiding tab row in App.js. Reports two things, as
// { type: 'tabBar', kind }:
//   'scroll'  — the page (or a scrolling box inside it) moved; sent at
//               most every 0.4s. Taps (e.g. for the next page) aren't
//               movement and send nothing.
//   'pullTop' — a finger dragged down while the page was already at the
//               very top (like pull-to-refresh), which brings the row back.
// Safe to run twice on one page (it's injected before and after load).
export const TAB_BAR_WATCH_JS = `
  (function() {
    if (window.__tabBarWatch) return;
    window.__tabBarWatch = true;
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
    var startY = null;
    window.addEventListener('touchstart', function(e) {
      startY = e.touches.length === 1 && atTop(e.target) ? e.touches[0].clientY : null;
    }, { capture: true, passive: true });
    window.addEventListener('touchmove', function(e) {
      if (startY === null) return;
      if (!atTop(e.target)) { startY = null; return; }
      if (e.touches[0].clientY - startY > 80) {
        startY = null;
        post('pullTop');
      }
    }, { capture: true, passive: true });
  })();
  true;
`;
