import { createServer } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';

/*
 * Stands in for Google's account chooser when linking a Google account locally
 * (My Profile > Sign-in Methods). There is no Google on a laptop, so this plays
 * the two parts the server relies on: it sends the browser back with a signed ID
 * token, and it publishes the key that token is signed with. The server checks
 * the token exactly as it checks Google's (backend/library/googleToken.js).
 *
 * It is used only when both GOOGLE_STANDIN_URL and COGNITO_ENDPOINT point at this
 * machine. It is not Google and proves nothing about a real Google account.
 */
const ACCOUNTS = [
  ['janedoe@gmail.com', 'Jane Doe'],
  ['jane.personal@gmail.com', 'Jane (second account)'],
  ['shared.staffroom@gmail.com', 'Staffroom shared account'],
];
const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const loopback = (url) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; } };

export function startGoogleStandIn(port, { clientId = process.env.GOOGLE_CLIENT_ID || 'local-google-client' } = {}) {
  let issuer = `http://localhost:${port}`; // port 0 (tests): the real port is known once listening
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'local-stand-in-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const sign = (claims) => {
    const body = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
  };
  const subOf = (email) => String([...email].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 1e15, 7)).padStart(15, '1');

  const server = createServer((req, res) => {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/certs') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname !== '/authorize') { res.writeHead(404).end(); return; }
    const q = url.searchParams;
    const redirect = q.get('redirect_uri') || '';
    if (q.get('client_id') !== clientId || !loopback(redirect)) { res.writeHead(400).end('Unknown client or redirect address'); return; }
    const email = q.get('account');
    if (email) {
      const now = Math.floor(Date.now() / 1000);
      const token = sign({ iss: issuer, aud: clientId, sub: subOf(email.toLowerCase()), email: email.toLowerCase(), email_verified: true, nonce: q.get('nonce'), iat: now, exp: now + 300 });
      res.writeHead(302, { location: `${redirect}#${new URLSearchParams({ state: q.get('state') || '', id_token: token })}` }).end();
      return;
    }
    const pick = (address) => { const next = new URLSearchParams(q); next.set('account', address); return `/authorize?${next}`; };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Choose an account (local stand-in)</title>
<body style="font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:48px 16px;color:#1f2933">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #d5dbe1;border-radius:10px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#5b6472">Local stand-in for Google’s account chooser. Not Google.</p>
<h1 style="font-size:20px;margin:0 0 16px">Choose an account to link</h1>
${ACCOUNTS.map(([address, name]) => `<a href="${escape(pick(address))}" style="display:block;padding:12px 14px;border:1px solid #d5dbe1;border-radius:8px;margin-bottom:8px;text-decoration:none;color:inherit"><b>${escape(name)}</b><br><span style="color:#5b6472">${escape(address)}</span></a>`).join('')}
<form method="get" action="/authorize" style="margin-top:16px">${[...q].map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('')}
<label style="font-size:14px">Another address<br><input name="account" type="email" required style="width:100%;box-sizing:border-box;padding:10px;margin:6px 0 10px;border:1px solid #d5dbe1;border-radius:8px"></label>
<button style="padding:10px 16px;border:0;border-radius:8px;background:#1f4e79;color:#fff">Continue</button></form>
</div></body>`);
  });
  server.listen(port, () => { issuer = `http://localhost:${server.address().port}`; if (port) console.log(`Google account chooser (local stand-in) on ${issuer}`); });
  return server;
}
