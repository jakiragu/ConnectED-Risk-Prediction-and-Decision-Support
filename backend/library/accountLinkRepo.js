import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { GOOGLE_PK, PLATFORM_PK, TABLE, googleSk, pk, platformSk, sk } from './keys.js';
import { ulid } from './ids.js';

/**
 * Records behind "sign-in methods". The link itself lives in the sign-in
 * service (googleIdentity.js); these records hold what it cannot:
 *
 *   SIGNIN#<sub>          which Google address is linked and since when, or that the
 *                         person's link was removed on purpose (auto_link_off)
 *   LINKREQUEST#<sub>     the person's one pending link request (a hash, ten minutes)
 *   ACCOUNTPOLICY#DEFAULT the school's choice of who may link (schools only)
 *   ACCOUNTAUDIT#<ulid>   who linked, changed or removed what, and policy changes
 *   GOOGLEACCOUNT/<pool>#<google id>  one claim per Google account
 *
 * Every field is optional and every record may be absent: a school that never
 * opened the Accounts tab has none of them, and behaves as "nobody may link".
 *
 * A realm says whose records these are:
 *   { kind: 'school', schoolId, pool, portal: 'school' }   in the school's partition
 *   { kind: 'angaza', pool, portal: 'angaza' }             in the Angaza partition
 */
export const schoolRealm = (schoolId, env = process.env) => ({ kind: 'school', schoolId, pool: env.COGNITO_USER_POOL_ID, portal: 'school' });
export const angazaRealm = (env = process.env) => ({ kind: 'angaza', schoolId: null, pool: env.PLATFORM_COGNITO_USER_POOL_ID, portal: 'angaza' });
/** The realm of a sign-in pool, for the pre-sign-up trigger, which knows only the pool and the account. */
export const realmOf = (pool, schoolId) => (schoolId ? { kind: 'school', schoolId, pool, portal: 'school' } : { kind: 'angaza', schoolId: null, pool, portal: 'angaza' });

const partition = (realm) => (realm.kind === 'school' ? pk(realm.schoolId) : PLATFORM_PK);
const key = (realm, SK) => ({ PK: partition(realm), SK });
const personKey = (realm, sub) => key(realm, realm.kind === 'school' ? sk.teacher(sub) : platformSk.staff(sub));
const get = async (Key) => (await ddb.send(new GetCommand({ TableName: TABLE, Key, ConsistentRead: true }))).Item || null;
const failed = (e) => e.name === 'ConditionalCheckFailedException';

// ------------------------------------------------------------ a person's link

export const signIn = (realm, sub) => get(key(realm, sk.signIn(sub)));

export async function signIns(realm) {
  const out = new Map();
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': partition(realm), ':s': sk.signInPrefix() },
      ExclusiveStartKey,
    }));
    for (const item of res.Items || []) out.set(item.sub, item);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const putSignIn = (realm, sub, fields) => ddb.send(new PutCommand({
  TableName: TABLE,
  Item: { ...key(realm, sk.signIn(sub)), entity: 'SignInMethods', sub, school_id: realm.schoolId, ...fields, updated_at: new Date().toISOString() },
}));

/** A link was made. Clears any "do not relink automatically" marker: the person linked again on purpose. */
export const saveLinked = (realm, sub, { googleSub, googleEmail, at, by }) =>
  putSignIn(realm, sub, { google_sub: googleSub, google_email: googleEmail ?? null, linked_at: at, linked_by: by });

/** A link was removed. From now on a matching Google address is NOT linked automatically at sign-in. */
export const saveRemoved = (realm, sub, { at, by }) =>
  putSignIn(realm, sub, { auto_link_off: true, removed_at: at, removed_by: by });

// --------------------------------------------------------------- link requests

/** One pending request per person; starting again replaces the earlier one, which then no longer works. */
export const putLinkRequest = (realm, sub, { nonceHash, expiresAt }) => ddb.send(new PutCommand({
  TableName: TABLE,
  Item: { ...key(realm, sk.linkRequest(sub)), entity: 'GoogleLinkRequest', sub, nonce_hash: nonceHash, expires_at: expiresAt },
}));

/**
 * Uses the request up. True only for the first caller presenting the right value in time:
 * the delete is conditional, so two answers to the same request cannot both succeed.
 */
