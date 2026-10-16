import * as Network from 'expo-network';
import { getSetting, setSetting } from './db';

// Settings → Data saver. Three switches, stored in the settings table:
//   lazyTabs              '1' (default) — a tab loads its page the first
//                         time it's opened, not at app start (App.js)
//   unloadBackgroundTabs  '0' (default) — only the current and the
//                         last-used browsing tab stay loaded (App.js)
//   driveWifiOnly         '0' (default) — automatic Drive sync waits for
//                         Wi-Fi (backup.js, cover uploads in MediaWebView.js)
export const DATA_SAVER_DEFAULTS = { lazyTabs: '1', unloadBackgroundTabs: '0', driveWifiOnly: '0' };

export function dataSaverSetting(key) {
  return getSetting(key, DATA_SAVER_DEFAULTS[key]) === '1';
}

// The current connection, from expo-network: null until first known.
let networkType = null;
const listeners = new Set();

function update(type) {
  const before = isUnmetered();
  networkType = type;
  if (!before && isUnmetered()) listeners.forEach((listener) => listener());
}

// Started once from App.js. Wi-Fi (and Ethernet) count as unmetered;
// mobile data, VPN and unknown don't, so nothing is sent by mistake.
export function startNetworkWatch() {
  Network.getNetworkStateAsync()
    .then((state) => update(state.type))
    .catch(() => {});
  const subscription = Network.addNetworkStateListener((state) => update(state.type));
  return () => subscription.remove();
}

export function isUnmetered() {
  return networkType === Network.NetworkStateType.WIFI || networkType === Network.NetworkStateType.ETHERNET;
}

export function isOnMobileData() {
  return networkType === Network.NetworkStateType.CELLULAR;
}

// Called whenever the connection switches to Wi-Fi.
export function onUnmetered(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether automatic Drive sync may run right now. The Backup Now /
// Restore / Connect buttons don't ask: they always run.
export function driveSyncAllowed() {
  return !dataSaverSetting('driveWifiOnly') || isUnmetered();
}

// Something was held back for Wi-Fi; App.js catches up once it's allowed.
// Kept in the settings table so it survives the app being closed.
export function markDriveSyncDeferred() {
  setSetting('driveSyncDeferred', '1');
}

export function takeDriveSyncDeferred() {
  const deferred = getSetting('driveSyncDeferred', '0') === '1';
  if (deferred) setSetting('driveSyncDeferred', '0');
  return deferred;
}
