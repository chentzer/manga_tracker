import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { onSyncStatus } from './syncStatus';

// Keeps the screen on while a backup or restore that shows the status
// pill is running (Backup Now, Restore, Connect, cover uploads), so the
// phone doesn't sleep and pause it halfway. The quick automatic CSV
// backups don't need it. Returns a function that stops watching.
const TAG = 'drive-sync';

export function keepAwakeWhileSyncing() {
  let awake = false;
  const stop = onSyncStatus(({ active }) => {
    const want = !!(active && active.show);
    if (want === awake) return;
    awake = want;
    if (want) Promise.resolve(activateKeepAwakeAsync(TAG)).catch(() => {});
    else Promise.resolve(deactivateKeepAwake(TAG)).catch(() => {});
  });
  return () => {
    stop();
    if (awake) Promise.resolve(deactivateKeepAwake(TAG)).catch(() => {});
  };
}
