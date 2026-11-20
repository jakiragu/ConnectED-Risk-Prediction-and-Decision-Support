import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * Linking a personal Google account (My Profile, Settings > Accounts, the Angaza
 * console's My Profile), through the real GraphQL schema and resolver map against
 * an in-process DynamoDB.
 *
 * Google is played by local/google-stand-in.js, which signs ID tokens with its own
 * key; the server verifies them over HTTP exactly as it verifies Google's. The
 * sign-in service is the local stand-in for identity links (googleIdentity.js),
 * and, where a case needs it to fail, a stub. Against real Cognito and real Google
 * the same flow is checked by hand after deployment (deploy/aws/README.md).
 *
 *   npm run test:store
 */
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
const SCHOOL_POOL = 'eu-west-1_schoolPool';
const ANGAZA_POOL = 'eu-west-1_angazaPool';
const SCHOOL = 'sch_link_test';
const OTHER_SCHOOL = 'sch_link_other';
const ISSUER = (pool) => `http://localhost:9229/${pool}`;
let schema; let graphql; let ops; let schoolOps; let ddb; let Put; let Get; let keys; let google; let links; let repo; let googleToken;
let clock = Math.floor(Date.now() / 1000);

/** An identity as AppSync passes it. age: seconds since the person signed in. */
const person = (sub, group, { school = SCHOOL, age = 0, issuedAgo = age } = {}) => ({
  sub, issuer: ISSUER(SCHOOL_POOL), groups: [group],
  claims: { iss: ISSUER(SCHOOL_POOL), 'custom:school_id': school, email: `${sub}@token.example`, auth_time: clock - age, iat: clock - issuedAgo },
});
const staff = (age = 0) => ({ sub: 'u_staff', issuer: ISSUER(ANGAZA_POOL), groups: ['PlatformAdmin'], claims: { iss: ISSUER(ANGAZA_POOL), email: 'asha@angazacenter.org', auth_time: clock - age, iat: clock - age } });

before(async () => {
  await new Promise((r) => server.listen(0, r));
  const { startGoogleStandIn } = await import('../../local/google-stand-in.js');
  google = startGoogleStandIn(0);
  await new Promise((r) => google.once('listening', r));
  Object.assign(process.env, {
    DDB_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    EVENTS_ENDPOINT: 'http://127.0.0.1:9',
    COGNITO_ENDPOINT: 'http://127.0.0.1:9',
    GOOGLE_STANDIN_URL: `http://localhost:${google.address().port}`,
    GRADEBOOK_TABLE_NAME: 'account_link_test',
    AWS_REGION: 'eu-west-1',
    COGNITO_USER_POOL_ID: SCHOOL_POOL,
    PLATFORM_COGNITO_USER_POOL_ID: ANGAZA_POOL,
    SITE_URL: 'http://localhost:5173',
    MAIL_TRANSPORT: 'off',
  });
  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  ({ PutCommand: Put, GetCommand: Get } = await import('@aws-sdk/lib-dynamodb'));
  ({ ddb } = await import('../../backend/library/client.js'));
  (await import('../helpers/transactShim.js')).emulateTransactions(ddb);
  const { TABLE_DEFINITION } = await import('../../infra/table-definition.js');
  const { StreamSpecification, ...table } = TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  keys = await import('../../backend/library/keys.js');
  links = await import('../../backend/library/accountLink.js');
  repo = await import('../../backend/library/accountLinkRepo.js');
  googleToken = await import('../../backend/library/googleToken.js');

  graphql = await import('graphql');
  const { createSchema } = await import('graphql-yoga');
  const { RESOLVERS } = await import('../../local/resolvers.js');
  const resolvers = { Query: {}, Mutation: {} };
  for (const [parent, fields] of Object.entries(RESOLVERS)) {
    for (const [field, service] of Object.entries(fields)) {
      resolvers[parent][field] = (_root, args, ctx) => service({ arguments: args, identity: ctx.identity, info: { fieldName: field, parentTypeName: parent } });
    }
  }
  schema = createSchema({ typeDefs: readFileSync('graphql/schema/gradebook.graphql', 'utf8'), resolvers });
  ops = await import('../../src/api/accountOperations.js');
  schoolOps = await import('../../src/api/operations.js');

  const put = (PK, Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK, ...Item } }));
  for (const school of [SCHOOL, OTHER_SCHOOL]) await put(keys.pk(school), { SK: keys.sk.school(), school_id: school, name: school, status: 'ACTIVE' });
  const teacher = (school, id, role, first, extra = {}) => put(keys.pk(school), {
    SK: keys.sk.teacher(id), school_id: school, teacher_id: id, role, first_name: first, last_name: 'Test', email: `${id}@school.example`, status: 'ACTIVE', _version: 1, ...extra });
  await teacher(SCHOOL, 'u_jane', 'Teacher', 'Jane');
  await teacher(SCHOOL, 'u_peter', 'Teacher', 'Peter');
  await teacher(SCHOOL, 'u_admin', 'Admin', 'John');
  await teacher(SCHOOL, 'u_left', 'Teacher', 'Gone', { status: 'INACTIVE' });
  await teacher(OTHER_SCHOOL, 'u_other', 'Teacher', 'Olive');
  await teacher(OTHER_SCHOOL, 'u_other_admin', 'Admin', 'Omar');
  await put(keys.PLATFORM_PK, { SK: keys.platformSk.staff('u_staff'), staff_id: 'u_staff', first_name: 'Asha', last_name: 'Staff', email: 'asha@angazacenter.org', status: 'ACTIVE' });
});

