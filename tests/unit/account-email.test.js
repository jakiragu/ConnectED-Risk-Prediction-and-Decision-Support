import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsEmail, forgotPasswordCode, invitation, schoolStatus, signInUrl } from '../../backend/library/accountEmails.js';
import { sendEmail, transport } from '../../backend/library/mailer.js';
import { makeHandler } from '../../backend/lambdas/auth-mail/handler.js';

const env = { SITE_URL: 'https://demo.example.net/' };
const base = { to: 'mary@school.ac.ke', firstName: 'Mary', temporaryPassword: 'Tmp#Pass123x', schoolName: 'Kitale Girls', actorName: 'John Man' };

test('account email: a new account gets an invitation with its portal link and password', () => {
  const m = credentialsEmail({ ...base, created: true, role: 'Teacher' }, env);
  assert.equal(m.kind, 'invitation');
  assert.match(m.subject, /Kitale Girls/);
  assert.match(m.text, /John Man added you to ConnectED as a teacher at Kitale Girls/);
  assert.match(m.text, /Temporary password: Tmp#Pass123x/);
  assert.match(m.text, /https:\/\/demo\.example\.net\/sign-in/);
  assert.ok(m.html.includes('Tmp#Pass123x'));
});

test('account email: a reset picks "invitation again" or "password reset" from the state before it', () => {
  assert.equal(credentialsEmail({ ...base, stateBefore: 'WAITING' }, env).kind, 'invitation-resent');
  assert.equal(credentialsEmail({ ...base, stateBefore: 'SIGNED_IN' }, env).kind, 'password-reset');
  assert.equal(credentialsEmail({ ...base, stateBefore: 'UNKNOWN' }, env).kind, 'password-reset');
});

test('account email: Angaza staff are sent to the Angaza console', () => {
  const m = invitation({ to: 'jane@angazacenter.org', temporaryPassword: 'x', role: 'PlatformAdmin', portal: 'angaza' }, env);
  assert.match(m.text, /\/angaza\/sign-in/);
  assert.equal(signInUrl('school', env), 'https://demo.example.net/sign-in');
});

test('account email: names are escaped in the HTML part', () => {
  const m = invitation({ ...base, firstName: '<script>x</script>', role: 'Teacher' }, env);
  assert.ok(!m.html.includes('<script>x</script>'));
  assert.ok(m.html.includes('&lt;script&gt;'));
});

test('account email: a paused school is told without Angaza’s reason', () => {
  const m = schoolStatus({ to: 'a@s.ke', firstName: 'A', schoolName: 'Kitale Girls', suspended: true }, env);
  assert.equal(m.kind, 'school-suspended');
  assert.match(m.text, /paused/);
  assert.match(m.text, /nothing has been deleted/);
});

test('account email: the forgot-password message carries Cognito’s code placeholder exactly once', () => {
  const m = forgotPasswordCode({ to: 'a@s.ke', code: '{####}' });
  assert.equal(m.html.split('{####}').length - 1, 1);
});

test('mailer: transport is log locally, off on AWS without a sender, ses once one is set', () => {
  assert.equal(transport({ DDB_ENDPOINT: 'http://localhost:8000' }), 'log');
  assert.equal(transport({}), 'off');
  assert.equal(transport({ MAIL_FROM: 'no-reply@x.org' }), 'ses');
  assert.equal(transport({ MAIL_FROM: 'no-reply@x.org', MAIL_TRANSPORT: 'off' }), 'off');
});

test('mailer: never throws, and explains an SES sandbox refusal', async () => {
  const off = await sendEmail({ to: 'a@b.ke', subject: 's', text: 't', html: 'h' }, { env: {} });
  assert.deepEqual(off.sent, false);
  const refused = await sendEmail({ to: 'a@b.ke', subject: 's', text: 't', html: 'h' }, {
    env: { MAIL_FROM: 'no-reply@x.org' },
    client: { send: async () => { throw Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' }); } },
  });
  assert.equal(refused.sent, false);
  assert.match(refused.problem, /sandbox/);
  const sent = [];
  const ok = await sendEmail({ to: 'a@b.ke', subject: 's', text: 't', html: 'h' }, {
    env: { MAIL_FROM: 'no-reply@x.org' }, client: { send: async (c) => { sent.push(c.input); } },
  });
  assert.equal(ok.sent, true);
  assert.deepEqual(sent[0].Destination.ToAddresses, ['a@b.ke']);
  assert.equal(sent[0].FromEmailAddress, 'ConnectED <no-reply@x.org>');
});

const userAttributes = { email: 'mary@school.ac.ke', name: 'Mary Wanjiku', 'custom:school_id': 'sch_1' };

test('auth-mail trigger: words the forgot-password code and keeps Cognito’s placeholder', async () => {
  const event = { triggerSource: 'CustomMessage_ForgotPassword', request: { userAttributes, codeParameter: '{####}' }, response: {} };
  const out = await makeHandler()(event);
  assert.match(out.response.emailSubject, /reset code/);
  assert.ok(out.response.emailMessage.includes('{####}'));
  assert.match(out.response.emailMessage, /Hello Mary,/);
});

test('auth-mail trigger: a finished reset sends a "password changed" notice for the right portal', async () => {
  const sent = [];
  const event = { triggerSource: 'PostConfirmation_ConfirmForgotPassword', request: { userAttributes: { email: 'jane@angazacenter.org', name: 'Jane' } }, response: {} };
  await makeHandler(async (m) => { sent.push(m); })(event);
  assert.equal(sent[0].kind, 'password-changed');
  assert.match(sent[0].text, /angaza\/sign-in/);
});

test('auth-mail trigger: never fails Cognito, and leaves other messages alone', async () => {
  const event = { triggerSource: 'PostConfirmation_ConfirmForgotPassword', request: { userAttributes }, response: {} };
  assert.equal(await makeHandler(async () => { throw new Error('SES down'); })(event), event);
  const other = { triggerSource: 'CustomMessage_AdminCreateUser', request: { userAttributes, codeParameter: '{####}' }, response: {} };
  assert.deepEqual((await makeHandler()(other)).response, {});
});
