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

export const MEDIA_TYPES = {
  manga: {
    key: 'manga',
    label: 'Manga',
    // Labels shown for the read-status toggle/badge on this type's
    // entries — "Read" makes sense for manga; video uses "Watched"
    // instead further down. The underlying stored value is always
    // 'read' or 'want_to_read' regardless of type; only the display
    // wording changes.
    readStatusLabels: { read: 'Read', want: 'Want to Read' },
    // Set this to the actual site you browse.
    startUrl: 'https://your-manga-site.example.com',
    // Example pattern: matches https://your-manga-site.example.com/title/12345/
    // (gallery page) and .../title/12345/1/ (reader page) alike -> capture
    // group 1 = "12345", capture group 2 = the page number when present
    // (e.g. "3" in .../title/12345/3/). Adjust the path segment ("title") and
    // structure to match your actual site's URLs.
    urlRegex: /^https?:\/\/[^/]+\/title\/(\d+)\/?(\d+)?/,
    // Reverse of urlRegex/extractId — turns a manga id typed in manually
    // into a real URL the webview can navigate to. Update the domain to
    // match startUrl above.
    buildUrlFromId: (id) => `https://your-manga-site.example.com/title/${id}/`,
    // Used by the "Save Page Image" feature to name the saved file as
    // "code -- page" (e.g. "12345 -- 3"). Returns null when the URL
    // didn't include a page number (e.g. the gallery page), in which
    // case the caller falls back to just the code.
    extractPageNumber: (match) => match[2] || null,
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
    // Title/thumbnail come from Open Graph meta tags (og:title, og:image)
    // where available — most sites set these for link-preview purposes,
    // and they're far more reliable than guessing at DOM elements (which
    // can easily grab a site logo instead of the actual cover). Falls
    // back to a titled <img> or <h1> if those meta tags are missing.
    //
    // Author/artist extraction below is written for a specific example
    // site structure (metadata fields as
    // <div class="info-row">Artists: <a><span class="name">X</span></a></div>)
    // — this WILL need adjusting to match your actual site's DOM. Inspect
    // the page (right-click the author's name → Inspect) and update the
    // getFieldValue selectors, or replace this section with a simple
    // querySelector for your site's author element.
    extractMetadataJs: `
      (function() {
        var ogTitle = document.querySelector('meta[property="og:title"]');
        var ogImage = document.querySelector('meta[property="og:image"]');

        function findTitledImage() {
          var imgs = document.querySelectorAll('img');
          for (var i = 0; i < imgs.length; i++) {
            if (imgs[i].alt && imgs[i].alt.trim().length > 0) return imgs[i];
          }
          return imgs[0] || null;
        }

        function getFieldValue(label) {
          var containers = document.querySelectorAll('.info-row');
          for (var i = 0; i < containers.length; i++) {
            if (containers[i].textContent.trim().indexOf(label) === 0) {
              var names = containers[i].querySelectorAll('.name');
              return Array.prototype.map
                .call(names, function (n) { return n.textContent.trim(); })
                .join(', ') || null;
            }
          }
          return null;
        }

        var author = getFieldValue('Artists') || getFieldValue('Groups');

        var title = (ogTitle && ogTitle.content) || null;
        var imageUrl = (ogImage && ogImage.content) || null;

        if (!title || !imageUrl) {
          var fallbackImg = findTitledImage();
          var h1 = document.querySelector('h1') || document.querySelector('.manga-title');
          if (!title) {
            title = (fallbackImg && fallbackImg.alt && fallbackImg.alt.trim())
              || (h1 ? h1.textContent.trim() : null);
          }
          if (!imageUrl && fallbackImg) {
            imageUrl = fallbackImg.src || null;
          }
        }

        window.ReactNativeWebView.postMessage(JSON.stringify({
          imageUrl: imageUrl,
          title: title,
          author: author,
        }));
      })();
      true;
    `,
  },

  video: {
    key: 'video',
    label: 'Videos',
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
    // Set this to the actual site you browse.
    startUrl: 'https://your-video-site.example.com',
    // Example pattern: matches your-video-site.example.com/watch?v=SOMETHING
    // (and any other query params before/after it) -> capture group 1 =
    // "SOMETHING". Adjust the param name ("v") to match your site.
    urlRegex: /[?&]v=([^&]+)/,
    extractId: (match) => decodeURIComponent(match[1]),
    // If your site sometimes shows a "Continue"/age-gate/ad interstitial
    // before the real page loads (a different URL than the final video,
    // so URL-pattern matching correctly ignores it — but extraction then
    // can't start until it's dismissed), uncomment this and set it to
    // the button's exact visible text. It gets auto-clicked the moment
    // it appears, rather than waiting on manual timing.
    // autoConfirmButtonText: 'Continue',
    // If the interstitial instead shows as a SAME-PAGE overlay on the
    // real video's own URL (rather than a separate pre-page), URL-
    // pattern matching alone can't tell "gate showing" apart from "gate
    // dismissed" — extraction would fire immediately and save
    // wrong/incomplete data regardless of the overlay. If auto-clicking
    // above isn't reliable for your site (e.g. you can't inspect the
    // exact button), this is the more robust fallback: list any
    // distinctive substring found in the URL while the gate is showing
    // (check the debug log's "Checking URL: ..." lines to find one) and
    // extraction will skip entirely rather than save bad data, waiting
    // for the next URL change once you're actually past it.
    // interstitialKeywords: ['some-marker-found-in-the-url'],
    // Title/thumbnail come primarily from Open Graph meta tags, since many
    // video sites don't populate <video poster> until playback actually
    // starts (video loads on demand) — og:image/og:title are set for link
    // previews and are available immediately on page load. The author
    // selector below is a generic guess and will likely need adjusting
    // to your site's actual DOM (inspect the uploader/channel name
    // element and swap in the right selector). It's also worth checking
    // whether the author element is present immediately on page load at
    // all — on some sites it loads in via a secondary request slightly
    // after the initial render, and can take even longer if the video
    // was reached via an autoplay/"up next" transition rather than a
    // fresh page load (some sites swap the video client-side without a
    // full navigation, in which case even the meta tags can lag).
    // Everything is re-read fresh on every retry — not just the author
    // — so a late-arriving page update is reflected in the
    // title/thumbnail too, not just whether the author was eventually
    // found.
    extractMetadataJs: `
      (function() {
        var attempts = 0;
        function trySend() {
          var ogTitle = document.querySelector('meta[property="og:title"]');
          var ogImage = document.querySelector('meta[property="og:image"]');
          var video = document.querySelector('video');
          var authorEl = document.querySelector('.uploader a') || document.querySelector('[itemprop="author"]');

          var title = (ogTitle && ogTitle.content) || document.title || null;
          var imageUrl = (ogImage && ogImage.content) || (video && video.poster) || null;
          var author = authorEl ? authorEl.textContent.trim() : null;

          attempts++;
          if (!author && attempts < 10) {
            setTimeout(trySend, 300);
            return;
          }

          window.ReactNativeWebView.postMessage(JSON.stringify({
            imageUrl: imageUrl,
            title: title,
            author: author,
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
