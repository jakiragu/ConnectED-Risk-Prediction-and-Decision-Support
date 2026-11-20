/*
 * One line for the sign-in page saying why the person was signed out (their Google link was
 * removed or changed). Kept for this tab only, shown once, per portal.
 */
const key = (realm) => `connected.${realm}.signed-out-notice`;

export function setSignOutNotice(realm, message) {
  try { sessionStorage.setItem(key(realm), message); } catch { /* not shown; signing out still works */ }
}

export function readSignOutNotice(realm) {
  try { return sessionStorage.getItem(key(realm)); } catch { return null; }
}

export function clearSignOutNotice(realm) {
  try { sessionStorage.removeItem(key(realm)); } catch { /* nothing to clear */ }
}
