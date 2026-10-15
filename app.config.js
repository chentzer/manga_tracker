// Using app.config.js instead of app.json so real values (OAuth client
// IDs) can come from a local, git-ignored .env file rather than being
// committed to the repo. Copy .env.example to .env and fill in your
// real values there — see README.md's Google Drive setup section.
export default {
  expo: {
    name: 'Manga Tracker',
    slug: 'manga-tracker',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    splash: {
      backgroundColor: '#1a1a2e',
    },
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'com.yourname.mangatracker',
      infoPlist: {
        NSFaceIDUsageDescription: 'Face ID is used to lock the app and keep your library private.',
      },
    },
    android: {
      package: 'com.yourname.mangatracker',
      permissions: ['INTERNET'],
    },
    scheme: 'mangatracker',
    plugins: [
      '@react-native-google-signin/google-signin',
      'expo-local-authentication',
      './withGradleMemoryFix.js',
      [
        'expo-media-library',
        {
          photosPermission: 'Allow Media Tracker to save images to your photo library.',
          savePhotosPermission: 'Allow Media Tracker to save images to your photo library.',
          isAccessMediaLocationEnabled: true,
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
    },
  },
};
