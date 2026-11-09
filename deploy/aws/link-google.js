import { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand, AdminLinkProviderForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({});
export const makeHandler = (send = command => client.send(command)) => async event => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser') return event;
  if (event.triggerSource !== 'PreSignUp_ExternalProvider' || !event.userName.startsWith('Google_')) throw new Error('Ask your administrator to create your account first.');
  const attrs = event.request.userAttributes;
  const email = String(attrs.email || '').toLowerCase();
  if (String(attrs.email_verified).toLowerCase() !== 'true') throw new Error('Google must verify your email first.');
  // Google is authoritative for Gmail or a Workspace domain carried in its signed hd claim.
  // Other consumer Google addresses need an explicitly reviewed linking process.
  const domain = email.split('@')[1];
  if (!['gmail.com', 'googlemail.com'].includes(domain) && attrs['custom:google_hd'] !== domain) throw new Error('Automatic linking requires Gmail or a Google Workspace email. Use your password for this account.');
  const escaped = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await send(new ListUsersCommand({ UserPoolId: event.userPoolId, Filter: `email = "${escaped}"`, Limit: 60 }));
  const candidates = (result.Users || []).filter(u => u.Enabled && u.UserStatus === 'CONFIRMED' && !u.Username.startsWith('Google_') &&
    u.Attributes?.some(a => a.Name === 'email_verified' && a.Value === 'true'));
  if (candidates.length !== 1 || result.PaginationToken) throw new Error('First sign in with your invited email and temporary password, then try Google.');
  const user = candidates[0];
  const { Groups = [] } = await send(new AdminListGroupsForUserCommand({ UserPoolId: event.userPoolId, Username: user.Username }));
  const schoolId = user.Attributes.find(a => a.Name === 'custom:school_id')?.Value;
  if (!(schoolId ? Groups.some(g => ['Admin', 'Teacher'].includes(g.GroupName)) : Groups.some(g => g.GroupName === 'PlatformAdmin'))) throw new Error('This account has not been assigned access.');
  await send(new AdminLinkProviderForUserCommand({ UserPoolId: event.userPoolId,
    DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: user.Username },
    SourceUser: { ProviderName: 'Google', ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: event.userName.slice('Google_'.length) } }));
  return event;
};
export const handler = makeHandler();
