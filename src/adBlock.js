// Ad blocking for every browsing tab (MediaWebView.js), on top of the
// redirect blocking those tabs already do. Turned on/off with
// Settings → Block ads.
//
// Two parts:
// - isAdUrl(): the app refuses to open a page on a known ad network,
//   even when it's tapped.
// - AD_BLOCK_JS, run inside each page as it loads:
//     • stops pop-ups the page opens without you tapping anything
//     • stops scripts, frames and images from known ad networks from
//       loading, and removes any that get added to the page anyway
//     • also stops "zone" ad scripts (isZoneScript) whatever domain they
//       come from: those networks keep moving to new throwaway domains
//     • removes pop-up boxes that a script from another site draws over
//       the page (fake phone warnings, app-download boxes), and then
//       blocks that site for the rest of the page
//     • stops the page's own requests to those networks
//     • ignores taps on links that lead to them
//     • hides the usual ad boxes
// Android only runs it in the page itself, not inside frames from other
// sites, so an ad already inside such a frame can still show — but the
// frame itself is removed when it comes from a known ad network.

// Ad / pop-under networks (each also covers its sub-domains). Kept to
// well-known advertising domains, so normal sites keep working.
export const AD_DOMAINS = [
  // pop-under / push networks
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propellerclick.com',
  'onclickads.net',
  'onclkds.com',
  'adsterra.com',
  'adcash.com',
  'hilltopads.net',
  'clickadu.com',
  'galaksion.com',
  'zeropark.com',
  'admaven.com',
  'a-ads.com',
  'adskeeper.com',
  'mgid.com',
  'revcontent.com',
  // mainstream ad networks
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'pubmatic.com',
  'rubiconproject.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  // Throwaway domains of "zone" pop-up networks seen on the tabs' sites
  // (fake "unused bonus" boxes, full-page vignettes). New ones are caught
  // by isZoneScript in AD_BLOCK_JS anyway.
  'n6wxm.com',
  'gizokraijaw.net',
  'nap5k.com',
  'ldrws.com',
  'jhnwr.com',
];

export function isAdUrl(url) {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url || '');
  if (!match) return false;
  const host = match[1].toLowerCase();
  return AD_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// Common ad box selectors, hidden with CSS. Only names that are clearly
// ads, so page content isn't hidden by mistake.
const AD_SELECTORS = [
  'ins.adsbygoogle',
  '.adsbygoogle',
  '[id^="google_ads_"]',
  '[id^="div-gpt-ad"]',
  'iframe[id^="google_ads_iframe"]',
  '[data-ad-slot]',
  '[data-ad-client]',
  '.ad-banner',
  '.ad-container',
  '.ads-container',
  '.advertisement',
  '.sponsored-ad',
];

