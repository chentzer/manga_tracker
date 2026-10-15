// Central place to add new trackable media types. Each entry fully
// describes how to recognize a URL, pull out a unique id from it, and
// grab a thumbnail — nothing else in the app needs to change per type.
//
// Everything here is a working EXAMPLE, not tied to any specific site.
// Fill in the placeholder domains and, if needed, tweak the selectors
// in extractMetadataJs to match the actual page structure of the site
// you're tracking. See README.md's "Before you run it" section for a
// walkthrough.
//
// extractMetadataJs's postMessage payload also supports an optional
// `altTitle` field — a secondary title in another language/script,
// stored separately and shown under the main title in the Library.
// Useful for sites that show both a translated title and an original
// one (e.g. an English title alongside an original Japanese title).
// Leave it out (or send null) if a type doesn't have a second title.

import Constants from 'expo-constants';

// Each tab's site comes from .env (MANGA_SITE_URL / ANIME_SITE_URL) via
// app.config.js, so the real sites never have to be committed. Falls
// back to the placeholder domains when .env doesn't set them.
const extra = Constants.expoConfig?.extra || {};
const MANGA_SITE_URL = extra.mangaSiteUrl || 'https://your-manga-site.example.com';
const ANIME_SITE_URL = extra.animeSiteUrl || 'https://your-anime-site.example.com';

