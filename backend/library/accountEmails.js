/**
 * The words of every account email ConnectED sends. Each function returns
 * { kind, to, subject, text, html } for mailer.sendEmail; nothing here sends.
 *
 * Two portals, two audiences:
 *   school  teachers and school administrators, signing in at /sign-in
 *   angaza  Angaza staff, signing in at /angaza/sign-in
 *
 * Every email has a plain-text part (read by many school mail clients and
 * screen readers) and a simple HTML part with no images or tracking.
 */

const siteUrl = (env = process.env) => String(env.SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
export const signInUrl = (portal, env = process.env) => `${siteUrl(env)}${portal === 'angaza' ? '/angaza/sign-in' : '/sign-in'}`;

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const greet = (first) => (first ? `Hello ${first},` : 'Hello,');
const roleName = (role) => (role === 'Admin' ? 'an administrator' : role === 'PlatformAdmin' ? 'a member of the Angaza team' : 'a teacher');
const helpLine = (portal) => (portal === 'angaza'
  ? 'If this was not you, tell the Angaza team straight away.'
  : 'If this was not you, tell your school’s ConnectED administrator straight away. Administrators can contact Angaza.');

/**
 * paragraphs: plain strings. facts: [label, value, { code: true }?]. button: { label, href }.
 * The text part carries exactly the same content as the HTML part.
 */
function compose({ kind, to, subject, paragraphs, facts = [], button, after = [] }) {
  const textFacts = facts.map(([label, value]) => `${label}: ${value}`);
  const text = [
    ...paragraphs,
    ...(textFacts.length ? [textFacts.join('\n')] : []),
    ...(button ? [`${button.label}: ${button.href}`] : []),
    ...after,
    '— ConnectED',
  ].join('\n\n');

  const p = (s) => `<p style="margin:0 0 16px">${escape(s)}</p>`;
  const factRows = facts.map(([label, value, opts = {}]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#5b6472;white-space:nowrap;vertical-align:top">${escape(label)}</td>`
    + `<td style="padding:6px 0;${opts.code ? 'font-family:Consolas,Menlo,monospace;font-size:16px;letter-spacing:1px;' : ''}word-break:break-all">${escape(value)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2933">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:8px;padding:28px">
<div style="font-weight:700;font-size:18px;margin-bottom:20px">ConnectED</div>
${paragraphs.map(p).join('\n')}
${factRows ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 20px">${factRows}</table>` : ''}
${button ? `<p style="margin:0 0 20px"><a href="${escape(button.href)}" style="display:inline-block;background:#1f4e79;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escape(button.label)}</a></p><p style="margin:0 0 16px;color:#5b6472;font-size:13px">Or open ${escape(button.href)}</p>` : ''}
${after.map(p).join('\n')}
</div></body></html>`;
  return { kind, to, subject, text, html };
}

/**
 * A new account, or a reminder for someone who has not signed in yet.
 * resend: the person was invited before and never signed in; the old temporary password no longer works.
 */
export function invitation({ to, firstName, temporaryPassword, role, schoolName, invitedBy, portal = 'school', resend = false }, env) {
  const place = portal === 'angaza' ? 'the Angaza console' : schoolName || 'your school';
  const opening = resend
    ? `${invitedBy ? `${invitedBy} sent` : 'Here is'} a new invitation to ConnectED for ${place}. Any earlier temporary password no longer works.`
    : `${invitedBy ? `${invitedBy} added you` : 'You have been added'} to ConnectED as ${roleName(role)}${portal === 'angaza' ? '' : ` at ${place}`}.`;
  return compose({
    kind: resend ? 'invitation-resent' : 'invitation',
    to,
    subject: portal === 'angaza' ? 'Your ConnectED Angaza console account' : `Your ConnectED account for ${place}`,
    paragraphs: [greet(firstName), opening, 'Sign in with these details. You will choose your own password the first time you sign in.'],
    facts: [['Email', to], ['Temporary password', temporaryPassword, { code: true }]],
    button: { label: 'Sign in to ConnectED', href: signInUrl(portal, env) },
    after: [
      'Sign in soon. If the temporary password stops working, ask for a new invitation.',
      'If you were not expecting this email, you can ignore it.',
    ],
  });
}

/** An administrator reset the password of someone who had already signed in. */
export function passwordReset({ to, firstName, temporaryPassword, resetBy, portal = 'school' }, env) {
  return compose({
    kind: 'password-reset',
    to,
    subject: 'Your ConnectED password was reset',
    paragraphs: [
      greet(firstName),
      `${resetBy ? `${resetBy} reset` : 'An administrator reset'} your ConnectED password. Your old password no longer works.`,
      'Sign in with this temporary password, then choose a new one.',
    ],
    facts: [['Email', to], ['Temporary password', temporaryPassword, { code: true }]],
    button: { label: 'Sign in to ConnectED', href: signInUrl(portal, env) },
    after: [helpLine(portal)],
  });
}

/**
 * The forgot-password code. Cognito writes the code itself: `code` is its
 * placeholder ({####}), which must appear in the message exactly once.
 */
export function forgotPasswordCode({ to, firstName, code, portal = 'school' }) {
  return compose({
    kind: 'forgot-password',
    to,
    subject: 'Your ConnectED password reset code',
    paragraphs: [greet(firstName), 'Someone asked to reset your ConnectED password. Enter this code to choose a new one.'],
    facts: [['Code', code, { code: true }]],
    after: ['If you did not ask for this, you can ignore this email. Your password has not changed.', helpLine(portal)],
  });
}

/** The person finished the forgot-password steps. */
export function passwordChanged({ to, firstName, portal = 'school' }, env) {
  return compose({
    kind: 'password-changed',
    to,
    subject: 'Your ConnectED password was changed',
    paragraphs: [greet(firstName), 'Your ConnectED password was just changed using a reset code sent to this address.'],
    button: { label: 'Sign in to ConnectED', href: signInUrl(portal, env) },
    after: [helpLine(portal)],
  });
}

/** A Google account was linked, so it can now sign in to this ConnectED account. */
export function googleLinked({ to, firstName, portal = 'school' }, env) {
  return compose({
    kind: 'google-linked',
    to,
    subject: 'Google sign-in was added to your ConnectED account',
    paragraphs: [
      greet(firstName),
      `The Google account ${to} can now sign in to your ConnectED account with “Continue with Google”. Your password still works too.`,
    ],
    button: { label: 'Open ConnectED', href: signInUrl(portal, env) },
    after: [helpLine(portal)],
  });
}

/**
 * Angaza paused or resumed a school. The reason Angaza recorded is for Angaza
 * staff only (see PlatformSchool.suspended_reason), so it is never included.
 */
export function schoolStatus({ to, firstName, schoolName, suspended }, env) {
  return compose({
    kind: suspended ? 'school-suspended' : 'school-reactivated',
    to,
    subject: suspended ? `ConnectED is paused for ${schoolName}` : `ConnectED is available again for ${schoolName}`,
    paragraphs: suspended
      ? [greet(firstName), `Angaza has paused ConnectED for ${schoolName}. Teachers and administrators cannot sign in until it is resumed.`,
        'Your school’s records are kept and nothing has been deleted. Contact Angaza to find out more.']
      : [greet(firstName), `Angaza has resumed ConnectED for ${schoolName}. Everyone at the school can sign in again.`],
    button: suspended ? undefined : { label: 'Sign in to ConnectED', href: signInUrl('school', env) },
  });
}

/**
 * Sign-in details after an administrator creates an account or resets a password.
 * stateBefore is the account's sign-in state before the reset (identity.accountState):
 * someone who never signed in gets their invitation again; anyone else is told
 * their password was reset.
 */
export function credentialsEmail({ created = false, stateBefore = null, actorName, ...details }, env) {
  if (created) return invitation({ ...details, invitedBy: actorName }, env);
  if (stateBefore === 'WAITING') return invitation({ ...details, invitedBy: actorName, resend: true }, env);
  return passwordReset({ ...details, resetBy: actorName }, env);
}
