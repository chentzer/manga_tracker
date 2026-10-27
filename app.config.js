// Using app.config.js instead of app.json so real values (OAuth client
// IDs) can come from a local, git-ignored .env file rather than being
// committed to the repo. Copy .env.example to .env and fill in your
// real values there — see README.md's Google Drive setup section.
export default {
  expo: {
    name: 'AniManga Tracker',
    slug: 'manga-tracker',
    version: '1.0.0',
    orientation: 'default',
    userInterfaceStyle: 'automatic',
    // An open book with a play button: manga and anime.
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#1a1a2e',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.chentzer.mangatracker',
      infoPlist: {
        NSFaceIDUsageDescription: 'Face ID is used to lock the app and keep your library private.',
      },
    },
    android: {
      package: 'com.chentzer.mangatracker',
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#1a1a2e',
      },
      permissions: [
        'INTERNET',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        // Screenshot filing (src/screenshots.js): removing the original
        // without asking each time, once allowed in Settings.
        'android.permission.MANAGE_MEDIA',
      ],
    },
    scheme: 'mangatracker',
    plugins: [
      '@react-native-google-signin/google-signin',
      'expo-local-authentication',
      // The calendar for an entry's start / finish date (EntryList.js).
      '@react-native-community/datetimepicker',
      './withGradleMemoryFix.js',
      // Keeps the app's content out of the Recents preview (Android 13+),
      // while still allowing screenshots.
      './withHideFromRecents.js',
      [
        'expo-media-library',
        {
          photosPermission: 'Allow AniManga Tracker to save images to your photo library.',
          savePhotosPermission: 'Allow AniManga Tracker to save images to your photo library.',
          isAccessMediaLocationEnabled: true,
        },
      ],
      // Share › AniManga Tracker from other apps: selected text and links go
      // to the Notepad's Inbox (App.js).
      [
        'expo-share-intent',
        {
          androidIntentFilters: ['text/*'],
        },
      ],
    ],
    extra: {
      googleClientIdAndroid:
        process.env.GOOGLE_CLIENT_ID_ANDROID || 'YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com',
      googleClientIdIos:
        process.env.GOOGLE_CLIENT_ID_IOS || 'YOUR_IOS_CLIENT_ID.apps.googleusercontent.com',
      googleClientIdWeb:
        process.env.GOOGLE_CLIENT_ID_WEB || 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
      // The site each tab opens (read by src/mediaTypes.js). Set your real
      // sites in .env; the placeholders are used when they're missing.
      mangaSiteUrl: process.env.MANGA_SITE_URL || 'https://your-manga-site.example.com',
      // The Manga tab's second site (in its ▾ site list).
      mangaSite2Url: process.env.MANGA_SITE_2_URL || 'https://your-second-manga-site.example.com',
      mangaSite3Url: process.env.MANGA_SITE_3_URL || 'https://your-third-manga-site.example.com',
      animeSiteUrl: process.env.ANIME_SITE_URL || 'https://your-anime-site.example.com',
      // The Manhwa tab's three sites (see the manhwa type in src/mediaTypes.js).
      manhwaSiteUrl: process.env.MANHWA_SITE_URL || 'https://your-manhwa-site.example.com',
      manhwaSite2Url: process.env.MANHWA_SITE_2_URL || 'https://your-second-manhwa-site.example.com',
      manhwaSite3Url: process.env.MANHWA_SITE_3_URL || 'https://your-third-manhwa-site.example.com',
      // Links the project to its EAS (Expo) project for builds.
      eas: {
        projectId: '5c853069-d131-4906-ab59-4f689e5a9ac3',
      },
    },
  },
};
