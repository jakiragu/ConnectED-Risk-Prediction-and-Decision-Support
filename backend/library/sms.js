import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one place ConnectED sends SMS from, the way mailer.js is for email.
 * Callers hand over a finished message and get back what happened:
 *
 *   { sent: true,  provider_id, cost, problem: null }
 *   { sent: false, problem: 'why, in words a teacher can act on', fatal }
 *
 * Sending never throws. `fatal` means every further message would fail the same
 * way (no credit, wrong account details), so a batch should stop.
 *
 * Where messages go (SMS_TRANSPORT overrides the choice):
 *   africastalking  Africa's Talking. Username "sandbox" goes to their simulator; any other is live.
 *   log             printed to the terminal and saved under local/.data/sms. Local development.
 *   off             nothing is sent. An AWS deployment whose SMS account is not set up yet.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_OUTBOX = join(here, '../../local/.data/sms');
const TIMEOUT_MS = 10_000;

export function transport(env = process.env) {
  const chosen = String(env.SMS_TRANSPORT || '').toLowerCase();
  if (['africastalking', 'log', 'off'].includes(chosen)) return chosen;
  if (env.DDB_ENDPOINT) return 'log'; // the local stand-ins are running
  return env.AT_USERNAME && env.AT_API_KEY ? 'africastalking' : 'off';
}

/** Whether sending works at all here, and whether it only reaches the provider's simulator. */
export function readiness(env = process.env) {
  const mode = transport(env);
  if (mode === 'off') return { ready: false, sandbox: false, problem: 'SMS is not set up on this deployment yet.' };
  if (mode === 'africastalking' && !(env.AT_USERNAME && env.AT_API_KEY)) {
    return { ready: false, sandbox: false, problem: 'The SMS account details are missing on this deployment.' };
  }
  return { ready: true, sandbox: mode === 'log' || env.AT_USERNAME === 'sandbox', problem: null };
}

const endpoint = (env) => (env.AT_USERNAME === 'sandbox'
  ? 'https://api.sandbox.africastalking.com/version1/messaging'
  : 'https://api.africastalking.com/version1/messaging');

// Africa's Talking per-recipient status codes. 100-102 mean the message was accepted.
const ACCEPTED = new Set([100, 101, 102]);
const REFUSED = {
  401: ['The SMS provider held this message for review. Try again later.'],
  402: ['The sender name is not approved for this SMS account.', true],
  403: ['The parent’s number is not a valid mobile number.'],
  404: ['This kind of number cannot receive SMS.'],
  405: ['The SMS account has run out of credit.', true],
  406: ['This number has blocked messages from this sender.'],
  407: ['The message could not be routed to this number’s network.'],
  409: ['This number has Do Not Disturb turned on.'],
};
const PROVIDER_DOWN = 'The SMS provider had a problem. Try again later.';

// Logged without the recipient's number: logs are kept, and numbers are personal data.
const log = (level, fields) => console.log(JSON.stringify({ level, svc: 'sms', ...fields }));

export async function sendSms({ to, text, kind = 'sms' }, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const mode = transport(env);
  if (mode === 'off') {
    log('info', { kind, sent: false, reason: 'not-configured' });
    return { sent: false, problem: 'SMS is not set up on this deployment yet.', fatal: true };
  }

  if (mode === 'log') {
    const divider = '-'.repeat(72);
    console.log(`\n${divider}\nSMS (local, not sent) to ${to}\n\n${text}\n${divider}\n`);
    try {
      mkdirSync(LOCAL_OUTBOX, { recursive: true });
      appendFileSync(join(LOCAL_OUTBOX, `${new Date().toISOString().slice(0, 10)}.txt`), `${new Date().toISOString()}  ${to}\n${text}\n\n`);
    } catch {
      // The terminal copy is enough; a read-only folder must not fail the request.
    }
    return { sent: true, provider_id: `local-${Date.now()}`, cost: null, problem: null };
  }

  const body = new URLSearchParams({ username: env.AT_USERNAME, to, message: text });
  if (env.AT_SENDER_ID) body.set('from', env.AT_SENDER_ID);
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint(env), {
      method: 'POST',
      headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: timer.signal,
    });
    const raw = await res.text();
    if (res.status === 401 || /authentication|invalid.*(key|username)/i.test(raw)) {
      log('warn', { kind, sent: false, http: res.status, reason: 'auth' });
      return { sent: false, problem: 'The SMS account details on this deployment are wrong.', fatal: true };
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { /* handled below */ }
    const result = data?.SMSMessageData;
    const recipient = result?.Recipients?.[0];
    if (!res.ok || !recipient) {
      // A request-level refusal (no credit, bad sender) comes back as a message with no recipients.
      const message = String(result?.Message || raw || '');
      log('warn', { kind, sent: false, http: res.status, message: message.slice(0, 200) });
      if (/InsufficientBalance/i.test(message)) return { sent: false, problem: REFUSED[405][0], fatal: true };
      if (/InvalidSenderId/i.test(message)) return { sent: false, problem: REFUSED[402][0], fatal: true };
      return { sent: false, problem: PROVIDER_DOWN, fatal: res.status >= 500 };
    }
    const code = Number(recipient.statusCode);
    if (ACCEPTED.has(code)) {
      log('info', { kind, sent: true, status: recipient.status });
      return { sent: true, provider_id: recipient.messageId || null, cost: recipient.cost || null, problem: null };
    }
    const [problem, fatal = false] = REFUSED[code] || [PROVIDER_DOWN, code >= 500];
    log('warn', { kind, sent: false, code, status: recipient.status });
    return { sent: false, problem, fatal };
  } catch (error) {
    log('warn', { kind, sent: false, error: error?.name, message: error?.message });
    const timedOut = error?.name === 'AbortError';
    return { sent: false, problem: timedOut ? 'The SMS provider did not answer in time. Try again.' : PROVIDER_DOWN, fatal: true };
  } finally {
    clearTimeout(stop);
  }
}
