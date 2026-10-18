# Manga Tracker

Records an entry (name = extracted ID, cover = thumbnail image) whenever you
browse to a matching URL in one of the app's two built-in webview tabs:
manga and anime. No duplicate entries per type. Optional Google Drive backup
of covers, organized into per-type subfolders.

This is a **configurable template**, not tied to any specific website —
`src/mediaTypes.js` ships with two working examples (a manga-gallery
pattern and an anime-streaming pattern). The sites themselves come from
your local `.env`, so they never end up in the repo; see "Before you run
it" below.

## Setup

```bash
npm install
npx expo install --fix
npx expo start
```

`expo install --fix` checks every installed package against the pinned
Expo SDK and corrects any that are mismatched — run this any time you see
version-related errors (Flow syntax errors, "Unable to resolve module",
etc.) or after bumping the `expo` version in `package.json`.

If you're recovering from a broken install (mismatched React/React Native,
missing modules), do a clean reinstall first:

```bash
rmdir /s /q node_modules   # Windows; use rm -rf node_modules on Mac/Linux
del package-lock.json      # Windows; use rm package-lock.json on Mac/Linux
npm install
npx expo install --fix
npx expo start -c          # -c clears the Metro bundler cache
```

**Expo version note:** this project is on Expo SDK 57 (React Native
0.86). Expo Go only runs the SDK it was built for, and the app uses native
modules Expo Go doesn't have (Google sign-in, sharing into the Notepad), so
build it with `eas build` (or `npx expo run:android`) rather than relying on
Expo Go. If Expo Go shows "failed to download remote update", its SDK
doesn't match the project's; check [expo.dev/go](https://expo.dev/go).

Requires the Expo Go app on your phone (or an iOS/Android simulator) to run
during development. Scan the QR code from `expo start`.

## Before you run it

Everything type-specific lives in **`src/mediaTypes.js`**. The two entries
in there (`manga`, `anime`) are working *examples*, not tied to any
specific site — the URL patterns/selectors are starting points you'll
adapt to whatever you actually use:

1. **Your sites, in `.env`** — copy `.env.example` to `.env` (git-ignored,
   never committed) and set `MANGA_SITE_URL` and `ANIME_SITE_URL` to the
   sites each tab should open, without a trailing slash. The Manga tab
   has a second site too, `MANGA_SITE_2_URL`, in its ▾ site list. `app.config.js`
   passes them to `mediaTypes.js`; without them the tabs open the
   placeholder `*.example.com` domains. Restart `expo start` after
   changing `.env`.
2. **`urlRegex`** for each type — the examples match:
   - manga, first site: `/manga/<id>` (series page) or `/chapter/<id>`
     (reader page, with the chapter's own id). A chapter's address doesn't
     say which series it's from, so its script finds the series from the
     page's link back to it and the chapter number from the page title
     ("Ch. 87" or "Chapter 87"), and reports both with its own page
     address (`seriesFromPage`) — so the answer still counts if you've
     moved on before the slow page finished; either way every chapter of
     a series is one entry
   - manga, second site (`extraSources`): `/title/<id>-<slug>` (series
     page) or `/title/<id>-<slug>/<chapterId>-chapter-<n>` (reader page)
   - anime: `/watch/<id>/...` (episode page) or `/info/<id>/...` (series
     page) in the path, so every episode of a series is one entry
   Confirm these against your real site's actual URL structure and adjust
   the pattern (path segment names, query param names) as needed.
3. **`extractMetadataJs`** for each type — grabs the cover image, title,
   alternate title and author in one shot. Both examples use generic
   selectors (the page's `<h1>`, a "poster" image, `og:` meta tags, links
   into the site's author search) that suit many sites; if yours differs,
   inspect the real page (right-click the element → Inspect) and swap in
   the right selector. The first manga site's script fetches the series
   page (server-rendered) from either kind of page: title in `<h1>`, the
   cover `<img>` whose alt is the title, author/artist search links and
   the MyAnimeList link. The second site only records from the series
   page: its reader pages don't show the cover or author, so its script
   posts `{ skip: '…' }` there and nothing is saved from that page.
   The anime script takes the cover from the page's AniList cover (the
   `<img>` for the id in its anilist.co link) before `og:image`: a title
   opened from inside the site (e.g. its search results) can still carry
   the previous page's `og:` tags, so those are only used once `og:url`
   names this title.
4. **Manhwa sites, in `.env`** — `MANHWA_SITE_URL` and `MANHWA_SITE_2_URL`.
   The ▾ site list at the top of the tab switches between them. The first
   is expected to be a Next.js comics site (series at `/series/<id>`,
   details in its `__NEXT_DATA__` JSON, search at `/browse?search=`); the
   second a site on the common WordPress manga theme (series at
   `/serie/<slug>`, chapters at `/serie/<slug>/chapter-<n>`, search at
   `/?s=…&post_type=wp-manga`). A series is saved when you open it or any
   of its chapters. The second site's **Family Mode stays on**: before
   each page loads, `familyModeLockJs` removes its `<name>-mature` cookie,
   stops the page from setting it, and hides the Family Mode switch and
   the "I'm an adult" button. Adjust the paths in `mediaTypes.js` if your
   sites differ.
5. **Google Drive setup (for cloud sync — walkthrough below).**

## Setting up Google Drive sync (step by step)

This is the part that needs real setup before Settings → Google Drive → Connect in the app
will work. Client IDs live in a local `.env` file (git-ignored — never
committed) rather than in the config itself, so your real values never
end up in version control.

Sign-in uses Google's native Sign-In SDK
(`@react-native-google-signin/google-signin`), not a browser redirect.
Expo's own `expo-auth-session` no longer reliably supports Google
sign-in — Google's mobile OAuth policies tightened over time to the
point where the generic browser-redirect flow that library used gets
rejected outright, and Expo has said they no longer maintain Google
auth support in it. The native SDK sidesteps this: no browser, no
redirect URI to register, just the platform's native account picker.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and
   create a new project (or pick an existing one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (unless you have a Google Workspace org).
   - Fill in app name (e.g. "Manga Tracker"), your email for support/contact.
   - Scopes: you don't need to add `drive.file` here manually — it's
     requested at sign-in time by the app.
   - Under **Test users**, add your own Google account email. While the
     app is unpublished/in testing, only accounts listed here can sign in
     — this is fine and expected for a personal app; you don't need to
     submit for Google's verification review.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Create one of type **Android**: package name from `app.config.js`
     (`com.chentzer.mangatracker` — change this to your own reverse-domain
     identifier first) and your app's SHA-1 signing certificate
     fingerprint — get this with `eas credentials` (select Android, then
     view the keystore). This client isn't referenced directly in code,
     but Google still requires it to exist and match, since it's how the
     native SDK verifies your app's identity.
   - Create one of type **Web application** — no redirect URI needed
     here. This is the ID the app actually uses at runtime.
5. Copy `.env.example` to `.env`, and paste the Web client ID into
   `GOOGLE_CLIENT_ID_WEB` there.
6. Since this uses a native module, it needs a real build — this won't
   work in Expo Go. Build with `eas build`, install the resulting APK,
   then tap ⚙️ (top right) → **Google Drive → Connect** in that installed app. It always merges in
   anything from Drive first, then backs up — see "What gets backed up"
   below for exactly why that ordering matters.

Once connected, no further setup is needed — see "What gets backed up"
below for what happens automatically after that.

## What gets backed up

Two separate things sync to Drive once connected, both automatic:

- **Cover images** — uploaded per entry, organized into
  `MangaTracker/manga/` and `MangaTracker/anime/` folders, right after
  each entry is saved. Filenames follow `code - title.jpg` (e.g.
  `12345 - Some Manga Title.jpg`), falling back to just the code if no
  title was extracted.
- **Full entry data** — every entry's `media_type`, `source_id`, `title`,
  `alt_title`, `author`, `score`, `tags`, `read_status`, `source_url`,
  `sync_status`, `created_at`, `mal_id`, `mal_data` and the MyAnimeList
  fields (`start_date`, `finish_date`, `progress`, `progress_volumes`,
  `total`, `total_volumes`, `times_repeated`, `repeating`, `priority`,
  `comments`, `series_type`), `genres`, `is_adult`, `mal_conflicts` and
  `last_progress_url`, written to a separate CSV file **per
  media type** — `MangaTracker/manga-backup.csv`,
  `MangaTracker/anime-backup.csv`, etc — rather than one combined file,
  so each type's data stays easy to open/browse individually. Favourite
  artists (the Library's Artists view) go to `MangaTracker/favorite-artists.csv`;
  for each artist, whichever side changed it more recently wins. Each file
  is overwritten in place — not a growing pile of dated backups — and
  refreshes automatically after every new entry or rating change, plus
  on demand via **Backup Now** in Settings (⚙️, top right).

If your phone is lost or reset, install the app fresh and tap **Settings
→ Google Drive → Connect** — it pulls each type's CSV back down and re-adds every entry not
already on the device (including re-downloading cover images where
available)
*before* ever writing anything back to Drive. This ordering is
unconditional and automatic: **Connect always restores first, then
backs up** — regardless of whether the local library is empty, has a few
entries, or is way behind what's in Drive, connecting can never overwrite
Drive with less data than it already had. There's also a standalone
**Restore** button (next to Backup Now in Settings) for re-checking Drive at any
later point, e.g. after adding entries on a second device — existing
local entries are never touched or overwritten by either path, only
added to.

## MyAnimeList export / import

**Settings → MyAnimeList** (⚙️, top right) has **⬆ Export Manga**,
**⬆ Export Anime** and **⬇ Import MAL list**, which work with
MyAnimeList (MAL) list files, in the same XML format MAL's own "Export
My List" produces and its import page accepts. Code: `src/malList.js`
(files) and `src/malFormat.js` (the format and how it maps onto an entry).

Entries hold the same details a MAL list does, all editable in the
detail sheet:

| In the app | MAL field |
|---|---|
| Status (5) | `my_status` |
| Score 1–10 (MAL's wording: 10 Masterpiece … 1 Appalling) | `my_score` |
| Episodes / chapters, of a total | `my_watched_episodes` / `my_read_chapters`, `series_episodes` / `manga_chapters` |
| Volumes, of a total (manga) | `my_read_volumes`, `manga_volumes` |
| Start / finish date (`YYYY-MM-DD`, `00` for an unknown month or day) | `my_start_date`, `my_finish_date` |
| Times rewatched / reread, and rewatching / rereading now | `my_times_watched` / `my_times_read`, `my_rewatching` / `my_rereading` |
| Priority (Low / Medium / High) | `my_priority` |
| Tags, comments | `my_tags`, `my_comments` |
| Series type (anime, e.g. TV / Movie; shown, not edited) | `series_type` |

Like on MAL, setting a status to Reading/Watching fills in an empty
start date with today, and Read/Watched (Completed) fills in an empty
finish date and sets progress to the total when the total is known.

- **MAL ids.** Every entry can carry its MAL id (`mal_id`). Entries you
  record by browsing get it from the page's link to `myanimelist.net`
  (see `extractMetadataJs` in `mediaTypes.js`). Entries recorded before
  this existed pick it up the next time you open them in their tab.
- **Two lists, like MAL.** MAL has an anime list and a manga list. In the
  app, Manhwa keeps its own tab and Library section; MAL only sees it as
  part of the manga list: **Export → Manga** includes your manhwa, and
  importing a manga list matches against Manga and Manhwa entries alike.
  New titles from a manga list are sorted by AniList's country of origin
  (looked up by MAL id): Korean ones go to Manhwa, the rest to Manga.
  Titles imported before this sorting existed move to Manhwa on your
  next import, if they haven't been opened on a site yet. Imported
  titles also keep AniList's English title as their alternate title, so
  opening one on a site without MAL links (the Manhwa sites) finds it by
  name instead of adding it twice. Without AniList (offline), the import
  still runs and everything from the manga list goes to Manga.
- **Export** writes one list, `mangalist.xml` or `animelist.xml`
  (whichever button you tapped). It
  opens the share sheet (save it to Files, send it, ...) and, when Drive
  is connected, saves it to the `MangaTracker` folder on Drive,
  replacing the previous export there. Entries without a MAL id are left
  out (the summary says how many). The file's user name and id come from
  the last list you imported.
- **Hentai is left out of exports** (ecchi stays). Genres come from
  AniList's API (`graphql.anilist.co`), looked up by MAL id, 50 titles
  per request, and kept on the entry (`genres`, `is_adult`). A title
  counts as hentai when AniList marks it adult or lists the Hentai
  genre. If AniList can't be reached, the export stops rather than risk
  including one.
- **Totals from AniList.** The same lookup fills in total episodes
  (anime) or chapters and volumes (manga) where an entry has none yet —
  when a title first gets its MAL id while browsing, and before each
  export. A total you set, or one from MAL, is never replaced. Series
  still airing or publishing have no total yet; they're asked about
  again at most once a day (`anilist_checked`).
- **Import** takes a MAL export (`.xml`, or the `.xml.gz` MAL gives you)
  and adds every title that isn't in the library yet, matched by MAL id
  and then by title. A title that's already there gets the MAL details it
  doesn't have yet. **Where both have a value and they differ** (status,
  score, progress, dates, ...), nothing in the app is overwritten: the
  entry gets a ⚠ badge, the **⚠ To review** chip lists them, and its
  detail sheet shows each difference with the app's and MAL's value
  side by side — tap the one to keep, or change the detail yourself
  further down (that settles it too). Added titles have no site page
  yet: their code is `mal-<id>` and their link goes to MyAnimeList. The
  first time you open that title on the site, the entry becomes a normal
  one (site code, link, cover and author) and keeps everything from MAL;
  the site's cover replaces the imported one (kept if the site has none).
- **Covers.** After an import, every title on that list with no cover
  gets AniList's (same lookup as above, `coverImage.large`), four
  downloads at a time, saved like covers from browsing
  (`<type>-covers/<code>.jpg`) and backed up to Drive. The import's
  summary shows right away; covers keep going in the background, and the
  Library refreshes when they're done. A Drive restore brings these
  covers back too.
- **Data reminder.** Import asks first: it looks every title up and
  downloads covers (about 0.1 MB a title), so Wi-Fi is recommended; it
  says so when you're on mobile data.
- **Progress** shows in the status pill beside ⚙️ as **Import** (the
  AniList lookups, the import, then each cover and its upload), ending
  with "✓ Imported N", or "✓ N/M covers" when some covers failed. A title linked by title only gets the MAL
  details it doesn't have yet; what you set in the app stays.
- **Nothing is lost on the way through.** MAL fields without a column of
  their own (`my_id`, storage, ...) are kept as JSON in `mal_data`, so
  exporting an unchanged import gives back the same file.
- **Statuses** are MAL's five: Reading/Watching, Read/Watched
  (Completed), On Hold, Dropped and Want to Read/Watch (Plan to ...). An
  entry with no status exports as Plan to Read/Watch.
- **Scores** used to be 1–5 stars. On the first start after the update,
  existing scores are doubled (★4 → 8), entries imported from MAL get
  their exact MAL score back (unless re-rated in the app since), and a
  Drive backup from before the change is doubled when restored.

## Progress while browsing, Watch next and Random

- **Opening a series page** records it as Plan to Read/Watch (it used to
  be Read/Watched).
- **Opening an episode or chapter** (`extractProgress` in
  `mediaTypes.js`: `?ep=N` on anime episode pages, `-chapter-N` on manga
  reader pages) sets the series to Reading/Watching, fills an empty start
  date with today, and sets episodes/chapters to that number. Progress
  only moves forward, so opening an earlier episode again doesn't lower
  it. A chapter 0 (prologue or one-shot) counts too; when it's the whole
  title (a total of 1 chapter), it counts as chapter 1.
- **Ahead of your record.** Opening an episode more than one past your
  record (it says 4, you open 7) asks first: **Go to episode 5** (the
  next one after your record), **Record 7**, or **Keep 4**. A series
  recorded for the first time from that page isn't asked about.
- **Rewatching / rereading.** Opening an episode of a Completed series
  asks whether you're starting a rewatch (**Just looking** stops asking
  about that series for an hour). While rewatching, the status stays
  Completed (as on MAL), the Rewatching switch is on, and a separate
  rewatch position (`repeat_progress`; MAL's `my_rewatching_ep` for
  anime) moves forward as you watch, so your progress stays at the full
  count. Opening the last episode (when the total is known) finishes it:
  times rewatched goes up by one and the switch turns off. Turning the
  switch off yourself asks whether to count it as a finished rewatch.
- **Volumes (manga).** The manga site's pages don't show volume numbers,
  so after each chapter update a box says volumes read wasn't changed,
  with **Edit** (opens the entry in the Library) and **Snooze 1 hour**
  (no more of these boxes for an hour). Set by `promptForVolumes`.
- **▶ Watch ep N / Read ch N** in the detail sheet opens the episode or
  chapter after your progress (during a rewatch, after the rewatch
  position: **▶ Rewatch ep N**) in its tab (`openNext` in `mediaTypes.js`).
  On a Completed series it just says it's completed.
  Anime opens episode N directly and then checks the page's episode list;
  manga reopens the last chapter page you read and presses its Next
  button (or, with no last chapter, opens chapter N from the series
  page's list). If it doesn't exist yet, a box says so (e.g. "Episode 5
  isn't out yet — episode 4 is the latest"). Titles imported from MAL
  that haven't been opened on the site offer a site search instead.
- **🎲 Random** (the button at the top of the Library) picks one entry by
  category (Manga / Manhwa / Anime), status (Read/Watched, Want to
  Read/Watch, Reading/Watching) and rating (♥ Favourite, ★10 … ★6, ★1–5,
  No score). Each row takes any number of choices, and **Any** (none
  chosen) is where every row starts each time the window opens. It opens
  the pick's details, where ▶ Watch/Read takes you to the next
  episode/chapter and **🎲 Pick again** picks another. Picks don't repeat
  until every match has been shown.
- **♥ Favourites** — the ♥ button in an entry's details marks it as a
  favourite (♥ on its Library row; stored as `favorite`, backed up with
  the rest). The Filters' score row has **♥ Favourites** to show only
  those.

## Name vs. dedup key

Two different things are tracked per entry, on purpose:

- **`source_id`** — the ID pulled straight from the URL (manga id, anime
  id). This is what dedup is based on — it's guaranteed unique on
  the source site, unlike titles.
- **`title`** — what's actually displayed in the library. Titles can be
  missing (if extraction fails or the page hasn't finished loading), or
  two different items could coincidentally share one, so they're never
  used for the duplicate check — only `source_id` is.
- **`author`** — shown as a subtitle under the title in the library, when
  the extraction found one.

If `title` comes back empty, the library falls back to showing `source_id`
so nothing renders blank.

## How it works

- `src/mediaTypes.js` — config-driven definition of each trackable type
  (URL pattern, ID extraction, thumbnail-capture JS, start URL). Adding a
  third type (e.g. articles) means adding one entry here — no other file
  needs to change.
- `src/MediaWebView.js` — one generic webview component parameterized by a
  media type config; used for both the manga and anime tabs. Detects URL
  matches two ways: native navigation events, and a polling script injected
  into the page (`URL_WATCHER_JS`) that catches single-page-app sites which
  change the URL via `history.pushState` without a full reload — native
  navigation events don't fire for those. Whenever the current page
  corresponds to an entry already in the library, a **View in Library**
  button appears — tapping it (via the `onViewInLibrary` prop from
  App.js) switches to the Library tab and opens that exact entry's
  detail sheet directly, clearing any active filters that might
  otherwise hide it, rather than leaving you to find it in the list
  yourself. A "Save Page Image" button (types with
  `savePageImage: true` only — Manga in the example)
  grabs the largest currently-rendered image on the page (not necessarily
  the cover — whatever's actually on screen) and saves it to the tab's
  gallery folder (`Pictures/Manga Tracker/<tab>/`, `src/gallery.js`), named `code -- page`
  (e.g. `abc12 -- ch60`) using the current URL matched against the type's
  `urlRegex`/`extractPageNumber` — falls back to a timestamp if the
  current page doesn't match the pattern at all. Accepts a
  `showDebugTools` prop (from App.js's Settings sheet) that reveals a
  **Capture HTML** button (grabs the current page's rendered HTML into a
  selectable text box, for cases where the real page — with its actual
  User-Agent — differs from what PC-based inspection/emulation shows)
  and the debug log bar; both are hidden by default to keep the normal
  UI clean, and reappear instantly with no rebuild needed once the
  Settings toggle is flipped. The Android hardware
  back button navigates the open tab's own history (previous page,
  previous search); once there's nowhere left to go back to (or on the
  Library), it asks **Exit app?** instead of closing the app outright.
  App.js owns the one back handler and calls the open tab's
  `goBackIfPossible()` (exposed via ref), since every loaded tab's
  webview stays mounted. Every URL checked is logged
  as "Checking URL: ..." regardless of whether it matches anything —
  useful for finding a distinctive marker in an interstitial's real URL
  (see `interstitialKeywords` below), since this webview has no visible
  address bar to check directly on-device. A media type can opt into
  `autoConfirmButtonText` (see `mediaTypes.js`) for sites that show a
  "Continue"/age-gate/ad interstitial before the real page loads — a
  genuinely separate interstitial page (a different URL than the final
  content, which URL-pattern matching already correctly ignores, but
  extraction can't start until it's dismissed). Rather than waiting on a
  human to notice and click through (which was producing wrong/stale
  title-thumbnail-author data, since the page was often still
  mid-transition by the time extraction ran), this auto-clicks any
  button/link whose visible text exactly matches the configured string
  the moment it appears. If the interstitial instead shows as a
  same-page overlay on the real content's own URL — so URL-pattern
  matching can't tell "gate showing" apart from "gate dismissed", and
  auto-clicking isn't reliable (e.g. the exact button text/element
  couldn't be confirmed via inspection) — `interstitialKeywords` (an
  array of substrings) is the more robust fallback: if any of them
  appear in the URL, extraction is skipped entirely rather than saving
  bad data, waiting for a subsequent URL change once you're actually
  past it. Also supports an opt-in `blockExternalNavigation`
  flag for sites with popup/redirect ads — rather than trying to detect
  and dismiss a popup after it opens, `onShouldStartLoadWithRequest`
  rejects any navigation attempt to a domain other than the site's own
  before it ever loads, which covers `window.open` popups, redirects,
  and hijacks alike regardless of the exact mechanism the ad uses.
  Domain-blocking alone can miss a same-domain ad-redirect endpoint some
  sites run specifically to defeat it (technically the same domain, so
  it passes, even though its whole purpose is hijacking the page into
  an ad) — an optional `blockedUrlPatterns` (array of regexes, see
  `mediaTypes.js`) is checked regardless of domain to catch these.
  `setSupportMultipleWindows={false}` is also set unconditionally as a
  light extra defense against popups specifically. `allowsFullscreenVideo`,
  `allowsInlineMediaPlayback`, and `mediaPlaybackRequiresUserAction={false}`
  are also set unconditionally — without the first one specifically, the
  fullscreen button on an HTML5 `<video>` player does nothing at all on
  Android, since WebView doesn't support the browser Fullscreen API for
  video by default. A media type can also set an optional `userAgent`
  (see `mediaTypes.js`) for sites that stop video playback shortly after
  it starts — some streaming sites detect Android WebView's default
  User-Agent (which includes a "wv" marker) and specifically block it;
  spoofing a plain mobile Chrome UA avoids that. An optional
  `doubleTapSeekSeconds` enables double-tap-to-seek on any `<video>`
  element — left half rewinds, right half fast-forwards, YouTube-style
  — via `buildDoubleTapSeekJs()`; harmless to leave on a type with no
  video (nothing for a click to land on). Listens at the `document`
  level rather than attaching directly to `<video>` — most players wrap
  the raw element in their own overlay/controls layer that intercepts
  clicks before they'd ever reach it directly, which was the actual
  cause of double-tap seeming to do nothing at all on at least one real
  player. A click's position is checked against the nearest `<video>`'s
  bounding box to figure out which one (if any) it landed on, and which
  half. Seek detection itself
  uses plain `click` events with manual timing rather than native
  `dblclick`. Some players bind their own native double-click handler
  (commonly for fullscreen — confirmed as a real conflict on at least
  one site), which fires as a genuinely separate event alongside the
  click-based detection above and would otherwise seek AND toggle
  fullscreen at once; a second `document`-level listener specifically
  for `dblclick`, in the capturing phase, calls `stopPropagation()` to
  intercept it before the player's own handler ever sees it — capture
  runs before a bubble-phase listener further down the tree (which is
  how a player's own handler is presumably attached). Before requesting
  photo library permission for "Save Page Image", it calls
  `suppressNextRelock()` (see `src/relockGuard.js`) — the native
  permission dialog briefly registers as the app going "inactive" in
  AppState, which `AppLock` would otherwise treat exactly like leaving
  the app and force a re-unlock immediately after saving an image.
  Supports multi-source types (a `sources` array instead of top-level
  `urlRegex`/`extractId`/`extractMetadataJs` — see `mediaTypes.js`'s
  commented example) for a category where several sites carry
  overlapping-but-not-identical catalogs: `resolveSource()` checks each
  source's `urlRegex` in turn to figure out which site a URL belongs to
  and use that source's own extraction logic — `getAllowedDomains()` and
  `getDomainButtonMap()` generalize the popup-blocking and
  auto-confirm-interstitial features the same way, so those still work
  correctly across every source rather than assuming a single site.
- `src/relockGuard.js` — a tiny shared module letting any action mark an
  upcoming AppState transition as benign for a few seconds, so
  `AppLock.js`'s re-lock-on-resume logic doesn't fire for things like a
  native permission dialog or system picker that aren't actually someone
  leaving the app.
- `src/db.js` — SQLite storage. Entries are unique per `(name, media_type)`
  pair, enforced by the database itself, not just app logic — so a manga ID
  and an anime ID can't collide, but the same id within one type always is.
  `alt_title` holds an optional secondary title in another language/script
  (e.g. an original Japanese title alongside a translated English one) —
  populated via `extractMetadataJs`'s optional `altTitle` field, shown
  italicized under the main title in the Library. Also has a generic
  `settings` key-value table (`getSetting()`/`setSetting()`) — small app
  preferences like the debug-tools toggle aren't worth a whole separate
  storage mechanism when SQLite is already here.
- `src/GoogleDriveService.js` — native Google Sign-In (no browser
  redirect) + multipart upload, organized
  into `MangaTracker/manga/` and `MangaTracker/anime/` folders in Drive.
  Also handles the CSV data backup file (`backupCsvToDrive`) and exposes
  `isDriveConnected()` so other modules can trigger backups opportunistically.
  `fetchBackupCsvContent()` and `downloadCoverForRestore()` support pulling
  data back down from Drive for the restore feature below. `getToken()`
  serializes concurrent calls into a single shared in-flight promise —
  `GoogleSignin.getTokens()` throws ("previous promise did not settle
  and was overwritten") if a second call fires before the first
  resolves, which is exactly what happened every time an entry was
  saved: the CSV backup and the per-image Drive upload both fire at
  nearly the same moment, and both independently need a token. This was
  the actual cause of auto-backup silently failing while manual Backup
  Now worked fine (the manual path only ever does one token-needing
  operation at a time, so it never raced).
- `src/backup.js` — builds one CSV per media type (`entriesToCsv(mediaType)`,
  filenamed `${mediaType}-backup.csv` via `backupFileNameFor()`) and calls
  `maybeBackupLibraryToDrive()`, which loops over every type and returns
  `{ attempted, success, error }` rather than swallowing failures silently
  — a no-op result
  when Drive isn't connected, otherwise callers can actually tell a
  failed backup apart from nothing having happened. This is what powers
  the debug-log line in `MediaWebView.js` ("Auto-backup: ..." /
  "Auto-backup FAILED: ...") and the failure-only alert in
  `EntryList.js` (`backupSilently()` — silent on success, since a popup
  after every single rating tap would be unbearable, but never silent on
  a genuine failure). Called after every save (`MediaWebView.js`) and
  every rating/tag/status/delete change (`EntryList.js`) so the backup
  stays current without any manual step. Also exports
  `uploadPendingImages()`, which catches up cover images for any entry
  that was recorded *before* Drive got connected — per-entry image
  uploads only ever fire at the moment that entry is first saved, so
  anything recorded earlier needs this backfill. Runs automatically on
  first connect and on every "Backup Now" tap. `restoreFromDriveBackup()`
  is the reverse direction — downloads each type's own Drive CSV in turn,
  parses it (a small
  hand-written parser, since a title or URL could contain a comma inside
  quotes that a naive `split(',')` would mangle), and inserts any entry
  not already present locally via `INSERT OR IGNORE`, so existing local
  entries are never touched or overwritten. For each restored entry it
  also tries to re-download a matching cover image from Drive's
  `manga`/`anime` subfolder by filename prefix — if none is found, the
  entry still restores, just without a thumbnail until you browse back
  to that page. Triggered from the **Restore** button in Settings → Google
  Drive (only shown once Drive is connected), and automatically before
  every backup on Connect (see "What gets backed up" above). The
  Library reloads afterwards (`reloadKey`), even if it's the open tab.
- **Site list** (`getTabSites()` in `MediaWebView.js`) — tabs with more
  than one site (Manga, Manhwa) have a ▾ button at the top left of the tab,
  named after the site you're on, opening a menu of the tab's sites.
  Picking one opens its home page.
- **Groups (Manga, Anime)** — `groupField` in mediaTypes.js,
  `src/groups.js`. Entries saved one by one (volumes, parts, seasons) can
  be put in a named group from the detail sheet: **Add to a group…**
  picks an existing group or creates one with the name you type, and a
  chip suggests one from the title ("Summer Days 4" goes with "Summer
  Days", or makes a new group with the other parts already saved). In a
  group the sheet shows its name (**Rename** renames it for every entry)
  and every entry in it, which open with a tap and reorder with ▲ / ▼,
  plus **+ Add more** (search the type) and **Remove this from group**.
  The Library row shows the group's name. Stored as `group_name` /
  `group_order`, both in the Drive backup.
- **Hold to save a picture** (`src/imageHold.js`) — on any browsing tab,
  hold a finger on a picture for about half a second (without moving) and
  the app asks to save it to the tab's gallery folder. It finds the picture under
  the finger even behind a see-through layer (a full-screen viewer), and
  also takes a video's poster or a background picture; small icons are
  skipped. Saved as `<code>_<time>` on a title's page, else `<site>_<time>`.
- **Gallery folders** (`src/gallery.js`) — everything the app saves goes
  into `Pictures/Manga Tracker/`, one folder per tab (e.g.
  `Pictures/Manga Tracker/Manga/`), instead of loose in the camera roll.
- **Screenshot filing** (`src/screenshots.js`) — a phone screenshot taken
  in the app is moved into that tab's gallery folder (the Library's go in
  `Pictures/Manga Tracker/` itself), named after what's on screen:
  `<code>--<page>_<title>` while reading, `<time>_<code>_<title>` while
  watching (the video's position, e.g. `12m34s`). Android can't save a
  screenshot anywhere else, so the app finds the one it just saved, copies
  it into the folder and removes the original — Android asks before each
  removal unless **Settings → Delete screenshots without asking** (Media
  management access, Android 12+) is on. Needs full photo access, asked
  for once; without it screenshots stay where Android put them.
- **Block ads** (`src/adBlock.js`, Settings → App, on by default) — pages
  on known ad networks never open, and in each page pop-ups that open
  without a tap, ad scripts/frames/images, the page's requests to ad
  networks, links to them and the usual ad boxes are blocked or hidden.
  Frames from other sites can still show their own ads; the debug log
  lists what was blocked.
- **Videos pause** when you switch to another tab or leave the app, so
  nothing plays where you can't see it; they resume from the same spot.
- **Hidden from Recents** (`withHideFromRecents.js`, Android 13+) — while
  App lock is on, the app's content doesn't show in the recent-apps
  preview, while screenshots still work (Android's usual way,
  FLAG_SECURE, would block both). With App lock off, Recents shows the
  app as usual. `src/AppLock.js` keeps a `hide-from-recents` file in the
  app's files folder while the lock is on, and MainActivity checks it
  when it starts and each time you leave the app.
- **Whole search kept in the search box** — some search pages write the
  search back into their box cut short (e.g. "under observation: ..."
  shows as "under"), so searching again from there would lose the rest;
  the first Manhwa site's search page gets the whole search from its
  address put back (`keepWholeSearchJs` in `src/mediaTypes.js`). That
  site's box also only filters the page and ignores the address, so the
  search is typed into it the way the page's own script sees it, and set
  again for a few seconds in case the page redraws the box (until you
  type or tap). This is what makes searches from the Library (e.g. **Read
  ch 1** on a title imported from MyAnimeList) show their results there.
- **No NSFW titles** — a title isn't recorded when it's 18+: the site's
  own genres include Hentai, Adult, Smut, 18+ or R-18, or AniList (by its
  MyAnimeList id) marks it adult or Hentai (`isAdultTitle` in
  `src/malList.js`). A toast says "NSFW (18+)" and that it wasn't added.
  If AniList can't be reached, only the site's genres count. MyAnimeList
  imports leave such titles out too, and the import summary says how
  many.
- **Artists view** (`src/artists.js`) — with a type chosen in the Library
  (Manga, Manhwa, Anime), **🎭 Artists** shows one row per artist credited
  on that type's titles (searchable), with a picture from one of their
  covers (preferring titles that are theirs alone) and how many titles.
  Tapping one opens their details: **☆ Add to Favourites** (★ favourites
  go to the top, backed up to Drive), **📚 Show their titles** (the list,
  filtered to them) and **✥ Move picture** to choose which part of the
  picture shows (drag and zoom; `src/FocusImage.js`, kept on this phone).
  **🎲 Random** can pick an artist instead of a title (**Pick a: 🎭
  Artist**), where the Rating row's ♥ means your ★ favourite artists.
- **Notepad** (`src/Notepad.js`, the 📝 button on the Library) — notes as
  lists of items (text or links, which open with a tap). The built-in
  **Inbox** is for jotting things down, and is where text and links
  shared from other apps land (select them, then **Share › Manga
  Tracker**; `expo-share-intent`, handled in App.js outside the app lock,
  so sharing never asks to unlock). **Move** files an item into a named
  note, made with **＋ New**. Stored in SQLite (`notes`, `notebooks`).
  `src/notepadSync.js` syncs with Drive (`notepad.json`, plus a readable
  `Notepad.txt`, in the MangaTracker folder): note NAMES are shared by
  every device (creating or deleting one does it everywhere), but each
  device only ever sees its own items. Deleting an item removes it from
  Drive too; deleting a whole note keeps it and its items in Drive.
- `src/SyncStatusPill.js` / `src/syncStatus.js` — the pill beside the
  Settings button. While a backup, restore or MAL import runs it shows
  **Backup**, **Restore** or **Import**, filling from the left as it goes (full = done); then
  "✓ Backed up" / "✓ Restored 12" for 2 seconds, or a red "⚠ Backup
  failed" that stays until tapped (it then shows the error) or until a
  later backup works. It appears after half a second, so quick automatic
  backups never flash it; automatic backups that only write the CSVs
  don't show it at all unless they fail. Backup Now, Restore, Connect and
  cover uploads always do. Progress is one step per type's file plus one
  per cover uploaded (Backup Now counts the covers up front), or one per
  row for a restore.
- `src/EntryList.js` — accepts an `active` prop and re-fetches whenever it
  becomes `true`, since the component now stays permanently mounted
  (App.js toggles visibility rather than mounting/unmounting on tab
  switches) rather than remounting fresh on every visit like it used to
  — without this, anything saved while on another tab wouldn't show up
  until a manual pull-to-refresh. Also accepts `focusKey`/`onFocusHandled`
  — when a browsing tab's "View in Library" button sets `focusKey` (via
  App.js), this clears any active type/rating/tag/artist filters that
  might otherwise hide the target entry and opens its detail sheet
  directly, then calls `onFocusHandled()` so the same key doesn't
  re-trigger later (e.g. if you switch away and back to Library without
  it changing again). Otherwise: unified library view with
  filter chips (All / Manga
  / Anime). Everything below them folds away into one **⚙︎ Filters** bar
  (tap to open; it lists what's on, e.g. "⚙︎ Filters · ♥ · #action", and
  ✕ clears it all): a Newest/Top Rated sort toggle, a **Filter by Artist**
  button that opens a modal listing every distinct artist across the
  whole library — grouped under a header per media type (only types
  with at least one saved artist show up), sorted alphabetically, tap a
  name to filter instantly or "Clear current filter" to reset. Pulls a
  fresh, unfiltered set on open (via `openArtistFilter()`) regardless of
  the current type-filter chip, since the point is to show every artist
  across every type at once rather than just whichever type happens to
  be selected. A row of genre chips (genres come from AniList by
  MyAnimeList id; multi-select — an entry must have *all* selected
  genres). A scrollable minimum-score filter (★9+, ★8+, etc), a scrollable
  status filter (Reading/Watching, Read/Watched, On Hold, Dropped, Want
  to Read/Watch — combined generic wording here since this filter spans
  both media types at once), and a scrollable
  row of tag filter chips
  (multi-select — an entry must have *all* selected tags to match) — all
  client-side over the already-loaded list, so toggling any of them is
  instant. Each row shows its score (★ 8) and progress (12/24 ep).
  Tapping a row opens a detail sheet showing the full title, author,
  media type, code, links to the title's page on the site (opens in its
  tab) and on MyAnimeList (opens in the phone's browser), genres, date added,
  sync status, the
  MyAnimeList fields (score 1–10, progress, dates, rewatches, priority,
  comments — see "MyAnimeList export / import"), a status toggle with
  MyAnimeList's five statuses (labeled per
  the entry's own media type — "Reading"/"Read"/"Want to Read" for
  manga, "Watching"/"Watched"/"Want to Watch" for anime, via each type's
  `readStatusLabels` in `mediaTypes.js`; tap the same one again to
  unset), a tag
  editor (add/remove free-text tags), and a **Delete** button that removes just that one entry and
  its local thumbnail after a confirmation prompt (Google Drive is left
  untouched). New entries start as Plan to Read/Watch and move to
  Reading/Watching when you open an episode or chapter (see "Progress
  while browsing" above). Tags are stored
  as a simple comma-separated field rather
  than a separate table — fine at personal-library scale, and the
  distinct-tag list for the filter row is just computed from whatever's
  in use. MyAnimeList list files are handled from Settings (see
  "MyAnimeList export / import" above). A
  "Clear All" button wipes *every* entry the same way, also
  after confirming first.
- `App.js` — wraps everything in `SafeAreaProvider` + `AppLock`, then
  renders the tab bar built from the media type list plus the Library
  tab. On browsing tabs the tab bar hides once the page hasn't scrolled
  for 3 seconds (`TAB_BAR_HIDE_MS`; taps on the page don't count), and
  comes back when you pull down at the very top of the page. Pulling
  further (about 160px) and letting go reloads the page, with a small
  "Pull to refresh" / "Release to refresh" pill at the top meanwhile
  (Android's web view has no pull-to-refresh of its own).
  `src/tabBarWatch.js`, run inside each page, handles both and reports
  scrolling; the bar always shows on the Library tab.
  All tabs stay mounted simultaneously at all times — switching
  tabs only toggles `display: none`/`flex`, never unmounts anything —
  so each webview keeps its scroll position and navigation history when
  you switch away and back, including via the Library tab. The
  trade-off is both webviews load their `startUrl` immediately on app
  launch rather than lazily on first visit, using somewhat more memory
  up front; reasonable for two tabs on a personal app. Uses
  `SafeAreaView` from `react-native-safe-area-context`, not plain
  `react-native` — the built-in one is effectively a no-op on Android
  (it only actually applies insets on iOS), which is why the header
  used to collide with the status bar/notch on Android phones. A gear
  icon at the top right of the header (on every tab) opens the Settings
  sheet: **Google Drive** (Connect/Reconnect, Backup Now, Restore),
  **MyAnimeList** (export/import), then **App lock** (see `AppLock.js` below)
  and **Show debug tools**, which controls whether each browsing tab
  shows its debug log bar and "Capture HTML" button (see
  `MediaWebView.js`; off by default so the normal UI stays clean), **Block
  ads** and **Delete screenshots without asking** (Android 12+). Under
  **Buttons**, switches hide the **Site list** and **Save Page Image** on
  the tabs that have them (all
  shown by default;
  `BUTTON_SETTINGS` in App.js). The sheet scrolls when it doesn't fit.
  Under **Data saver** (`src/dataSaver.js`): **Load tabs only when
  opened** (on by default; tabs no longer all load at start-up), **Unload
  background tabs** (off; keeps only the current and last-used browsing
  tab loaded, reopening others on the same page) and **Drive sync on
  Wi-Fi only** (off; automatic backups and cover uploads wait for Wi-Fi
  and catch up when it's back, while Backup Now / Restore / Connect
  in Settings always run). Wi-Fi vs mobile data comes from `expo-network`, so it
  needs a new app build.
  Each setting is persisted via `getSetting()`/`setSetting()` in `db.js`
  so it survives app restarts. Also coordinates the **View in
  Library** button (see `MediaWebView.js`): `handleViewInLibrary()`
  takes the `${mediaType}:${sourceId}` key that button passes up, stores
  it as `libraryFocusKey`, and switches to the Library tab — `EntryList`
  picks that key up via its `focusKey` prop and opens the matching
  entry's detail sheet directly.
- `src/AppLock.js` — the optional app lock, switched by **Settings →
  App lock** (the `appLockEnabled` setting). Turning it on or off asks
  for the fingerprint/PIN first and takes effect immediately. It's off
  on a fresh install; `initDb()` turns it on for an update from a build
  that always locked (detected by the `entries` table already
  existing), and never changes it after that. AppLock calls `initDb()`
  itself during its first render, since it needs the setting before
  anything else runs. When on, it requires biometric/device-passcode
  authentication
  before showing any app content, and re-locks whenever the app returns
  from the background (so a screenshot in the recent-apps switcher, or
  someone picking up an already-open phone, isn't enough to see what's
  tracked). Falls back to allowing access on devices with no lock
  hardware at all, since there's nothing to enforce there. Also checks
  enrollment specifically (not just hardware presence) — a phone with
  fingerprint hardware but no fingerprint/PIN/pattern/password actually
  set up is the most common cause of the prompt silently never
  appearing, and this surfaces that with an explicit message instead of
  leaving you stuck. A "Continue without unlocking" escape hatch appears
  after any real auth failure or enrollment issue (never on the first
  attempt) so a device-side lock-screen misconfiguration can never
  permanently lock you out of your own app.

## Installing permanently on your phone (no PC needed after this)

Running via `expo start` requires your PC to stay on and Expo Go to be
connected the whole time. For a personal-use app that just lives on your
phone, build a standalone install instead:

```bash
npm install -g eas-cli
eas login          # free Expo account
eas build --platform android --profile preview
```

This builds an `.apk` in Expo's cloud (no local PC needed for the build
itself, and definitely not needed afterward). When it finishes, EAS prints
a download link/QR code — open it on your phone, download, and tap to
install (you'll need to allow "install from unknown sources" once, since
it's outside the Play Store).

iOS is similar (`eas build --platform ios --profile preview`) but requires
an Apple Developer account ($99/yr) and either TestFlight internal testing
or registering your device for Ad Hoc distribution — Apple doesn't allow
plain `.ipa` sideloading without one of those.

This is a genuine standalone app after that — no dev server, no Expo Go,
no PC required to use it day to day. Re-run the build command whenever you
change the code and want to update the installed app.

**Note on this being for personal use:** because this app scrapes images
from a third-party manga site, it's a poor fit for public App Store/Play
Store distribution (store review teams routinely reject scraping apps).
The steps above — direct APK install / TestFlight internal testing — skip
store review entirely, which suits a personal tracker like this well.

## Known limitations / next steps

- The extraction selectors are generic guesses; confirm them against your
  sites (the debug log shows what each save picked up).
- Drive sync is fire-and-forget with a `failed` status on error; there's no
  automatic retry loop yet. A simple addition would be an effect that calls
  `getPendingSyncEntries()` on app start and retries each.
- Google sign-in persists across app launches — `restoreGoogleSession()`
  runs on startup and silently restores the last account via
  `GoogleSignin.hasPreviousSignIn()`/`signInSilently()`, no prompt shown.
  Access tokens are fetched fresh on every Drive API call rather than
  cached for the whole session, since they expire after about an hour —
  `GoogleSignin.getTokens()` handles refreshing under the hood cheaply,
  so there's no real cost to always asking.
- Saving to the gallery uses expo-media-library's new `Album` API
  (`src/gallery.js`): from SDK 57 the plain import's `saveToLibraryAsync`
  throws at runtime. MediaWebView still imports `expo-media-library/legacy`
  for its photo-permission request.
- File operations use `expo-file-system/legacy` rather than the plain
  `expo-file-system` import — SDK 54 replaced the old function-based API
  (`getInfoAsync`, `downloadAsync`, etc.) with a new `File`/`Directory`
  class-based one, moving the old functions to this separate import path
  rather than removing them outright. All three files that touch the
  filesystem (`MediaWebView.js`, `GoogleDriveService.js`, `EntryList.js`)
  use this legacy import.
- Adding a third media type (articles, songs, etc.) only requires a new
  entry in `src/mediaTypes.js` — the webview, storage, and library screens
  are all generic and will pick it up automatically.
