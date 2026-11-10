// Authorization Code + PKCE. No client secret belongs in browser code.
const configs = () => ({
  school: { clientId: import.meta.env.VITE_COGNITO_CLIENT_ID, domain: import.meta.env.VITE_COGNITO_DOMAIN,
    pool: import.meta.env.VITE_COGNITO_USER_POOL_ID, path: '/auth/callback' },
  angaza: { clientId: import.meta.env.VITE_PLATFORM_COGNITO_CLIENT_ID, domain: import.meta.env.VITE_PLATFORM_COGNITO_DOMAIN,
    pool: import.meta.env.VITE_PLATFORM_COGNITO_USER_POOL_ID, path: '/angaza/auth/callback' },
});
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const key = realm => `connected.oauth.${realm}`;
function config(realm) {
  const c = configs()[realm];
  if (!c?.domain || !c.clientId || !c.pool) throw new Error('Cloud sign-in has not been configured for this portal.');
  return { ...c, domain: c.domain.replace(/\/$/, ''), redirect: location.origin + c.path };
}
async function redirect(realm, remember, recovery, retried = false) {
  const c = config(realm);
  const verifier = random(), state = random(), nonce = random();
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(key(realm), JSON.stringify({ verifier, state, nonce, remember, retried, created: Date.now() }));
  const q = new URLSearchParams({ client_id: c.clientId, response_type: 'code', redirect_uri: c.redirect,
    scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
  if (!recovery) { q.set('identity_provider', 'Google'); if (!retried) q.set('prompt', 'select_account'); }
  location.assign(`${c.domain}/${recovery ? 'forgotPassword' : 'oauth2/authorize'}?${q}`);
}
export const startGoogle = (realm, remember = false) => redirect(realm, remember, false);
export const hostedRecovery = realm => redirect(realm, false, true);
async function exchange(c, fields) {
  const res = await fetch(`${c.domain}/oauth2/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, ...fields }) });
  const body = await res.json();
  if (!res.ok || !body.id_token) throw new Error(body.error_description || body.error || 'Sign-in could not be completed. Try again.');
  return body;
}
const pending = new Map();
export function completeOAuth(realm) {
  // React StrictMode may run the same effect twice; redeem each one-use code only once.
  const url = location.href;
  if (!pending.has(url)) pending.set(url, finish(realm));
  return pending.get(url);
}
async function finish(realm) {
  const c = config(realm), q = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem(key(realm)) || 'null');
  sessionStorage.removeItem(key(realm));
  if (!saved || saved.state !== q.get('state') || Date.now() - saved.created > 15 * 60_000) throw new Error('This sign-in attempt expired or could not be verified. Start again.');
  const failure = q.get('error_description') || q.get('error');
  if (failure) {
    // Cognito often refuses the very first sign-in right after the pre-sign-up trigger links the
    // Google identity; the same sign-in then succeeds. Retry once, automatically.
    if (/already found an entry for username/i.test(failure) && !saved.retried) {
      await redirect(realm, saved.remember, false, true);
      return new Promise(() => {}); // the page is leaving for Google again
    }
    // A refusal from the trigger arrives as "PreSignUp failed with error <its message>."
    throw new Error(failure.replace(/^PreSignUp failed with error\s*/i, '').trim());
  }
  if (!q.get('code')) throw new Error('No authorization code received.');
  const body = await exchange(c, { grant_type: 'authorization_code', code: q.get('code'), redirect_uri: c.redirect, code_verifier: saved.verifier });
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))));
  const issuer = `https://cognito-idp.${import.meta.env.VITE_AWS_REGION}.amazonaws.com/${c.pool}`;
  if (claims.iss !== issuer || claims.aud !== c.clientId || claims.nonce !== saved.nonce || claims.token_use !== 'id' || claims.exp * 1000 <= Date.now()) throw new Error('Unexpected sign-in response.');
  if (realm === 'school' && !claims['custom:school_id']) throw new Error('This Google account is not linked to a school account. Contact your administrator.');
  if (realm === 'angaza' && !(claims['cognito:groups'] || []).includes('PlatformAdmin')) throw new Error('This account is not an Angaza staff account.');
  return { tokens: { idToken: body.id_token, refreshToken: body.refresh_token, oauth: true }, remember: saved.remember };
}
export async function refreshOAuth(refreshToken, clientId) {
  const realm = clientId === configs().angaza.clientId ? 'angaza' : 'school';
  const body = await exchange(config(realm), { grant_type: 'refresh_token', refresh_token: refreshToken });
  return { idToken: body.id_token, refreshToken: body.refresh_token || refreshToken, oauth: true };
}