after(async () => {
  await new Promise((r) => google.close(r));
  await new Promise((r) => server.close(r));
});

async function run(identity, document, variables = {}) {
  const res = await graphql.execute({ schema, document: graphql.parse(document), variableValues: variables, contextValue: { identity } });
  if (res.errors?.length) {
    const e = res.errors[0];
    if (!e.originalError?.type) throw new Error(e.message);
    return { error: { type: e.originalError.type, message: e.message } };
  }
  return res.data;
}

/** What the browser does: follow the chooser's address, pick an account, read the token from the address it is sent back to. */
async function chooseAt(url, account, { expectState } = {}) {
  const res = await fetch(`${url}&account=${encodeURIComponent(account)}`, { redirect: 'manual' });
  const back = new URL(res.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, 'http://localhost:5173/auth/google-link');
  const answer = new URLSearchParams(back.hash.slice(1));
  if (expectState) assert.equal(answer.get('state'), expectState);
  return answer.get('id_token');
}
const input = (extra = {}) => ({ input: { school_id: SCHOOL, ...extra } });
async function link(identity, account) {
  const started = await run(identity, ops.START_GOOGLE_LINK, input());
  if (started.error) return started;
  const token = await chooseAt(started.startGoogleLink.url, account, { expectState: started.startGoogleLink.state });
  return run(identity, ops.COMPLETE_GOOGLE_LINK, input({ id_token: token }));
}
const setPolicy = async (google_linking) => {
  const { getAccountPolicy } = await run(person('u_admin', 'Admin'), ops.GET_ACCOUNT_POLICY, { school_id: SCHOOL });
  return run(person('u_admin', 'Admin'), ops.SAVE_ACCOUNT_POLICY, input({ google_linking, _version: getAccountPolicy._version }));
};
const audits = async () => (await repo.audits(repo.schoolRealm(SCHOOL))).map((a) => a.action);
const teacherRecord = async (id) => (await ddb.send(new Get({ TableName: keys.TABLE, Key: { PK: keys.pk(SCHOOL), SK: keys.sk.teacher(id) } }))).Item;

const meta = (id, scenario, data, expected, technique = 'Black box, authorisation') =>
  ({ id, requirement: 'EXT-LINK, NFR-1', level: 'Integration (store)', technique, scenario, data, expected });

