const { withMainActivity } = require('@expo/config-plugins');

// Keeps the app's content out of the Recents / app-switcher preview
// while still ALLOWING screenshots. Android's usual tool for this,
// FLAG_SECURE (what expo-screen-capture uses), can't do that — it blocks
// screenshots and the Recents preview together. Activity
// .setRecentsScreenshotEnabled(false) (Android 13 / API 33+) only stops
// the system snapshotting the app for Recents; user screenshots still
// work. On Android 12 and older it's skipped and Recents shows content.

const MARKER = '[withHideFromRecents]';

// Pure string transform, exported so it can be tested on its own.
// Inserts the call right after super.onCreate(...) in MainActivity.
function addHideFromRecents(src, language) {
  if (src.includes(MARKER)) return src; // already applied
  const superCall = /^([ \t]*)super\.onCreate\([^)]*\);?[ \t]*$/m;
  const match = src.match(superCall);
  if (!match) {
    // Fail the build loudly rather than silently shipping without it.
    throw new Error(
      `${MARKER} couldn't find super.onCreate(...) in MainActivity — the template may have changed; update withHideFromRecents.js.`
    );
  }
  const indent = match[1];
  const semi = language === 'java' ? ';' : '';
  const lines = [
    `${indent}// ${MARKER} hide app content in Recents, still allow screenshots`,
    `${indent}if (android.os.Build.VERSION.SDK_INT >= 33) {`,
    `${indent}  setRecentsScreenshotEnabled(false)${semi}`,
    `${indent}}`,
  ];
  const at = match.index + match[0].length;
  return `${src.slice(0, at)}\n${lines.join('\n')}${src.slice(at)}`;
}

module.exports = function withHideFromRecents(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = addHideFromRecents(config.modResults.contents, config.modResults.language);
    return config;
  });
};
module.exports.addHideFromRecents = addHideFromRecents;
