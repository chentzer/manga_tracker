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
const MANHWA_SITE_URL = extra.manhwaSiteUrl || 'https://your-manhwa-site.example.com';
const MANHWA_SITE_2_URL = extra.manhwaSite2Url || 'https://your-second-manhwa-site.example.com';

// "https://www.example.com/x" -> "example.com".
function hostOf(url) {
  const match = /^https?:\/\/(?:www\.)?([^/:]+)/i.exec(url);
  return match ? match[1].toLowerCase() : url;
}

// A hostname as a regular-expression fragment.
function hostPattern(url) {
  return hostOf(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MANHWA_HOST = hostOf(MANHWA_SITE_URL);
const MANHWA_HOST_2 = hostOf(MANHWA_SITE_2_URL);

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

// Reads a series on a Next.js comics site that embeds the series as JSON
// (<script id="__NEXT_DATA__"> -> props.pageProps.series: title,
// altTitles, author, artist, tags) with the cover as og:image. The site
// changes pages without reloading, which leaves that JSON stale, and
// chapter pages don't carry it, so the series page (/series/<id>) is
// fetched whenever the JSON on screen isn't for this series.
const NEXT_SERIES_READER_JS = `
  (function() {
    function send(p) { window.ReactNativeWebView.postMessage(JSON.stringify(p)); }
    function dataOf(doc) {
      var el = doc.getElementById('__NEXT_DATA__');
      try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; }
    }
    function list(value) {
      return [].concat(value || []).map(function(v) { return String(v).trim(); })
        .filter(Boolean).join(', ') || null;
    }
    function read(data, doc) {
      var series = data && data.props && data.props.pageProps && data.props.pageProps.series;
      if (!series) return send({ title: document.title || null });
      var og = doc.querySelector('meta[property="og:image"]');
      send({
        imageUrl: og ? og.content : null,
        title: series.title || null,
        altTitle: list(series.altTitles),
        author: list(series.author) || list(series.artist),
        genre: list(series.tags),
      });
    }
    var parts = location.pathname.split('/').filter(Boolean);
    var data = dataOf(document);
    if (data && data.query && String(data.query.id) === parts[1] && parts.length === 2) return read(data, document);
    fetch(location.origin + '/' + parts[0] + '/' + parts[1])
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        read(dataOf(doc), doc);
      })
      .catch(function() { send({ title: document.title || null }); });
  })();
  true;
`;

// Reads a series on a site using the common WordPress manga theme: title
// in .post-title h1 (minus its "HOT"/"END" badges) and labelled rows
// (.summary-heading + .summary-content), found by label so "Author(s)" and
// "Writer(s)" both count. On a chapter page the series page
// (/<section>/<slug>) is fetched and read instead.
const WP_MANGA_SERIES_READER_JS = `
  (function() {
    function send(p) { window.ReactNativeWebView.postMessage(JSON.stringify(p)); }
    function text(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
    function read(doc) {
      var fields = {};
      var headings = doc.querySelectorAll('.summary-heading');
      for (var i = 0; i < headings.length; i++) {
        var content = headings[i].parentElement && headings[i].parentElement.querySelector('.summary-content');
        var label = text(headings[i]).toLowerCase().replace(/\\(s\\)/g, '').replace(/:/g, '').trim();
        if (content) fields[label] = content;
      }
      function field(names) {
        for (var k = 0; k < names.length; k++) {
          var el = fields[names[k]];
          if (!el) continue;
          var links = el.querySelectorAll('a');
          var out = [];
          for (var n = 0; n < links.length; n++) if (text(links[n])) out.push(text(links[n]));
          var value = out.length ? out.join(', ') : text(el);
          if (value) return value;
        }
        return null;
      }
      var titleEl = doc.querySelector('.post-title h1');
      var title = null;
      if (titleEl) {
        var copy = titleEl.cloneNode(true);
        var badges = copy.querySelectorAll('.manga-title-badges');
        for (var b = 0; b < badges.length; b++) badges[b].parentNode.removeChild(badges[b]);
        title = text(copy) || null;
      }
      var og = doc.querySelector('meta[property="og:image"]');
      var img = doc.querySelector('.summary_image img');
      send({
        imageUrl: (og && og.content) || (img && (img.getAttribute('data-src') || img.getAttribute('src'))) || null,
        title: title || document.title || null,
        altTitle: field(['alternative', 'alt name']),
        author: field(['author', 'writer']) || field(['artist']),
        genre: field(['genre']),
      });
    }
    var parts = location.pathname.split('/').filter(Boolean);
    if (parts.length <= 2) return read(document);
    fetch(location.origin + '/' + parts[0] + '/' + parts[1])
      .then(function(r) { return r.text(); })
      .then(function(html) { read(new DOMParser().parseFromString(html, 'text/html')); })
      .catch(function() { send({ title: document.title || null }); });
  })();
  true;
`;

// Keeps a WordPress manga-theme site's Family Mode on (adult titles
// hidden), with no way to switch it off from the app. These sites turn
// Family Mode off with a "<name>-mature" cookie (e.g. for
// comics.example.com, "comics-mature") and filter on the server, so
// before every page loads this: removes that cookie (reloading once if it
// was there), stops the page from setting it again, and hides the Family
// Mode switch and the "I'm an adult" button.
function familyModeLockJs(siteUrl) {
  const host = hostOf(siteUrl);
  return `
    (function() {
      var host = ${JSON.stringify(host)};
      var here = location.hostname.replace(/^www\\./, '');
      if (here !== host && here.slice(-host.length - 1) !== '.' + host) return;
      var name = host.split('.')[0] + '-mature';
      var has = new RegExp('(^|;\\\\s*)' + name + '=').test(document.cookie);
      if (has) {
        document.cookie = name + '=; path=/; max-age=0';
        document.cookie = name + '=; path=/; domain=.' + host + '; max-age=0';
        // Reload once so the server sends the family version; never loop.
        var last = Number(sessionStorage.getItem('familyModeLockReload') || 0);
        if (Date.now() - last > 10000) {
          sessionStorage.setItem('familyModeLockReload', String(Date.now()));
          location.reload();
          return;
        }
      }
      try {
        var cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
        Object.defineProperty(document, 'cookie', {
          configurable: true,
          get: function() { return cookie.get.call(document); },
          set: function(value) {
            if (String(value).trim().indexOf(name + '=') === 0) return;
            cookie.set.call(document, value);
          },
        });
      } catch (e) {}
      var style = document.createElement('style');
      style.textContent = '[title="Toggle Family Mode"], .btn-adult-confirm { display: none !important; }';
      (document.head || document.documentElement).appendChild(style);
    })();
    true;
  `;
}

export const MEDIA_TYPES = {
  manga: {
    key: 'manga',
    label: 'Manga',
    // Books saved one by one (volumes, parts) can be put in a named group,
    // listed in each one's detail sheet (EntryList.js, src/groups.js).
    groupField: true,
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
    // Shows the "⬇ Save Page Image" button (the largest image on screen,
    // saved to the gallery). Manga only by default.
    savePageImage: true,
    // Example pattern: matches .../title/<id>-<slug> (series page) and
    // .../title/<id>-<slug>/<chapterId>-chapter-<n> (reader page) alike,
    // with or without the slug -> capture group 1 = the series id,
    // capture group 2 = the chapter number on reader pages. Adjust the
    // path segments to match your actual site's URLs.
    urlRegex: /^https?:\/\/[^/]+\/title\/([a-z0-9]+)(?:-[^/?#]*)?(?:\/\d+-chapter-([\d.]+))?/i,
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

  manhwa: {
    key: 'manhwa',
    label: 'Manhwa',
    readStatusLabels: {
      reading: 'Reading',
      read: 'Read',
      on_hold: 'On Hold',
      dropped: 'Dropped',
      want: 'Want to Read',
    },
    // Set MANHWA_SITE_URL and MANHWA_SITE_2_URL in .env.
    startUrl: MANHWA_SITE_URL,
    // Pop-ups and redirects can't leave the two sites.
    blockExternalNavigation: true,
    // The two sites' names (for the ▾ site list) and title search pages.
    titleSearch: [
      { name: MANHWA_HOST, buildSearchUrl: (q) => `${MANHWA_SITE_URL}/browse?search=${encodeURIComponent(q)}` },
      {
        name: MANHWA_HOST_2,
        buildSearchUrl: (q) => `${MANHWA_SITE_2_URL}/?s=${encodeURIComponent(q)}&post_type=wp-manga`,
      },
    ],
    // For titles not opened on a site yet (imported from MAL).
    buildSearchUrl: (title) => `${MANHWA_SITE_URL}/browse?search=${encodeURIComponent(title)}`,
    // First site: series at /series/<id>, chapters at /series/<id>/<key>
    // (no chapter number in the address, so progress isn't tracked there).
    // The code is the series id; on the second site it's the series slug,
    // which always has letters, so the two can't clash.
    urlRegex: new RegExp(`^https?://(?:www\\.)?${hostPattern(MANHWA_SITE_URL)}/series/(\\d+)`, 'i'),
    extractId: (match) => match[1],
    extractMetadataJs: NEXT_SERIES_READER_JS,
    // "Read next" (Library): from the last chapter you opened, its Next
    // button; otherwise the series page.
    openNext: (entry, n) =>
      entry.last_progress_url
        ? { url: entry.last_progress_url, checkJs: clickNextChapterJs(n) }
        : { url: entry.source_url },
    extraSources: [
      {
        name: MANHWA_HOST_2,
        domain: MANHWA_HOST_2,
        // Series at /serie/<slug>, chapters at /serie/<slug>/chapter-<n>.
        urlRegex: new RegExp(
          `^https?://(?:www\\.)?${hostPattern(MANHWA_SITE_2_URL)}/serie/([a-z0-9-]+)(?:/chapter-([\\d.]+))?`,
          'i'
        ),
        extractId: (match) => match[1],
        // Opening a chapter sets the entry to Reading and its chapters read.
        extractProgress: (match) => (match[2] ? Math.floor(Number(match[2])) : null),
        extractMetadataJs: WP_MANGA_SERIES_READER_JS,
        beforeLoadJs: familyModeLockJs(MANHWA_SITE_2_URL),
      },
    ],
  },

  anime: {
    key: 'anime',
    label: 'Anime',
    // Seasons, parts and films can be put in a named group (as Manga).
    groupField: true,
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
  //       buildSearchUrl: (code) => `https://site-a.example.com/search/${code}`,
  //       extractMetadataJs: `...`,
  //     },
  //     {
  //       name: 'Site B',
  //       domain: 'site-b.example.com',
  //       urlRegex: /.../,
  //       extractId: (match) => match[1],
  //       buildSearchUrl: (code) => `https://site-b.example.com/?s=${code}`,
  //       autoConfirmButtonText: 'Continue', // if this site has one
  //       extractMetadataJs: `...`,
  //     },
  //   ],
  // },
};

export const MEDIA_TYPE_LIST = Object.values(MEDIA_TYPES);