tc(meta('TC-LNK01', 'Nothing changes until an administrator opts in',
  'a school that never saved the setting; a teacher and an administrator ask for their sign-in methods and try to start a link',
  'The policy reads NOBODY (never saved); both see email and password only, cannot link, and are told who can change that; starting a link is Forbidden'),
async (ev) => {
  const { getAccountPolicy } = await run(person('u_admin', 'Admin'), ops.GET_ACCOUNT_POLICY, { school_id: SCHOOL });
  assert.deepEqual([getAccountPolicy.google_linking, getAccountPolicy._version], ['NOBODY', 0]);
  for (const who of [person('u_jane', 'Teacher'), person('u_admin', 'Admin')]) {
    const { getSignInMethods: m } = await run(who, ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL });
    assert.deepEqual([m.password, m.google_linked, m.can_link, m.google_available], [true, false, false, true]);
    assert.match(m.blocked_reason, /administrator/i);
    assert.equal((await run(who, ops.START_GOOGLE_LINK, input())).error.type, 'Forbidden');
  }
  ev('policy NOBODY at version 0; teacher and administrator both refused with the reason shown');
});

tc(meta('TC-LNK02', 'Only administrators choose who may link, and widening the choice needs a recent sign-in',
  'a teacher saves the policy; an administrator who signed in 11 minutes ago widens it; the same administrator signed in just now; a stale version; narrowing with an old sign-in',
  'Teacher: Forbidden. Old sign-in: ReauthRequired and nothing saved. Recent: saved and audited. Stale version: Conflict. Narrowing needs no recent sign-in'),
async (ev) => {
  assert.equal((await run(person('u_jane', 'Teacher'), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'TEACHERS', _version: 0 }))).error.type, 'Forbidden');
  assert.equal((await run(person('u_jane', 'Teacher'), ops.GET_ACCOUNT_POLICY, { school_id: SCHOOL })).error.type, 'Forbidden');
  const old = await run(person('u_admin', 'Admin', { age: 660 }), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'TEACHERS_AND_ADMINS', _version: 0 }));
  assert.equal(old.error.type, 'ReauthRequired');
  assert.equal((await repo.policy(SCHOOL))._version, 0);
  const saved = await run(person('u_admin', 'Admin'), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'TEACHERS_AND_ADMINS', _version: 0 }));
  assert.deepEqual([saved.saveAccountPolicy.google_linking, saved.saveAccountPolicy._version], ['TEACHERS_AND_ADMINS', 1]);
  assert.equal((await run(person('u_admin', 'Admin'), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'NOBODY', _version: 0 }))).error.type, 'Conflict');
  const narrowed = await run(person('u_admin', 'Admin', { age: 3000 }), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'TEACHERS', _version: 1 }));
  assert.equal(narrowed.saveAccountPolicy.google_linking, 'TEACHERS');
  assert.deepEqual(await audits(), ['GOOGLE_LINK_POLICY_CHANGED', 'GOOGLE_LINK_POLICY_CHANGED']);
  ev('widening refused after 11 minutes, accepted after a fresh sign-in; narrowing accepted with an old sign-in; 2 audit rows');
});

tc(meta('TC-LNK03', 'The school’s choice is enforced on the server for each role',
  'policy TEACHERS: an administrator starts a link; policy TEACHERS_AND_ADMINS: the administrator starts a link',
  'Under TEACHERS the administrator is Forbidden with a reason naming teachers; under TEACHERS_AND_ADMINS the administrator may start'),
async (ev) => {
  const refused = await run(person('u_admin', 'Admin'), ops.START_GOOGLE_LINK, input());
  assert.equal(refused.error.type, 'Forbidden');
  assert.match(refused.error.message, /teachers, but not administrators/);
  await setPolicy('TEACHERS_AND_ADMINS');
  assert.ok((await run(person('u_admin', 'Admin'), ops.START_GOOGLE_LINK, input())).startGoogleLink.url);
  await setPolicy('TEACHERS');
  ev(refused.error.message);
});

