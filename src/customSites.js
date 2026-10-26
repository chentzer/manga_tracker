import { getSetting, setSetting } from './db';

// Sites you add yourself (Settings → Sites): each one joins a tab
// (Manga, Manhwa or Anime) as one more of its sites — in
// its site list, allowed by its redirect blocker, and its pages saved
// automatically like the tab's own sites, read with GENERIC_READER_JS
// (the page's preview details) since there's no site-specific reader.
// Kept in the settings table as JSON: [{ domain, type, name }].

export function loadCustomSites() {
  try {
    const list = JSON.parse(getSetting('customSites', '[]'));
    return Array.isArray(list) ? list.filter((s) => s && s.domain && s.type) : [];
  } catch (e) {
    return [];
  }
}

export function saveCustomSites(list) {
  setSetting('customSites', JSON.stringify(list));
}

// "example.com" from "https://www.example.com/x", "example.com/x" or
// "example.com"; null when it isn't a web address.
export function domainOf(text) {
  const t = String(text || '').trim().toLowerCase();
  const match = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[:/?#]|$)/.exec(t);
  return match ? match[1] : null;
}

// The code a page on a site without its own codes is saved under:
// "web-" + its address as one word ("web-example.com-gallery-12").
export function webCode(url) {
  const slug = String(url || '')
    .replace(/^https?:\/\/(www\.)?/i, '')
    .replace(/[?#].*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return `web-${slug || 'page'}`;
}

// Reads any page from its preview details: og:title / h1, og:image,
// author, keywords / article:tag. Pages that don't look like one title's
// page — the home page, search, tag, category and account pages, or
// pages without a title or picture — answer { notAnEntry: true } and
// aren't saved.
export const GENERIC_READER_JS = `
  (function () {
    function meta(sels) {
      for (var k = 0; k < sels.length; k++) {
        var m = document.querySelector(sels[k]);
        var v = m && (m.getAttribute('content') || m.textContent);
        if (v && v.trim()) return v.trim();
      }
      return null;
    }
    function send(p) { window.ReactNativeWebView.postMessage(JSON.stringify(p)); }
    setTimeout(function () {
      var path = location.pathname.replace(/\\/+$/, '');
      var listing = /(^|\\/)(search|tags?|categor(y|ies)|genres?|browse|popular|latest|new|page|login|register|signup|account|user|profile|settings)(\\/|$)/i;
      var title = meta(['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1']) || null;
      var image = meta(['meta[property="og:image"]', 'meta[name="twitter:image"]']);
      if (!image) {
        var best = null, area = 0, imgs = document.images;
        for (var i = 0; i < imgs.length; i++) {
          var a = (imgs[i].naturalWidth || 0) * (imgs[i].naturalHeight || 0);
          if (a > area) { area = a; best = imgs[i]; }
        }
        if (best && area > 40000) image = best.currentSrc || best.src;
      }
      if (!path || listing.test(path) || location.search.indexOf('q=') !== -1 || !title || !image) {
        send({ notAnEntry: true });
        return;
      }
      var tags = [];
      document.querySelectorAll('meta[property="article:tag"], meta[property="video:tag"], meta[property="book:tag"]').forEach(function (m) {
        var v = (m.getAttribute('content') || '').trim();
        if (v) tags.push(v);
      });
      send({
        title: title,
        imageUrl: image,
        author: meta(['meta[name="author"]', 'meta[property="article:author"]', 'meta[property="book:author"]', '[itemprop="author"] [itemprop="name"]']),
        genre: tags.length ? tags.join(', ') : meta(['meta[name="keywords"]']),
      });
    }, 1500);
  })();
  true;
`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The tab's config with your sites for it added after its own (so the
// tab's own sites always win): as `sources` for a tab with several
// sites, as `extraSources` otherwise.
export function withCustomSites(config, sites) {
  const mine = sites.filter((s) => s.type === config.key);
  if (!mine.length) return config;
  const extra = mine.map((s) => ({
    name: s.name || s.domain,
    domain: s.domain,
    custom: true,
    // Any page on the site below its home page; the reader decides
    // whether it's one title's page.
    urlRegex: new RegExp(`^https?:\\/\\/(?:[^/]+\\.)?${escape(s.domain)}\\/(?!$)[^?#]+`, 'i'),
    extractId: (match) => webCode(match[0]),
    extractMetadataJs: GENERIC_READER_JS,
  }));
  return config.sources
    ? { ...config, sources: [...config.sources, ...extra] }
    : { ...config, extraSources: [...(config.extraSources || []), ...extra] };
}