export async function consumeLinkRequest(realm, sub, nonceHash, nowSeconds) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: key(realm, sk.linkRequest(sub)),
      ConditionExpression: 'nonce_hash = :h AND expires_at > :now',
      ExpressionAttributeValues: { ':h': nonceHash, ':now': nowSeconds },
    }));
    return true;
  } catch (e) {
    if (failed(e)) return false;
    throw e;
  }
}

// ------------------------------------------- one ConnectED account per Google account

/** True if this Google account is free or already this person's. Never takes another person's claim. */
export async function claimGoogle(realm, googleSub, sub) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { PK: GOOGLE_PK, SK: googleSk(realm.pool, googleSub), entity: 'GoogleAccountClaim', owner_sub: sub, school_id: realm.schoolId, claimed_at: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(PK) OR owner_sub = :me',
      ExpressionAttributeValues: { ':me': sub },
    }));
    return true;
  } catch (e) {
    if (failed(e)) return false;
    throw e;
  }
}

export async function releaseGoogle(realm, googleSub, sub) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { PK: GOOGLE_PK, SK: googleSk(realm.pool, googleSub) },
      ConditionExpression: 'owner_sub = :me',
      ExpressionAttributeValues: { ':me': sub },
    }));
  } catch (e) {
    if (!failed(e)) throw e;
  }
}

// ----------------------------------------------------------------- school policy

export const POLICIES = ['NOBODY', 'TEACHERS', 'TEACHERS_AND_ADMINS'];
export const DEFAULT_POLICY = 'NOBODY';

export async function policy(schoolId) {
  const item = await get({ PK: pk(schoolId), SK: sk.accountPolicy() });
  return item || { school_id: schoolId, google_linking: DEFAULT_POLICY, _version: 0, updated_at: null };
}

/** expectedVersion is the _version the administrator was editing; stale => ConditionalCheckFailedException. */
export async function savePolicy(schoolId, googleLinking, expectedVersion, actor) {
  const item = {
    PK: pk(schoolId), SK: sk.accountPolicy(), entity: 'AccountPolicy', school_id: schoolId,
    google_linking: googleLinking, _version: expectedVersion + 1, updated_at: new Date().toISOString(), updated_by: actor.sub,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#v = :exp',
    ...(expectedVersion === 0 ? {} : { ExpressionAttributeNames: { '#v': '_version' }, ExpressionAttributeValues: { ':exp': expectedVersion } }),
  }));
  return item;
}

// ------------------------------------------------------------------------ audit

/** subject: whose account changed (null for a policy change). Details never hold a Google id, only the address shown. */
export const audit = (realm, action, actor, subject, details = {}) => ddb.send(new PutCommand({
  TableName: TABLE,
  Item: {
    ...key(realm, sk.accountAudit(ulid())), entity: 'AccountAudit', school_id: realm.schoolId, action,
    by_sub: actor.sub, by_name: actor.name ?? null, subject_sub: subject ?? null, at: new Date().toISOString(), details,
  },
}));

export async function audits(realm) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ExpressionAttributeValues: { ':p': partition(realm), ':s': sk.accountAuditPrefix() },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Removes what these records hold about one person when their account is deleted: which Google
 * account was linked, any pending link request, and the Google address quoted in earlier audit
 * entries about them. The audit entries themselves stay, with who did what and when.
 */
export async function forgetPerson(realm, sub) {
  for (const SK of [sk.signIn(sub), sk.linkRequest(sub)]) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: key(realm, SK) }));
  for (const row of await audits(realm)) {
    if (row.subject_sub !== sub || !(row.details && ('google_email' in row.details || 'previous_google_email' in row.details))) continue;
    const { google_email: _a, previous_google_email: _b, ...details } = row.details;
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET #d = :d',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#d': 'details' },
      ExpressionAttributeValues: { ':d': details },
    }));
  }
}

// --------------------------------------------------------------------- sessions

/**
 * Stamps the person's own record (teacher or Angaza staff), which every request already reads
 * (actor.js, platformActor.js): any session that began before this second is refused from now on.
 */
export async function markSessionsEnded(realm, sub, seconds, reason) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: personKey(realm, sub),
      UpdateExpression: 'SET sessions_ended_at = :at, sessions_ended_reason = :why',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':at': seconds, ':why': reason },
    }));
  } catch (e) {
    if (!failed(e)) throw e;
  }
}