export const MEDIA_TYPES = {
  manga: {
    key: 'manga',
    label: 'Manga',
    // Labels shown for the read-status toggle/badge on this type's
    // entries — "Read" makes sense for manga; anime uses "Watched"
    // instead further down. The underlying stored value is always
    // 'read' or 'want_to_read' regardless of type; only the display
    // wording changes.
    readStatusLabels: { read: 'Read', want: 'Want to Read' },
    // Set MANGA_SITE_URL in .env to the site you browse.
    startUrl: MANGA_SITE_URL,
    // Example pattern: matches .../title/<id>-<slug> (series page) and
    // .../title/<id>-<slug>/<chapterId>-chapter-<n> (reader page) alike,
    // with or without the slug -> capture group 1 = the series id,
    // capture group 2 = the chapter number on reader pages. Adjust the
    // path segments to match your actual site's URLs.
    urlRegex: /^https?:\/\/[^/]+\/title\/([a-z0-9]+)(?:-[^/?#]*)?(?:\/\d+-chapter-([\d.]+))?/i,
    // Reverse of urlRegex/extractId — turns a manga id typed in manually
    // into a real URL the webview can navigate to.
    buildUrlFromId: (id) => `${MANGA_SITE_URL}/title/${id}`,
    // Used by the "Save Page Image" feature to name the saved file as
    // "code -- chN" (e.g. "abc12 -- ch60"). Returns null on the series
    // page, in which case the caller falls back to just the code.
    extractPageNumber: (match) => (match[2] ? `ch${match[2]}` : null),
    extractId: (match) => match[1],
    // If your site shows popup/redirect ads, uncomment this to block
    // any navigation attempt to a domain other than the one above —
    // stops window.open popups, redirects, and hijacks regardless of
    // the exact mechanism the ad uses. Off by default since some sites
    // legitimately link out (e.g. to a Discord/Twitter) and you may not
    // want that blocked.
    // blockExternalNavigation: true,
    // Domain-blocking alone can miss same-domain ad-redirect endpoints
    // some sites run specifically to defeat it (e.g.
    // example.com/pop?url=<encoded-ad-destination> — technically still
    // example.com, so it passes the domain check even though its whole
    // purpose is hijacking the page into an ad). If a video keeps
    // stopping playback shortly after starting and the Android back
    // button reveals you'd been navigated to a new page, this is a
    // common cause — check the debug log's "Checking URL: ..." lines
    // (enable via the Settings gear icon on the Library tab) right when
    // it happens to find the actual redirect URL, then block it here
    // regardless of domain:
    // blockedUrlPatterns: [/example\.com\/pop(\?|$)/i],
    // If a video/player stops playback shortly after starting (a
    // second or two in, then just stops), the site may be detecting
    // Android WebView's default User-Agent (which includes a "wv"
    // marker) and specifically blocking it. Spoofing a plain mobile
    // Chrome UA usually fixes this — uncomment and adjust the Chrome
    // version if needed:
    // userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    // Reader (chapter) pages don't show the cover or author, so this
    // only records from the series page: deeper paths post `skip`, which
    // tells MediaWebView not to save anything from this page. Many manga
    // sites are single-page apps that render after the URL changes, so
    // it waits until the <h1> and the cover image are there (and agree on
    // the title) before reading anything.
    //
    // Selectors are generic guesses that suit many sites — adjust them to
    // your site's DOM (right-click the element → Inspect):
    // - title: the page's <h1>, then og:title
    // - cover: an <img> inside an element whose class mentions "poster",
    //   then og:image
    // - altTitle: the first <li> inside an element whose class mentions
    //   "alts" (alternative titles)
    // - author: links into the site's author/artist search
    extractMetadataJs: `
      (function() {
        if (location.pathname.split('/').filter(Boolean).length > 2) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ skip: 'reader page' }));
          return;
        }
        var attempts = 0;
        function trySend() {
          var h1 = document.querySelector('h1');
          var poster = document.querySelector('[class*="poster"] img');
          var h1Text = h1 ? h1.textContent.trim() : '';
          var ready = h1Text && poster && (!poster.alt || poster.alt.trim() === h1Text);

          attempts++;
          if (!ready && attempts < 20) {
            setTimeout(trySend, 300);
            return;
          }

          var ogTitle = document.querySelector('meta[property="og:title"]');
          var ogImage = document.querySelector('meta[property="og:image"]');
          var title = h1Text || (ogTitle && ogTitle.content) || null;
          var imageUrl = (poster && (poster.currentSrc || poster.src)) ||
            (ogImage && ogImage.content) || null;

          var altEl = document.querySelector('[class*="alts"] li');
          var altTitle = altEl ? altEl.textContent.trim() : null;
          if (altTitle === title) altTitle = null;

          var names = [];
          var links = document.querySelectorAll('a[href*="authors="], a[href*="artists="]');
          for (var i = 0; i < links.length; i++) {
            var name = links[i].textContent.trim();
            if (name && names.indexOf(name) === -1) names.push(name);
          }

          window.ReactNativeWebView.postMessage(JSON.stringify({
            imageUrl: imageUrl,
            title: title,
            altTitle: altTitle,
            author: names.join(', ') || null,
          }));
        }
        trySend();
      })();
      true;
    `,
  },

  anime: {
    key: 'anime',
    label: 'Anime',
    // "Watched" instead of manga's "Read" — same underlying stored
    // value ('read'/'want_to_read'), just different wording per type.
    readStatusLabels: { read: 'Watched', want: 'Want to Watch' },
    // Double-tap left half of the video to rewind, right half to
    // fast-forward (YouTube-style) — set to however many seconds each
    // tap should skip, or omit/0 to disable. Harmless to leave on
    // types with no <video> element (it just finds nothing to attach
    // to). Some players bind their own double-click handler (commonly
    // for fullscreen) which can fire alongside this — see
    // buildDoubleTapSeekJs in MediaWebView.js for details.
    doubleTapSeekSeconds: 5,
    // Set ANIME_SITE_URL in .env to the site you browse.
    startUrl: ANIME_SITE_URL,
    // Example pattern: matches .../watch/<id>/<slug>?ep=3 (episode page)
    // and .../info/<id>/<slug> (series page) alike -> capture group 1 =
    // the series id, so every episode of a series is one entry. Adjust
    // the path segments to match your site's URLs.
    urlRegex: /^https?:\/\/[^/]+\/(?:watch|info)\/([A-Za-z0-9_-]+)/,
    extractId: (match) => match[1],
    // Reverse of urlRegex/extractId, for a series id typed in manually.
    buildUrlFromId: (id) => `${ANIME_SITE_URL}/watch/${id}`,
    // If your site sometimes shows a "Continue"/age-gate/ad interstitial
    // before the real page loads, uncomment this and set it to the
    // button's exact visible text — it gets auto-clicked the moment it
    // appears.
    // autoConfirmButtonText: 'Continue',
    // If the interstitial instead shows as an overlay on the real page's
    // own URL, list a substring found in the URL while it's showing
    // (check the debug log's "Checking URL: ..." lines) and extraction
    // will skip until you're past it.
    // interstitialKeywords: ['some-marker-found-in-the-url'],
    // Title comes from the page's <h1> (usually the English title) and
    // the thumbnail from og:image. og:title often holds the original/
    // romanized title instead, so it's saved as altTitle when it differs
    // (minus a leading "Watch "). Many anime sites are single-page apps
    // that swap the page client-side, so this waits until the <h1> is
    // there and og:url points at the series in the current URL before
    // reading anything — otherwise it could save the previous series'
    // details. No author for anime.
    extractMetadataJs: `
      (function() {
        var attempts = 0;
        function trySend() {
          var ogTitle = document.querySelector('meta[property="og:title"]');
          var ogImage = document.querySelector('meta[property="og:image"]');
          var ogUrl = document.querySelector('meta[property="og:url"]');
          var h1 = document.querySelector('h1');
          var seriesId = location.pathname.split('/')[2] || '';
          var ready = h1 && h1.textContent.trim() &&
            (!ogUrl || !seriesId || ogUrl.content.indexOf(seriesId) !== -1);

          attempts++;
          if (!ready && attempts < 20) {
            setTimeout(trySend, 300);
            return;
          }

          var title = h1 ? h1.textContent.trim() : null;
          var altTitle = ogTitle && ogTitle.content
            ? ogTitle.content.replace(/^Watch +/i, '').trim()
            : null;
          if (!title) {
            title = altTitle || document.title || null;
            altTitle = null;
          }
          if (altTitle === title) altTitle = null;
          var video = document.querySelector('video');
          var imageUrl = (ogImage && ogImage.content) || (video && video.poster) || null;

          window.ReactNativeWebView.postMessage(JSON.stringify({
            imageUrl: imageUrl,
            title: title,
            altTitle: altTitle,
            author: null,
          }));
        }
        trySend();
      })();
      true;
    `,
  },

  // MULTI-SOURCE EXAMPLE (commented out) — for a category where several
  // sites carry overlapping-but-not-identical catalogs, a type can
  // define `sources` (an array) instead of top-level urlRegex/extractId/
  // extractMetadataJs. Each source is fully self-contained, since
  // different sites' page structures rarely match each other. This
  // unlocks a fallback search box (shown instead of the manual-entry
  // box) that tries each source's search URL in priority order and
  // loads the first real result found — detected by testing links on
  // the search results page against that source's own urlRegex, so
  // there's only one place per source defining what a valid content
  // URL looks like.
  //
  // otherCategory: {
  //   key: 'otherCategory',
  //   label: 'Other',
  //   startUrl: 'https://site-a.example.com',
  //   blockExternalNavigation: true,
  //   sources: [
  //     {
  //       name: 'Site A',
  //       domain: 'site-a.example.com',
  //       urlRegex: /.../,
  //       extractId: (match) => match[1],
  //       buildUrlFromId: (id) => `https://site-a.example.com/${id}`,
  //       buildSearchUrl: (code) => `https://site-a.example.com/search/${code}`,
  //       extractMetadataJs: `...`,
  //     },
  //     {
  //       name: 'Site B',
  //       domain: 'site-b.example.com',
  //       urlRegex: /.../,
  //       extractId: (match) => match[1],
  //       buildSearchUrl: (code) => `https://site-b.example.com/?s=${code}`,
  //       // No buildUrlFromId here is fine — that source just won't
  //       // support direct manual entry, only being found via search.
  //       autoConfirmButtonText: 'Continue', // if this site has one
  //       extractMetadataJs: `...`,
  //     },
  //   ],
  // },
};

export const MEDIA_TYPE_LIST = Object.values(MEDIA_TYPES);
