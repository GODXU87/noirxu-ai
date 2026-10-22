/**
 * Browser push services. Subscriptions must point at one of these, otherwise the server
 * could be tricked into sending requests to arbitrary hosts.
 */
const PUSH_HOST_SUFFIXES = [
  'push.apple.com',               // Safari / iOS (web.push.apple.com)
  'fcm.googleapis.com',           // Chrome, Edge (Android/desktop)
  'push.services.mozilla.com',    // Firefox
  'notify.windows.com'            // Legacy Edge / Windows
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.port) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
