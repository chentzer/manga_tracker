import { requireOptionalNativeModule } from 'expo';

// The app's own "Search AniManga Tracker" entry for highlighted text
// (modules/process-text). null when it isn't built into the app (e.g. in
// Expo Go), in which case there's nothing to take.
export default requireOptionalNativeModule('ProcessText');
