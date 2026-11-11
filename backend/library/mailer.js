import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * The one place ConnectED sends email from. Callers hand over a finished
 * message (see accountEmails.js) and get back what happened:
 *
 *   { sent: true,  problem: null }
 *   { sent: false, problem: 'why, in words an administrator can act on' }
 *
 * Sending never throws. An account change has already happened by the time its
 * email goes out, so a failed email must not undo it or hide it: the caller
 * shows the temporary password instead and says why.
 *
 * Where mail goes (MAIL_TRANSPORT overrides the choice):
 *   ses  Amazon SES, from MAIL_FROM. The AWS deployment, once `deploy.py mail` has run.
 *   log  printed to the terminal and saved under local/.data/mail. Local development.
 *   off  nothing is sent. An AWS deployment whose sender is not set up yet.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_MAILBOX = join(here, '../../local/.data/mail');

export function transport(env = process.env) {
  const chosen = String(env.MAIL_TRANSPORT || '').toLowerCase();
  if (['ses', 'log', 'off'].includes(chosen)) return chosen;
  if (env.DDB_ENDPOINT) return 'log'; // the local stand-ins are running
  return env.MAIL_FROM ? 'ses' : 'off';
}

let ses;
const sesClient = (env) => (ses ??= new SESv2Client({ region: env.SES_REGION || env.AWS_REGION || 'eu-west-1' }));

/** Turns an SES refusal into something the person who triggered the email can act on. */
function explain(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  if (/not verified/i.test(text)) {
    return 'Amazon SES is still in its sandbox, so it delivers only to verified addresses. Request production access in the SES console.';
  }
  if (/daily (message )?quota|sending quota|Throttl|TooManyRequests/i.test(text)) return 'Too many emails were sent today. Try again later.';
  if (/AccessDenied|not authorized/i.test(text)) return 'This deployment is not allowed to send email yet.';
  return 'The email could not be sent.';
}

// Logged without the recipient's address: logs are kept, and addresses are personal data.
const log = (level, fields) => console.log(JSON.stringify({ level, svc: 'mailer', ...fields }));

export async function sendEmail(message, { env = process.env, client } = {}) {
  const { to, subject, text, html, kind = 'email' } = message;
  const mode = transport(env);

  if (mode === 'off') {
    log('info', { kind, sent: false, reason: 'not-configured' });
    return { sent: false, problem: 'Email is not set up on this deployment yet.' };
  }

  if (mode === 'log') {
    const divider = '-'.repeat(72);
    console.log(`\n${divider}\nEMAIL (local, not sent) to ${to}\nSubject: ${subject}\n\n${text}\n${divider}\n`);
    try {
      mkdirSync(LOCAL_MAILBOX, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.html`;
      writeFileSync(join(LOCAL_MAILBOX, name), `<!-- To: ${to} -->\n<!-- Subject: ${subject} -->\n${html}`);
    } catch {
      // The terminal copy is enough; a read-only folder must not fail the request.
    }
    return { sent: true, problem: null };
  }

  if (!env.MAIL_FROM) return { sent: false, problem: 'Email is not set up on this deployment yet.' };
  try {
    await (client || sesClient(env)).send(new SendEmailCommand({
      FromEmailAddress: `ConnectED <${env.MAIL_FROM}>`,
      ...(env.MAIL_REPLY_TO ? { ReplyToAddresses: [env.MAIL_REPLY_TO] } : {}),
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } },
        },
      },
    }));
    log('info', { kind, sent: true });
    return { sent: true, problem: null };
  } catch (error) {
    log('warn', { kind, sent: false, error: error?.name, message: error?.message });
    return { sent: false, problem: explain(error) };
  }
}

/** Several recipients, one email each, so no one sees the others' addresses. Never throws. */
export async function sendEach(messages, options) {
  return Promise.all(messages.map((m) => sendEmail(m, options)));
}
