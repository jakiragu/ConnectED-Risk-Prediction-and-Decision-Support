import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { validation } from './errors.js';

/**
 * Proof that someone controls a Google account, for linking it to a ConnectED
 * account. The proof is an ID token signed by Google. Nothing the browser says
 * about the Google account is believed: the server checks that the token
 *
 *   is genuine        signed by one of Google's published keys (RS256 only)
 *   is for ConnectED  its audience is this deployment's Google client id
 *   is current        not expired, not issued in the future
 *   answers THIS      it carries the one-time value the server made for this
 *   person's request  person's link request (accountLink.js stores only its hash)
 *
 * What gets linked is `sub`, Google's permanent id for the account. The email
 * address can change, so it is kept for display only.
 */
const GOOGLE = {
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
};
const loopback = (url) => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
};

/**
 * Where Google is, and which client id its answers must be for. null: Google is not set up.
 * Local development has no Google: local/google-stand-in.js plays its part, and is accepted only
 * when the sign-in service is also the local stand-in, so no hosted deployment can be pointed at it.
 */
export function googleConfig(env = process.env) {
  if (loopback(env.GOOGLE_STANDIN_URL) && loopback(env.COGNITO_ENDPOINT)) {
    const base = env.GOOGLE_STANDIN_URL.replace(/\/$/, '');
    return { clientId: env.GOOGLE_CLIENT_ID || 'local-google-client', issuers: [base], jwksUrl: `${base}/certs`, authUrl: `${base}/authorize`, standIn: true };
  }
  if (!env.GOOGLE_CLIENT_ID) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, ...GOOGLE };
}

/** The address Google sends the person back to. One address for both portals; it must be registered in Google Cloud Console. */
export const linkRedirectUri = (env = process.env) => `${String(env.SITE_URL || 'http://localhost:5173').replace(/\/$/, '')}/auth/google-link`;

export const randomToken = () => randomBytes(32).toString('base64url');
export const hashNonce = (nonce) => createHash('sha256').update(String(nonce)).digest('base64url');
export function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The address of Google's account chooser for one link request. */
export function authorizeUrl(config, { nonce, state }, env = process.env) {
  const q = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'id_token',
    redirect_uri: linkRedirectUri(env),
    scope: 'openid email',
    nonce,
    state,
    prompt: 'select_account',
  });
  return `${config.authUrl}?${q}`;
}

// Google's signing keys, refreshed hourly or when a token names a key not seen yet.
const cache = new Map();
async function fetchKeys(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Could not load Google's signing keys (${res.status})`);
  return (await res.json()).keys || [];
}
async function signingKey(config, kid, load) {
  let entry = cache.get(config.jwksUrl);
  if (!entry || !entry.keys.has(kid) || Date.now() - entry.at > 60 * 60 * 1000) {
    const keys = await load(config.jwksUrl);
    entry = { at: Date.now(), keys: new Map(keys.filter((k) => k.kty === 'RSA').map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })])) };
    cache.set(config.jwksUrl, entry);
  }
  return entry.keys.get(kid) || null;
}

const REFUSED = 'Google’s answer could not be verified. Start again from your profile.';

/**
 * @returns {{sub:string, email:string|null, nonce:string}} from a token that passed every check
 * @throws ValidationError for anything else. The reason is logged, never shown: a person who
 *         reaches this with a bad token gains nothing from knowing which check failed.
 */
export async function verifyGoogleIdToken(token, config, { now = Date.now(), loadKeys = fetchKeys } = {}) {
  const refuse = (reason) => {
    console.log(JSON.stringify({ level: 'warn', svc: 'google-token', refused: reason }));
    throw validation(REFUSED);
  };
  if (!config) refuse('not-configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) refuse('shape');
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    refuse('unreadable');
  }
  if (header.alg !== 'RS256' || !header.kid) refuse('algorithm');
  let key;
  try {
    key = await signingKey(config, header.kid, loadKeys);
  } catch {
    throw validation('Google could not be reached to check your account. Try again in a moment.');
  }
  if (!key) refuse('unknown-key');
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) refuse('signature');
  if (!config.issuers.includes(claims.iss)) refuse('issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.clientId) || (audiences.length > 1 && claims.azp !== config.clientId)) refuse('audience');
  const seconds = now / 1000;
  if (!(Number(claims.exp) > seconds)) refuse('expired');
  if (Number(claims.iat) > seconds + 300) refuse('issued-in-future');
  if (typeof claims.sub !== 'string' || !/^[\w.-]{1,255}$/.test(claims.sub)) refuse('subject');
  if (typeof claims.nonce !== 'string' || !claims.nonce) refuse('no-nonce');
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return {
    sub: claims.sub,
    // Shown to the person and their administrator; never used to decide whose account this is.
    email: verified && typeof claims.email === 'string' ? claims.email.toLowerCase().slice(0, 254) : null,
    nonce: claims.nonce,
  };
}
