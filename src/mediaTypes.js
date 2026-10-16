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

// Scripts for "Watch next" / "Read next" (EntryList.js → MediaWebView.js).
// Each runs on the page that was opened and either moves on to the wanted
// episode/chapter or reports { type: 'episodeMissing', message } back to
// the app, which shows it. They wait for single-page-app content to
// render first. (No backslashes: these are template strings.)

// On a reader page: clicks its "Next chapter" button, or reports that
// there's no next chapter when the button is disabled.
function clickNextChapterJs(n) {
  return `
    (function() {
      var tries = 0;
      function report(message) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'episodeMissing', message: message }));
      }
      function go() {
        var candidates = [].slice.call(document.querySelectorAll('button, a'));
        var next = candidates.filter(function (b) {
          var label = (b.getAttribute('aria-label') || b.textContent || '').trim();
          return /^next( chapter)?$/i.test(label) || /^next[^a-z]*ch/i.test(label);
        })[0];
        if (!next) {
          if (++tries < 25) { setTimeout(go, 400); return; }
          report("Couldn't find a Next chapter button on this page.");
          return;
        }
        if (next.disabled || next.getAttribute('aria-disabled') === 'true') {
          report('Chapter ${n} isn' + "'" + 't out yet — chapter ${n - 1} is the latest.');
          return;
        }
        next.click();
      }
      go();
    })();
    true;
  `;
}

// On a series page: opens the chapter-N link from its chapter list, or
// reports that it isn't listed on this page.
function openChapterFromListJs(n) {
  return `
    (function() {
      var tries = 0;
      var wanted = new RegExp('-chapter-${n}($|[^0-9.])');
      function go() {
        var links = [].slice.call(document.querySelectorAll('a[href*="-chapter-"]'));
        var link = links.filter(function (a) { return wanted.test(a.getAttribute('href')); })[0];
        if (link) { location.href = link.href; return; }
        if (++tries < 25) { setTimeout(go, 400); return; }
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'episodeMissing',
          message: links.length
            ? 'Chapter ${n} isn' + "'" + 't in the list on this page — pick it from the chapter list.'
            : "Couldn't find a chapter list on this page.",
        }));
      }
      go();
    })();
    true;
  `;
}

// On an episode page: checks episode N is in the episode list (items
// labelled "EP <number>"), or reports the latest one.
function checkEpisodeJs(n) {
  return `
    (function() {
      var tries = 0;
      function check() {
        var nums = [];
        [].slice.call(document.querySelectorAll('img[alt], button, [class*="pisode"]')).forEach(function (el) {
          var m = (el.getAttribute('alt') || el.textContent || '').trim().match(/^EP *([0-9]+)/i);
          if (m) nums.push(Number(m[1]));
        });
        if (!nums.length) {
          if (++tries < 25) setTimeout(check, 400);
          return;
        }
        var latest = Math.max.apply(null, nums);
        if (${n} > latest) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'episodeMissing',
            message: 'Episode ${n} isn' + "'" + 't out yet — episode ' + latest + ' is the latest.',
          }));
        }
      }
      check();
    })();
    true;
  `;
}