tc(meta('TC-LNK04', 'A teacher links a Google account whose address differs from the school email',
  'u_jane, signed in just now, starts a link, chooses janedoe@gmail.com at the chooser and returns its answer',
  'Linked: the profile shows janedoe@gmail.com and when; the school email on the record is unchanged; the link is audited; starting needs a recent sign-in',
  'Black box, interface'),
async (ev) => {
  assert.equal((await run(person('u_jane', 'Teacher', { age: 601 }), ops.START_GOOGLE_LINK, input())).error.type, 'ReauthRequired');
  const done = await link(person('u_jane', 'Teacher'), 'JaneDoe@gmail.com');
  const m = done.completeGoogleLink.sign_in;
  assert.deepEqual([done.completeGoogleLink.signed_out, m.google_linked, m.google_email, m.confirmed], [false, true, 'janedoe@gmail.com', true]);
  assert.ok(Date.parse(m.google_linked_at) > 0);
  const { me } = await run(person('u_jane', 'Teacher'), schoolOps.ME, { school_id: SCHOOL });
  assert.deepEqual([me.email, me.role, me.school_id], ['u_jane@school.example', 'Teacher', SCHOOL]);
  assert.equal((await audits()).at(-1), 'GOOGLE_LINKED');
  assert.equal((await teacherRecord('u_jane')).sessions_ended_at, undefined);
  ev(`linked ${m.google_email} at ${m.google_linked_at}; school email still ${me.email}; no sessions ended`);
});

tc(meta('TC-LNK05', 'Google’s answer must be genuine, for ConnectED, current, and tied to this person’s unused request',
  'the same answer replayed; an answer to another person’s request; a token signed by a different key; a token for another client id; an expired token; a browser-supplied address with no token',
  'Every one is refused as a ValidationError and nothing is linked',
  'Black box, negative'),
async (ev) => {
  const { createSign, generateKeyPairSync } = await import('node:crypto');
  const config = googleToken.googleConfig();
  const peter = person('u_peter', 'Teacher');
  const realm = repo.schoolRealm(SCHOOL);
  const refusedAs = async (identity, token) => (await run(identity, ops.COMPLETE_GOOGLE_LINK, input({ id_token: token }))).error?.type;

  // Replay: a request that has been used cannot be used again.
  const first = await run(peter, ops.START_GOOGLE_LINK, input());
  const token = await chooseAt(first.startGoogleLink.url, 'peter.personal@gmail.com');
  assert.equal((await run(peter, ops.COMPLETE_GOOGLE_LINK, input({ id_token: token }))).completeGoogleLink.sign_in.google_linked, true);
  assert.equal(await refusedAs(peter, token), 'ValidationError');
  // Another person presenting Peter's answer: it is not the answer to THEIR request.
  await run(person('u_jane', 'Teacher'), ops.START_GOOGLE_LINK, input());
  assert.equal(await refusedAs(person('u_jane', 'Teacher'), token), 'ValidationError');
  assert.equal((await run(person('u_jane', 'Teacher'), ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).getSignInMethods.google_email, 'janedoe@gmail.com');

  // Forged and wrong tokens, each against a live request so only the token is at fault.
  const forge = (claims, key) => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${b({ alg: 'RS256', kid: 'local-stand-in-key' })}.${b(claims)}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
  };
  const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const now = Math.floor(Date.now() / 1000);
  const live = async () => {
    const nonce = googleToken.randomToken();
    await repo.putLinkRequest(realm, 'u_peter', { nonceHash: googleToken.hashNonce(nonce), expiresAt: now + 600 });
    return { iss: config.issuers[0], aud: config.clientId, sub: '999', email: 'evil@gmail.com', email_verified: true, nonce, iat: now, exp: now + 300 };
  };
  assert.equal(await refusedAs(peter, forge(await live(), stranger)), 'ValidationError', 'signed by a key that is not Google’s');
  const outcomes = [];
  for (const [label, change] of [['other client', { aud: 'someone-else.apps.googleusercontent.com' }], ['other issuer', { iss: 'https://evil.example' }], ['expired', { exp: now - 5 }]]) {
    // Verified directly with the stand-in's real key material unavailable to a forger: use the verifier with a key we control.
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'local-stand-in-key' };
    const claims = { ...(await live()), ...change };
    const bad = await googleToken.verifyGoogleIdToken(forge(claims, pair.privateKey), { ...config, jwksUrl: `test://${label}` }, { loadKeys: async () => [jwk] }).then(() => 'accepted', (e) => e.type);
    const good = await googleToken.verifyGoogleIdToken(forge({ ...claims, aud: config.clientId, iss: config.issuers[0], exp: now + 300 }, pair.privateKey), { ...config, jwksUrl: `test://${label}` }, { loadKeys: async () => [jwk] }).then(() => 'accepted', (e) => e.type);
    assert.deepEqual([bad, good], ['ValidationError', 'accepted'], label);
    outcomes.push(label);
  }
  assert.equal(await refusedAs(peter, 'evil@gmail.com'), 'ValidationError');
  assert.equal(await refusedAs(peter, ''), 'ValidationError');
  const expired = googleToken.randomToken();
  await repo.putLinkRequest(realm, 'u_peter', { nonceHash: googleToken.hashNonce(expired), expiresAt: now - 1 });
  assert.equal(await repo.consumeLinkRequest(realm, 'u_peter', googleToken.hashNonce(expired), now), false);
  assert.equal((await run(peter, ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).getSignInMethods.google_email, 'peter.personal@gmail.com');
  ev(`replay, another person's answer, wrong signing key, ${outcomes.join(', ')}, a bare address and an expired request were all refused`);
});

