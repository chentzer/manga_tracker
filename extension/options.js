// The options page: Google client and sign-in, and the sites to record
// from (each needs access, asked for when they're saved).
/* global chrome, MTRules */

const $ = (id) => document.getElementById(id);
const siteInputs = [...document.querySelectorAll('[data-site]')];

$('redirect').textContent = chrome.identity.getRedirectURL();

async function showDriveState() {
  const { connected } = await chrome.runtime.sendMessage({ type: 'status' });
  $('driveState').textContent = connected ? 'Connected' : 'Not connected';
  $('disconnect').hidden = !connected;
}

chrome.storage.local.get(['googleClientId', 'sites'], ({ googleClientId, sites }) => {
  $('clientId').value = googleClientId || '';
  siteInputs.forEach((input) => {
    input.value = (sites || {})[input.dataset.site] || '';
  });
});
showDriveState();

$('clientId').addEventListener('change', () =>
  chrome.storage.local.set({ googleClientId: $('clientId').value.trim() })
);

$('connect').addEventListener('click', async () => {
  await chrome.storage.local.set({ googleClientId: $('clientId').value.trim() });
  $('driveState').textContent = 'Connecting…';
  const result = await chrome.runtime.sendMessage({ type: 'connect' });
  if (result.error) $('driveState').textContent = `Couldn't connect: ${result.error}`;
  else showDriveState();
});

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  showDriveState();
});

$('saveSites').addEventListener('click', async () => {
  const sites = {};
  siteInputs.forEach((input) => {
    const value = input.value.trim().replace(/\/+$/, '');
    if (value) sites[input.dataset.site] = value;
  });
  const origins = MTRules.origins(sites);
  // Asked for here (a click is needed): reading those sites' pages and
  // their covers.
  const granted = origins.length ? await chrome.permissions.request({ origins }) : true;
  await chrome.storage.local.set({ sites });
  await chrome.runtime.sendMessage({ type: 'sitesChanged' });
  $('sitesState').textContent = granted
    ? 'Saved. Reload any open pages of these sites.'
    : 'Saved, but without access to the sites nothing is recorded.';
});
