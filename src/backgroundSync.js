import { PermissionsAndroid, Platform } from 'react-native';
import SyncService from '../modules/sync-service/src';
import { onSyncStatus } from './syncStatus';
import { getSetting, setSetting } from './db';

// Backup Now, Restore, Connect and list imports keep going when you leave
// the app: while a sync you started runs (one the status pill shows —
// automatic backups don't), modules/sync-service runs a foreground service
// whose notification shows the pill's progress ("37% · Covers 185 / 500").
// It stops when the sync ends. Without the add-on (Expo Go) nothing
// changes: syncs run while the app is open.

const TITLES = {
  backup: 'Backing up to Google Drive',
  restore: 'Restoring from Google Drive',
  import: 'Importing your lists',
};
const UPDATE_MS = 1000; // the notification changes at most this often

// Android 13+ asks before an app may show notifications; asked once. Said
// no, the service still runs, only its notification is hidden.
function askForNotificationsOnce() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  if (getSetting('askedNotifications', '0') === '1') return;
  setSetting('askedNotifications', '1');
  PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS').catch(() => {});
}

// "37% · Covers 185 / 500": the part still going (else the last one).
function describe(active) {
  const percent = active.total > 0 ? Math.floor((active.done / active.total) * 100) : 0;
  const part = active.parts.find((p) => p.done < p.total) || active.parts[active.parts.length - 1];
  return part ? `${percent}% · ${part.label} ${part.done} / ${part.total}` : `${percent}%`;
}

// Starts watching the sync status; returns a function that stops.
export function startBackgroundSync() {
  if (!SyncService) return () => {};
  let running = false;
  let lastUpdate = 0;
  const stop = onSyncStatus(({ active }) => {
    if (active && active.show) {
      const title = TITLES[active.kind] || TITLES.backup;
      const upload = active.kind === 'backup';
      if (!running) {
        askForNotificationsOnce();
        running = !!SyncService.start(title, describe(active), upload);
        lastUpdate = Date.now();
      } else if (Date.now() - lastUpdate >= UPDATE_MS) {
        SyncService.update(title, describe(active), active.done, active.total, upload);
        lastUpdate = Date.now();
      }
    } else if (running) {
      SyncService.stop();
      running = false;
    }
  });
  return () => {
    stop();
    if (running) SyncService.stop();
  };
}
