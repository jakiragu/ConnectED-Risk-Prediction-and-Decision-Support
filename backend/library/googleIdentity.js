import {
  AdminDisableProviderForUserCommand,
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { cognito, ddb } from './client.js';
import { TABLE } from './keys.js';

/**
 * The sign-in service's side of a Google link. Cognito holds the link itself:
 * a linked Google account signs in AS the school-issued account, with its
 * school, role and email. Cognito is therefore the source of truth for whether
 * a link exists; the database only remembers the address to show and when.
 *
 *   identities(pool, username)  -> { google: [{ sub, linkedAt }], lastSeenEmail }
 *   link(pool, username, googleSub)
 *   unlink(pool, googleSub)
 *   endSessions(pool, username)   every refresh token stops working
 */
const PROVIDER = 'Google';
const attr = (user, name) => (user.UserAttributes || user.Attributes || []).find((a) => a.Name === name)?.Value ?? null;

export const cloud = (send = (command) => cognito.send(command)) => ({
  async identities(pool, username) {
    const user = await send(new AdminGetUserCommand({ UserPoolId: pool, Username: username }));
    let linked = [];
    try { linked = JSON.parse(attr(user, 'identities') || '[]'); } catch { linked = []; }
    return {
      google: linked.filter((i) => String(i.providerName).toLowerCase() === 'google').map((i) => ({
        sub: String(i.userId),
        linkedAt: Number(i.dateCreated) ? new Date(Number(i.dateCreated)).toISOString() : null,
      })),
      // The Google address as of the last Google sign-in (the provider maps it to `nickname`; see deploy/aws/template.py).
      lastSeenEmail: attr(user, 'nickname'),
    };
  },
  link: (pool, username, googleSub) => send(new AdminLinkProviderForUserCommand({
    UserPoolId: pool,
    DestinationUser: { ProviderName: 'Cognito', ProviderAttributeValue: username },
    SourceUser: { ProviderName: PROVIDER, ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: googleSub },
  })),
  unlink: (pool, googleSub) => send(new AdminDisableProviderForUserCommand({
    UserPoolId: pool,
    User: { ProviderName: PROVIDER, ProviderAttributeName: 'Cognito_Subject', ProviderAttributeValue: googleSub },
  })),
  endSessions: (pool, username) => send(new AdminUserGlobalSignOutCommand({ UserPoolId: pool, Username: username })),
});

/**
 * Local development: cognito-local has no identity linking, so links are kept in the
 * local table instead. Same interface, same refusal when a Google account is already taken.
 */
const localKey = (pool, id) => ({ PK: 'LOCALIDP', SK: `${pool}#${id}` });
export const local = () => {
  const read = async (pool, id) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: localKey(pool, id), ConsistentRead: true }))).Item || null;
  const write = (pool, id, item) => ddb.send(new PutCommand({ TableName: TABLE, Item: { ...localKey(pool, id), entity: 'LocalIdentityLink', ...item } }));
  return {
    async identities(pool, username) {
      const item = await read(pool, `user#${username}`);
      return { google: item?.google || [], lastSeenEmail: null };
    },
    async link(pool, username, googleSub) {
      const owner = await read(pool, `google#${googleSub}`);
      if (owner?.username && owner.username !== username) throw Object.assign(new Error('Already linked'), { name: 'InvalidParameterException' });
      const item = await read(pool, `user#${username}`);
      const google = [...(item?.google || []).filter((g) => g.sub !== googleSub), { sub: googleSub, linkedAt: new Date().toISOString() }];
      await write(pool, `user#${username}`, { google });
      await write(pool, `google#${googleSub}`, { username });
    },
    async unlink(pool, googleSub) {
      const owner = await read(pool, `google#${googleSub}`);
      if (!owner?.username) return;
      const item = await read(pool, `user#${owner.username}`);
      await write(pool, `user#${owner.username}`, { google: (item?.google || []).filter((g) => g.sub !== googleSub) });
      await write(pool, `google#${googleSub}`, { username: null });
    },
    async endSessions() { /* cognito-local cannot revoke; the API still refuses older sessions (actor.js) */ },
  };
};

const isLocal = (env = process.env) => {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.COGNITO_ENDPOINT).hostname); } catch { return false; }
};
export const identityProvider = (env = process.env) => (isLocal(env) ? local() : cloud());
