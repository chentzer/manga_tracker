const { withMainActivity } = require('@expo/config-plugins');

// Keeps the app's content out of the Recents / app-switcher preview
// while still ALLOWING screenshots — only while App lock is on. Android's
// usual tool for this, FLAG_SECURE (what expo-screen-capture uses), can't
// do that — it blocks screenshots and the Recents preview together.
// Activity.setRecentsScreenshotEnabled(false) (Android 13 / API 33+) only
// stops the system snapshotting the app for Recents; user screenshots
// still work. On Android 12 and older it's skipped and Recents shows
// content.
//
// App lock is a JS setting, so src/AppLock.js keeps a flag file,
// `hide-from-recents` in the app's files folder (expo-file-system's
// documentDirectory), while it's on. The activity checks it when it
// starts and each time it's left, before Recents takes its snapshot.

const MARKER = '[withHideFromRecents]';
const FLAG_FILE = 'hide-from-recents';

// Pure string transform, exported so it can be tested on its own.
// Calls the check right after super.onCreate(...) in MainActivity, and
// adds onPause and the check itself at the end of the class (Kotlin).
function addHideFromRecents(src, language) {
  if (src.includes(MARKER)) return src; // already applied
  if (language !== 'kt') {
    throw new Error(`${MARKER} expects a Kotlin MainActivity; update withHideFromRecents.js.`);
  }
  const superCall = /^([ \t]*)super\.onCreate\([^)]*\);?[ \t]*$/m;
  const match = src.match(superCall);
  const classEnd = src.lastIndexOf('}');
  if (!match || classEnd < 0) {
    // Fail the build loudly rather than silently shipping without it.
    throw new Error(
      `${MARKER} couldn't find super.onCreate(...) in MainActivity — the template may have changed; update withHideFromRecents.js.`
    );
  }
  const indent = match[1];
  const members = [
    '',
    `  // ${MARKER} hide app content in Recents while App lock is on (the`,
    `  // flag file is kept by src/AppLock.js); screenshots still work.`,
    '  override fun onPause() {',
    '    applyHideFromRecents()',
    '    super.onPause()',
    '  }',
    '',
    '  private fun applyHideFromRecents() {',
    '    if (android.os.Build.VERSION.SDK_INT >= 33) {',
    `      setRecentsScreenshotEnabled(!java.io.File(filesDir, "${FLAG_FILE}").exists())`,
    '    }',
    '  }',
  ].join('\n');
  const withMembers = `${src.slice(0, classEnd).replace(/\s*$/, '')}\n${members}\n${src.slice(classEnd)}`;
  const at = match.index + match[0].length;
  return `${withMembers.slice(0, at)}\n${indent}applyHideFromRecents() // ${MARKER}${withMembers.slice(at)}`;
}

module.exports = function withHideFromRecents(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = addHideFromRecents(config.modResults.contents, config.modResults.language);
    return config;
  });
};
module.exports.addHideFromRecents = addHideFromRecents;