tc(meta('TC-LNK06', 'A Google account opens only one ConnectED account',
  'u_peter tries to link janedoe@gmail.com, already linked to u_jane',
  'Refused as a Conflict with a clear message; Jane’s link and Peter’s own link are both unchanged; nothing is merged or deleted'),
async (ev) => {
  const refused = await link(person('u_peter', 'Teacher'), 'janedoe@gmail.com');
  assert.equal(refused.error.type, 'Conflict');
  assert.match(refused.error.message, /already linked to another ConnectED account/);
  const of = async (id) => (await run(person(id, 'Teacher'), ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).getSignInMethods.google_email;
  assert.deepEqual([await of('u_jane'), await of('u_peter')], ['janedoe@gmail.com', 'peter.personal@gmail.com']);
  ev(refused.error.message);
});

tc(meta('TC-LNK07', 'Changing the linked account replaces it, ends the person’s sessions, and a failed change keeps the earlier link',
  'u_jane changes to jane.personal@gmail.com; then a change during which the sign-in service cannot remove the earlier account; then one during which it cannot add the new one',
  'After the change exactly one account is linked (the new one), sessions are ended and it is audited; after each failed change the earlier account is still the only one linked'),
async (ev) => {
  const jane = person('u_jane', 'Teacher');
  const changed = await link(jane, 'jane.personal@gmail.com');
  assert.deepEqual([changed.completeGoogleLink.signed_out, changed.completeGoogleLink.sign_in.google_email], [true, 'jane.personal@gmail.com']);
  const realm = repo.schoolRealm(SCHOOL);
  const { identityProvider } = await import('../../backend/library/googleIdentity.js');
  const idp = identityProvider();
  assert.equal((await idp.identities(SCHOOL_POOL, 'u_jane')).google.length, 1);
  assert.equal((await audits()).at(-1), 'GOOGLE_LINK_CHANGED');
  const record = await teacherRecord('u_jane');
  assert.ok(record.sessions_ended_at >= clock - 5);
  assert.equal(record.sessions_ended_reason, 'GOOGLE_CHANGED');
  // The earlier Google account is free again, and its old session is refused (checked in TC-LNK09).
  const before = (await idp.identities(SCHOOL_POOL, 'u_jane')).google.map((g) => g.sub);

  const actor = { sub: 'u_jane', role: 'Teacher', email: 'u_jane@school.example', firstName: 'Jane', name: 'Jane Test', authTime: Math.floor(Date.now() / 1000) };
  const attempt = async (failing) => {
    const started = await links.startLink(realm, actor);
    const token = await chooseAt(started.url, 'janedoe@gmail.com');
    return links.completeLink(realm, actor, token, { idp: { ...idp, ...failing } }).then(() => 'changed', (e) => e.type);
  };
  assert.equal(await attempt({ unlink: async (pool, sub) => { if (before.includes(sub)) throw new Error('unavailable'); return idp.unlink(pool, sub); } }), 'LinkFailed');
  assert.deepEqual((await idp.identities(SCHOOL_POOL, 'u_jane')).google.map((g) => g.sub), before, 'the new account was taken out again');
  assert.equal(await attempt({ link: async () => { throw new Error('unavailable'); } }), 'LinkFailed');
  assert.deepEqual((await idp.identities(SCHOOL_POOL, 'u_jane')).google.map((g) => g.sub), before);
  clock = Math.floor(Date.now() / 1000) + 2; // Jane signs in again: the change ended her earlier session
  assert.equal((await run(person('u_jane', 'Teacher'), ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).getSignInMethods.google_email, 'jane.personal@gmail.com');
  // The Google account that could not be added is not left claimed: someone else may link it.
  assert.equal(await repo.claimGoogle(realm, (await googleToken.verifyGoogleIdToken(await chooseAt((await links.startLink(realm, actor)).url, 'janedoe@gmail.com'), googleToken.googleConfig())).sub, 'u_someone'), true);
  ev('changed to jane.personal@gmail.com with one link and sessions ended; two failed changes left that link in place');
});

tc(meta('TC-LNK08', 'Removing a link sticks, ends sessions, and needs a recent sign-in',
  'u_peter removes his own link after an old sign-in, then after a fresh one; an administrator of another school and a teacher try to remove someone else’s',
  'Old sign-in: ReauthRequired, still linked. Fresh: removed, sessions ended, audited, and marked so a matching Google address is not relinked automatically. Others: refused'),
async (ev) => {
  const remove = (identity, extra = {}) => run(identity, ops.REMOVE_GOOGLE_LINK, input(extra));
  assert.equal((await remove(person('u_peter', 'Teacher', { age: 900 }))).error.type, 'ReauthRequired');
  assert.equal((await remove(person('u_jane', 'Teacher'), { teacher_id: 'u_peter' })).error.type, 'Forbidden');
  const outsider = await run(person('u_other_admin', 'Admin', { school: OTHER_SCHOOL }), ops.REMOVE_GOOGLE_LINK, { input: { school_id: SCHOOL, teacher_id: 'u_peter' } });
  assert.equal(outsider.error.type, 'Forbidden');
  const done = await remove(person('u_peter', 'Teacher'));
  assert.deepEqual([done.removeGoogleLink.signed_out, done.removeGoogleLink.sign_in.google_linked, done.removeGoogleLink.sign_in.google_email], [true, false, null]);
  const realm = repo.schoolRealm(SCHOOL);
  assert.equal((await repo.signIn(realm, 'u_peter')).auto_link_off, true);
  assert.equal((await teacherRecord('u_peter')).sessions_ended_reason, 'GOOGLE_REMOVED');
  assert.equal((await audits()).at(-1), 'GOOGLE_LINK_REMOVED');
  assert.equal((await remove(person('u_peter', 'Teacher'))).error.type, 'ValidationError');

  // The pre-sign-up trigger, given this account as the match for a Google sign-in, refuses to relink it.
  const { makeHandler } = await import('../../deploy/aws/link-google.js');
  const cognitoUser = { Username: 'u_peter', Enabled: true, UserStatus: 'CONFIRMED', Attributes: [{ Name: 'sub', Value: 'u_peter' }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:school_id', Value: SCHOOL }] };
  const calls = [];
  const trigger = makeHandler(async (command) => {
    calls.push(command.constructor.name);
    return command.constructor.name === 'ListUsersCommand' ? { Users: [cognitoUser] } : { Groups: [{ GroupName: 'Teacher' }] };
  }, async () => ({ sent: true }));
  await assert.rejects(trigger({ triggerSource: 'PreSignUp_ExternalProvider', userPoolId: SCHOOL_POOL, userName: 'google_777', request: { userAttributes: { nickname: 'u_peter@gmail.com', profile: 'true' } } }), /removed from this account/);
  assert.ok(!calls.includes('AdminLinkProviderForUserCommand'));

  // Linking again on purpose clears the marker.
  clock = Math.floor(Date.now() / 1000) + 2;
  const again = await link(person('u_peter', 'Teacher'), 'peter.personal@gmail.com');
  assert.equal(again.completeGoogleLink.sign_in.google_linked, true);
  assert.equal((await repo.signIn(realm, 'u_peter')).auto_link_off, undefined);
  ev('removal refused after 15 minutes and for other people; then removed, marked, sessions ended; the trigger refused to relink; a deliberate link cleared the marker');
});

tc(meta('TC-LNK09', 'Sessions that began before a removal or change are refused at once; a new sign-in works',
  'u_jane (changed in TC-LNK07) calls the API with a token issued before the change, then with one issued after',
  'The older token is refused as SessionEnded with the reason; the newer one is served'),
async (ev) => {
  const old = await run(person('u_jane', 'Teacher', { age: 500, issuedAgo: 500 }), schoolOps.ME, { school_id: SCHOOL });
  assert.equal(old.error.type, 'SessionEnded');
  assert.match(old.error.message, /Google account linked to your account was changed/);
  clock = Math.floor(Date.now() / 1000) + 5;
  assert.equal((await run(person('u_jane', 'Teacher'), schoolOps.ME, { school_id: SCHOOL })).me.teacher_id, 'u_jane');
  ev(old.error.message);
});

tc(meta('TC-LNK10', 'An administrator sees everyone’s link status and can remove anyone’s link',
  'the administrator lists accounts, removes u_jane’s link, lists again; a teacher asks for the list; a deactivated account uses a still-valid token',
  'The list shows each person with status and linked address; after removal Jane shows not linked and the audit names the administrator; teachers cannot list; the deactivated account is refused whatever is linked'),
async (ev) => {
  const admin = person('u_admin', 'Admin');
  assert.equal((await run(person('u_jane', 'Teacher'), ops.LIST_ACCOUNT_LINKS, { school_id: SCHOOL })).error.type, 'Forbidden');
  const row = async (id) => (await run(admin, ops.LIST_ACCOUNT_LINKS, { school_id: SCHOOL })).listAccountLinks.find((r) => r.teacher_id === id);
  const { listAccountLinks } = await run(admin, ops.LIST_ACCOUNT_LINKS, { school_id: SCHOOL });
  assert.equal(listAccountLinks.length, 4);
  assert.deepEqual([(await row('u_jane')).google_email, (await row('u_admin')).google_linked, (await row('u_left')).status], ['jane.personal@gmail.com', false, 'INACTIVE']);
  const removed = await run(admin, ops.REMOVE_GOOGLE_LINK, input({ teacher_id: 'u_jane' }));
  assert.deepEqual([removed.removeGoogleLink.signed_out, removed.removeGoogleLink.sign_in.google_linked], [false, false]);
  assert.equal((await row('u_jane')).google_linked, false);
  const last = (await repo.audits(repo.schoolRealm(SCHOOL))).at(-1);
  assert.deepEqual([last.action, last.by_sub, last.subject_sub, last.details.by_admin, last.details.google_email], ['GOOGLE_LINK_REMOVED', 'u_admin', 'u_jane', true, 'jane.personal@gmail.com']);
  const gone = await run(person('u_left', 'Teacher'), ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL });
  assert.equal(gone.error.type, 'Unauthorized');
  ev(`4 people listed; administrator removed Jane's link (audited as by_admin); deactivated account refused: ${gone.error.message}`);
});

tc(meta('TC-LNK11', 'The records and the sign-in service may disagree (a demo reset restores records only)',
  'the sign-in service holds a link the records do not know; the records name a link the sign-in service no longer holds',
  'The sign-in service decides whether a link exists: linked with no address shown in the first case, not linked in the second; removal still works',
  'White box, state'),
async (ev) => {
  const a = links.describeLink(null, { google: [{ sub: 'g1', linkedAt: '2026-11-01T00:00:00.000Z' }], lastSeenEmail: null });
  assert.deepEqual([a.google_linked, a.google_email, a.google_linked_at], [true, null, '2026-11-01T00:00:00.000Z']);
  const b = links.describeLink({ google_sub: 'g1', google_email: 'x@gmail.com', linked_at: '2026-11-01T00:00:00.000Z' }, { google: [], lastSeenEmail: null });
  assert.deepEqual([b.google_linked, b.google_email], [false, null]);
  const c = links.describeLink({ google_sub: 'g1', google_email: 'old@gmail.com' }, { google: [{ sub: 'g2', linkedAt: null }], lastSeenEmail: 'seen@gmail.com' });
  assert.deepEqual([c.google_linked, c.google_email], [true, 'seen@gmail.com']);
  const d = links.describeLink({ google_sub: 'g1', google_email: 'x@gmail.com', linked_at: 't' }, null);
  assert.deepEqual([d.google_linked, d.confirmed], [true, false]);
  // Reset: Peter's record disappears while the sign-in service keeps his link. He can still remove it.
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  await ddb.send(new DeleteCommand({ TableName: keys.TABLE, Key: { PK: keys.pk(SCHOOL), SK: keys.sk.signIn('u_peter') } }));
  const peter = person('u_peter', 'Teacher');
  const shown = (await run(peter, ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).getSignInMethods;
  assert.deepEqual([shown.google_linked, shown.google_email], [true, null]);
  assert.equal((await run(peter, ops.REMOVE_GOOGLE_LINK, input())).removeGoogleLink.sign_in.google_linked, false);
  ev('service-only link shown as linked without an address and removable; record-only link shown as not linked');
});

tc(meta('TC-LNK12', 'Angaza staff link their own Google account from the console; school accounts cannot use the staff operations',
  'an Angaza staff member reads their profile, links, changes nothing else, removes; a school administrator calls the staff operations; staff call a school operation',
  'Staff may always link (no school policy), with the same recent sign-in rule; the pools are refused on each other’s operations'),
async (ev) => {
  clock = Math.floor(Date.now() / 1000) + 10;
  const profile = (await run(staff(), ops.GET_STAFF_PROFILE)).getStaffProfile;
  assert.deepEqual([profile.email, profile.first_name, profile.sign_in.can_link, profile.sign_in.google_linked], ['asha@angazacenter.org', 'Asha', true, false]);
  assert.equal((await run(staff(700), ops.START_STAFF_GOOGLE_LINK)).error.type, 'ReauthRequired');
  const started = (await run(staff(), ops.START_STAFF_GOOGLE_LINK)).startStaffGoogleLink;
  const token = await chooseAt(started.url, 'asha.home@gmail.com');
  const done = await run(staff(), ops.COMPLETE_STAFF_GOOGLE_LINK, { input: { id_token: token } });
  assert.equal(done.completeStaffGoogleLink.sign_in.google_email, 'asha.home@gmail.com');
  assert.equal((await run(person('u_admin', 'Admin'), ops.GET_STAFF_PROFILE)).error.type, 'Unauthorized');
  assert.equal((await run(staff(), ops.GET_SIGN_IN_METHODS, { school_id: SCHOOL })).error.type, 'Unauthorized');
  const removed = await run(staff(), ops.REMOVE_STAFF_GOOGLE_LINK);
  assert.deepEqual([removed.removeStaffGoogleLink.signed_out, removed.removeStaffGoogleLink.sign_in.google_linked], [true, false]);
  assert.deepEqual((await repo.audits(repo.angazaRealm())).map((x) => x.action), ['GOOGLE_LINKED', 'GOOGLE_LINK_REMOVED']);
  ev('staff linked asha.home@gmail.com and removed it (2 audit rows in the Angaza partition); cross-pool calls refused');
});
