import { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand, AdminLinkProviderForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { googleLinked } from '../../backend/library/accountEmails.js';
import * as linkStore from '../../backend/library/accountLinkRepo.js';
import { sendEmail } from '../../backend/library/mailer.js';
const client = new CognitoIdentityProviderClient({});
const GMAIL = ['gmail.com', 'googlemail.com'];
// Case-insensitive pools (CaseSensitive: false) hand the trigger a lower-case federated username: "google_<id>".
const isGoogleName = name => /^google_/i.test(String(name || ''));
/*
 * Automatic linking at "Continue with Google": a Google sign-in whose verified address equals an
 * existing account's email is linked to that account. Explicit linking of a different Google
 * address happens from My Profile (backend/library/accountLink.js), never here.
 *
 * Google's address reaches this trigger as `nickname` and its verified flag as `profile`, not as
 * `email` and `email_verified`: the provider no longer maps onto those, so a Google sign-in can
 * never overwrite the school email or name on the account (see template.py).
 */
export const makeHandler = (send = command => client.send(command), notify = sendEmail, store = linkStore) => async event => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  const attrs = event.request?.userAttributes || {};
  // `email`/`email_verified` are read only while a pool still has the earlier mapping (before this version is deployed to it).
  const email = String(attrs.nickname || attrs.email || '').toLowerCase();
  const verified = String(attrs.profile ?? attrs.email_verified).toLowerCase();
  const domain = email.split('@')[1];
  // Every refusal logs which check failed, with no email address or Google ID in the log.
  const refuse = (reason, message, extra = {}) => {
    console.log(JSON.stringify({ refused: reason, triggerSource: event.triggerSource, prefix: String(event.userName).split('_')[0],
      emailVerified: verified, gmail: GMAIL.includes(domain), hdPresent: Boolean(attrs['custom:google_hd']),
      hdMatches: attrs['custom:google_hd'] === domain, ...extra }));
    throw new Error(message);
  };
  if (event.triggerSource !== 'PreSignUp_ExternalProvider' || !isGoogleName(event.userName)) refuse('not-google', 'Ask your administrator to create your account first.');
  if (verified !== 'true') refuse('unverified', 'Google must verify your email first.');
  // Google is authoritative for Gmail or a Workspace domain carried in its signed hd claim.
  // Other consumer Google addresses need an explicitly reviewed linking process.
  if (!GMAIL.includes(domain) && attrs['custom:google_hd'] !== domain) refuse('not-workspace', 'Automatic linking requires Gmail or a Google Workspace email. Use your password for this account.');
  const escaped = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await send(new ListUsersCommand({ UserPoolId: event.userPoolId, Filter: `email = "${escaped}"`, Limit: 60 }));
  const candidates = (result.Users || []).filter(u => u.Enabled && u.UserStatus === 'CONFIRMED' && !isGoogleName(u.Username) &&
    u.Attributes?.some(a => a.Name === 'email_verified' && a.Value === 'true'));
  if (candidates.length !== 1 || result.PaginationToken) refuse('no-candidate', 'First sign in with your invited email and temporary password, then try Google.',
    { found: (result.Users || []).length, eligible: candidates.length });
  const user = candidates[0];
  const { Groups = [] } = await send(new AdminListGroupsForUserCommand({ UserPoolId: event.userPoolId, Username: user.Username }));
  const schoolId = user.Attributes.find(a => a.Name === 'custom:school_id')?.Value;
  if (!(schoolId ? Groups.some(g => ['Admin', 'Teacher'].includes(g.GroupName)) : Groups.some(g => g.GroupName === 'PlatformAdmin'))) refuse('no-group', 'This account has not been assigned access.');
  const googleSub = String(event.userName).slice('google_'.length);
  const sub = user.Attributes.find(a => a.Name === 'sub')?.Value || user.Username;
  const realm = store.realmOf(event.userPoolId, schoolId);
  // A link the person (or their administrator) removed must stay removed: no quiet relinking here.
  // If the record cannot be read, refuse rather than guess.
  let record;
  try { record = await store.signIn(realm, sub); }
  catch (error) { refuse('link-record-unreadable', 'Google sign-in is unavailable right now. Use your password, or try again shortly.', { error: error?.name }); }
  if (record?.auto_link_off) refuse('link-removed', 'Google sign-in was removed from this account. Log in with your password, then link Google again from My Profile.');
  // One ConnectED account per Google account.
  if (!(await store.claimGoogle(realm, googleSub, sub))) refuse('google-in-use', 'This Google account is already linked to another ConnectED account.');
  await send(new AdminLinkProviderForUserCommand({ UserPoolId: event.userPoolId,
    DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: user.Username },
    // The provider is always named "Google" in the pool, whatever case the username arrived in.
    SourceUser: { ProviderName: 'Google', ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: googleSub } }));
  // A new way into the account: tell its owner. Sign-in must not wait on or fail with the email.
  try {
    const name = user.Attributes.find(a => a.Name === 'name')?.Value || '';
    // So My Profile and the administrator's Accounts list can show which address is linked, and since when.
    await store.saveLinked(realm, sub, { googleSub, googleEmail: email, at: new Date().toISOString(), by: 'AUTOMATIC' });
    await store.audit(realm, 'GOOGLE_LINKED', { sub, name: name || null }, sub, { google_email: email, automatic: true });
    await notify(googleLinked({ to: email, firstName: name.split(' ')[0], googleEmail: email, portal: schoolId ? 'school' : 'angaza' }));
  } catch (error) {
    console.log(JSON.stringify({ notice: 'google-linked-email-failed', error: error?.name }));
  }
  return event;
};
export const handler = makeHandler();