export const MEDIA_TYPES = {
  manga: {
    key: 'manga',
    label: 'Manga',
    // Labels shown for the status toggle/badge on this type's entries
    // ("Read" for manga; anime uses "Watched" further down). The stored
    // values are the same for every type — MyAnimeList's five statuses
    // ('reading', 'read', 'on_hold', 'dropped', 'want_to_read') — only
    // the wording changes.
    readStatusLabels: {
      reading: 'Reading',
      read: 'Read',
      on_hold: 'On Hold',
      dropped: 'Dropped',
      want: 'Want to Read',
    },
    // Set MANGA_SITE_URL in .env to the site you browse.
    startUrl: MANGA_SITE_URL,
    // Shows a Reverse button beside the code box (see ReverseSearch.js):
    // opens a reverse image search site where you pick a page image to
    // find which manga it's from. Set `url` to the search site you use.
    // Tapping a result whose link matches `resultRegex` opens that code
    // in this tab (needs buildUrlFromId below). resultRegex is optional
    // and defaults to this type's urlRegex, matched on any host — set it
    // if the search site links somewhere with a different URL structure.
    // Remove this block to hide the button.
    reverseSearch: {
      url: 'https://your-reverse-search.example.com',
      // resultRegex: /^https?:\/\/[^/]+\/title\/([a-z0-9]+)/i,
    },
    // Shows the "⬇ Save Page Image" button (the largest image on screen,
    // saved to the gallery). Manga only by default.
    savePageImage: true,
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
    // The chapter a reader page is on (whole chapters: 60.5 counts as 60),
    // or null on the series page. Opening a chapter sets the entry to
    // Reading and its chapters read (MediaWebView.js).
    extractProgress: (match) => (match[2] ? Math.floor(Number(match[2])) : null),
    // This site's pages don't show volume numbers, so volumes read can't be
    // kept up to date: after a chapter update the app says so, with a
    // 1-hour snooze (MediaWebView.js).
    promptForVolumes: true,
    // "Read next" (Library): chapter `n` comes after the last chapter page
    // you opened, via its Next button; without one (e.g. imported from
    // MAL), from the series page's chapter list.
    openNext: (entry, n) =>
      entry.last_progress_url
        ? { url: entry.last_progress_url, checkJs: clickNextChapterJs(n) }
        : { url: `${MANGA_SITE_URL}/title/${entry.source_id}`, checkJs: openChapterFromListJs(n) },
    // For titles not opened on the site yet (imported from MAL).
    buildSearchUrl: (title) => `${MANGA_SITE_URL}/browse?q=${encodeURIComponent(title)}`,
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
    // - malId: the number in the page's link to myanimelist.net/manga/<id>
    //   (used to export/import MyAnimeList lists, see malList.js)
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

          var malLink = document.querySelector('a[href*="myanimelist.net/manga/"]');
          var malMatch = malLink && malLink.href.match(/myanimelist[.]net[/]manga[/]([0-9]+)/);

          window.ReactNativeWebView.postMessage(JSON.stringify({
            imageUrl: imageUrl,
            title: title,
            altTitle: altTitle,
            author: names.join(', ') || null,
            malId: malMatch ? Number(malMatch[1]) : null,
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
    // "Watching"/"Watched" instead of manga's "Reading"/"Read" — same
    // stored values, just different wording per type.
    readStatusLabels: {
      reading: 'Watching',
      read: 'Watched',
      on_hold: 'On Hold',
      dropped: 'Dropped',
      want: 'Want to Watch',
    },
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
    // The episode an episode page is on (?ep=N), or null on the series
    // page. Opening an episode sets the entry to Watching and its
    // episodes watched (MediaWebView.js).
    extractProgress: (match, url) => {
      const ep = /\/watch\//.test(url) && url.match(/[?&]ep=(\d+)/);
      return ep ? Number(ep[1]) : null;
    },
    // "Watch next" (Library): opens episode `n` and checks it exists.
    openNext: (entry, n) => ({
      url: `${ANIME_SITE_URL}/watch/${entry.source_id}?ep=${n}`,
      checkJs: checkEpisodeJs(n),
    }),
    // For titles not opened on the site yet (imported from MAL).
    buildSearchUrl: (title) => `${ANIME_SITE_URL}/search?query=${encodeURIComponent(title)}`,
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
    // Title comes from the first piece of text in the page's <h1>
    // (usually the English title; some pages also put badges or a
    // summary inside the <h1>) and the thumbnail from og:image. og:title often holds the original/
    // romanized title instead, so it's saved as altTitle when it differs
    // (minus a leading "Watch "). Many anime sites are single-page apps
    // that swap the page client-side, so this waits until the <h1> is
    // there and og:url points at the series in the current URL before
    // reading anything — otherwise it could save the previous series'
    // details. No author for anime. malId comes from the page's link to
    // myanimelist.net/anime/<id> (see malList.js).
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

          var title = null;
          if (h1) {
            var walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
            var node;
            while ((node = walker.nextNode())) {
              if (node.textContent.trim()) {
                title = node.textContent.trim();
                break;
              }
            }
          }
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

          var malLink = document.querySelector('a[href*="myanimelist.net/anime/"]');
          var malMatch = malLink && malLink.href.match(/myanimelist[.]net[/]anime[/]([0-9]+)/);

          window.ReactNativeWebView.postMessage(JSON.stringify({
            imageUrl: imageUrl,
            title: title,
            altTitle: altTitle,
            author: null,
            malId: malMatch ? Number(malMatch[1]) : null,
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
