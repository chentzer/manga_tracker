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
    function isAd(url) {
      if (!url) return false;
      var h = hostOf(String(url));
      for (var i = 0; i < DOMAINS.length; i++) {
        if (h === DOMAINS[i] || h.slice(-DOMAINS[i].length - 1) === '.' + DOMAINS[i]) return true;
      }
      return false;
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
          if (isAd(value)) { report(tag, value); return; }
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
      if ((n === 'src' || (n === 'href' && this.tagName === 'LINK')) && isAd(value)) {
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

    // Anything from an ad network that is already in the page, or added
    // later, is removed.
    function sweep(root) {
      if (!root || !root.querySelectorAll) return;
      var nodes = root.querySelectorAll('script[src], iframe[src], img[src], a[href]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var url = el.tagName === 'A' ? el.href : el.src;
        if (!isAd(url)) continue;
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