export const AD_BLOCK_JS = `
  (function () {
    if (window.__mtAdBlock) return;
    window.__mtAdBlock = true;
    var DOMAINS = ${JSON.stringify(AD_DOMAINS)};
    function hostOf(url) {
      try { return new URL(url, location.href).hostname.toLowerCase(); } catch (e) { return ''; }
    }
    // Sites caught drawing a pop-up box (see "Pop-up boxes" below): the
    // rest of their scripts are blocked too.
    var caught = {};
    function isAd(url) {
      if (!url) return false;
      var h = hostOf(String(url));
      if (caught[h]) return true;
      for (var i = 0; i < DOMAINS.length; i++) {
        if (h === DOMAINS[i] || h.slice(-DOMAINS[i].length - 1) === '.' + DOMAINS[i]) return true;
      }
      return false;
    }
    // A "zone" ad script: from another site, and either tagged with
    // data-zone (how those networks pick the ad) or one of their loader
    // names. Caught whatever throwaway domain it uses.
    var ZONE_FILE = /\\/(vignette|tag)\\.min\\.js$/i;
    function isZoneScript(el, url) {
      if (!url || !el || el.tagName !== 'SCRIPT') return false;
      var u;
      try { u = new URL(String(url), location.href); } catch (e) { return false; }
      if (u.hostname === location.hostname) return false;
      return !!(el.dataset && el.dataset.zone) || ZONE_FILE.test(u.pathname);
    }
    var reported = 0;
    function report(what, url) {
      if (reported++ > 50) return; // keep the debug log readable
      try {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'adBlocked', what: what, url: String(url || '') }));
      } catch (e) {}
    }

    // Pop-ups: only allowed right after a tap, and never to an ad network.
    var realOpen = window.open;
    window.open = function (url) {
      var tapped = !navigator.userActivation || navigator.userActivation.isActive;
      if (!tapped || isAd(url)) {
        report('pop-up', url);
        return null;
      }
      return realOpen.apply(window, arguments);
    };

    // Scripts, frames and images from ad networks never get their address.
    function guardSrc(proto, tag) {
      var desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          if (isAd(value) || isZoneScript(this, value)) { report(tag, value); return; }
          desc.set.call(this, value);
        },
      });
    }
    guardSrc(window.HTMLScriptElement && HTMLScriptElement.prototype, 'script');
    guardSrc(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'frame');
    guardSrc(window.HTMLImageElement && HTMLImageElement.prototype, 'image');
    var realSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      var n = String(name).toLowerCase();
      if ((n === 'src' || (n === 'href' && this.tagName === 'LINK')) && (isAd(value) || (n === 'src' && isZoneScript(this, value)))) {
        report(this.tagName.toLowerCase(), value);
        return;
      }
      return realSetAttribute.apply(this, arguments);
    };

    // The page's own requests to ad networks.
    if (window.fetch) {
      var realFetch = window.fetch;
      window.fetch = function (input) {
        var url = typeof input === 'string' ? input : input && input.url;
        if (isAd(url)) { report('request', url); return Promise.reject(new TypeError('Blocked')); }
        return realFetch.apply(this, arguments);
      };
    }
    var realXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isAd(url)) { report('request', url); this.__mtBlocked = true; }
      return realXhrOpen.apply(this, arguments);
    };
    var realXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__mtBlocked) return;
      return realXhrSend.apply(this, arguments);
    };

    // Taps on links to ad networks do nothing.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (a && isAd(a.href)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        report('link', a.href);
      }
    }, true);

    // Pop-up boxes drawn by scripts from other sites (fake "storage
    // running out" warnings, app-download boxes), whatever ad network or
    // domain they use. Elements a script from another site creates are
    // marked with that site; one that turns out to float over the page
    // (position: fixed) or is a frame is removed, and that site is caught.
    // The page's own scripts, and challenge / captcha scripts, are left
    // alone.
    var SAFE_HOSTS = ['challenges.cloudflare.com', 'www.gstatic.com', 'www.google.com', 'www.recaptcha.net', 'js.hcaptcha.com', 'hcaptcha.com'];
    function siteOf(h) { return h.split('.').slice(-2).join('.'); }
    var pageSite = siteOf(location.hostname);
    var STACK_URL = /(https?:\\/\\/[^\\s()]+?):\\d+:\\d+/g;
    // The other site whose script is running right now, or ''.
    function foreignCaller() {
      var stack = '';
      try { stack = new Error().stack || ''; } catch (e) {}
      STACK_URL.lastIndex = 0;
      var m;
      while ((m = STACK_URL.exec(stack))) {
        var h = hostOf(m[1]);
        if (h && siteOf(h) !== pageSite && SAFE_HOSTS.indexOf(h) === -1) return h;
      }
      return '';
    }
    var realCreate = Document.prototype.createElement;
    Document.prototype.createElement = function () {
      var el = realCreate.apply(this, arguments);
      var cur = document.currentScript;
      if (!(cur && cur.src && siteOf(hostOf(cur.src)) === pageSite)) {
        var by = foreignCaller();
        if (by) el.__mtBy = by;
      }
      return el;
    };
    function floats(el) {
      if (!el.isConnected) return false;
      if (getComputedStyle(el).position === 'fixed') return true;
      var inner = el.querySelectorAll('*');
      for (var i = 0; i < inner.length && i < 50; i++) {
        if (getComputedStyle(inner[i]).position === 'fixed') return true;
      }
      return false;
    }
    function checkForeign(el) {
      var by = el.__mtBy;
      var drop = function () {
        if (!el.isConnected) return;
        el.remove();
        caught[by] = true;
        report('pop-up box', 'https://' + by);
      };
      if (el.tagName === 'IFRAME') return drop();
      // Its look may come a moment after it's added.
      setTimeout(function () { if (floats(el)) drop(); }, 0);
      setTimeout(function () { if (floats(el)) drop(); }, 1000);
    }

    // Anything from an ad network that is already in the page, or added
    // later, is removed.
    function sweep(root) {
      if (!root || !root.querySelectorAll) return;
      var nodes = root.querySelectorAll('script[src], iframe[src], img[src], a[href]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var url = el.tagName === 'A' ? el.href : el.src;
        if (!isAd(url) && !isZoneScript(el, url)) continue;
        if (el.tagName === 'A') {
          // An ad link wrapped round real content: just unlink it.
          if (el.querySelector('img, iframe') || !el.textContent.trim()) { el.remove(); report('ad', url); }
        } else {
          el.remove();
          report(el.tagName.toLowerCase(), url);
        }
      }
    }
    function start() {
      sweep(document);
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType !== 1) continue;
            if (node.__mtBy) checkForeign(node);
            if (node.matches && node.matches('script[src], iframe[src], img[src], a[href]')) sweep(node.parentNode);
            else sweep(node);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      var style = document.createElement('style');
      style.textContent = ${JSON.stringify(AD_SELECTORS.join(', '))} + ' { display: none !important; }';
      (document.head || document.documentElement).appendChild(style);
    }
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start);
  })();
  true;
`;
