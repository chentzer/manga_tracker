import { requireOptionalNativeModule } from 'expo';

// The background-sync add-on (modules/sync-service): a foreground service
// with a progress notification, so Backup Now, Restore and list imports
// keep going after you leave the app. null when it isn't built into the
// app (e.g. in Expo Go): then they only run while the app is open.
export default requireOptionalNativeModule('SyncService');
