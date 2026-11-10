import { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand, AdminLinkProviderForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({});
const GMAIL = ['gmail.com', 'googlemail.com'];
// Case-insensitive pools (CaseSensitive: false) hand the trigger a lower-case federated username: "google_<id>".
const isGoogleName = name => /^google_/i.test(String(name || ''));
export const makeHandler = (send = command => client.send(command)) => async event => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  const attrs = event.request?.userAttributes || {};
  const email = String(attrs.email || '').toLowerCase();
  const domain = email.split('@')[1];
  // Every refusal logs which check failed, with no email address or Google ID in the log.
  const refuse = (reason, message, extra = {}) => {
    console.log(JSON.stringify({ refused: reason, triggerSource: event.triggerSource, prefix: String(event.userName).split('_')[0],
      emailVerified: String(attrs.email_verified), gmail: GMAIL.includes(domain), hdPresent: Boolean(attrs['custom:google_hd']),
      hdMatches: attrs['custom:google_hd'] === domain, ...extra }));
    throw new Error(message);
  };
  if (event.triggerSource !== 'PreSignUp_ExternalProvider' || !isGoogleName(event.userName)) refuse('not-google', 'Ask your administrator to create your account first.');
  if (String(attrs.email_verified).toLowerCase() !== 'true') refuse('unverified', 'Google must verify your email first.');
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
  await send(new AdminLinkProviderForUserCommand({ UserPoolId: event.userPoolId,
    DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: user.Username },
    // The provider is always named "Google" in the pool, whatever case the username arrived in.
    SourceUser: { ProviderName: 'Google', ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: String(event.userName).slice('google_'.length) } }));
  return event;
};
export const handler = makeHandler();
