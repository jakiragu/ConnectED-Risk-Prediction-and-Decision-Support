import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * Deleting a deactivated account (school administrators, Teachers page) and deleting a
 * suspended school (Angaza staff, the console), through the real GraphQL schema and resolver
 * map against an in-process DynamoDB.
 *
 * The sign-in service and the report-card bucket are small in-memory stand-ins that record
 * what was asked of them and can be told to fail, so partial failure and resuming are tested
 * for real. Google is played by local/google-stand-in.js, as in account-link.test.js. Against
 * real Cognito and S3 the same flows are checked by hand after deployment (deploy/aws/README.md).
 *
 *   npm run test:store
 */
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
const SCHOOL_POOL = 'eu-west-1_schoolPool';
const ANGAZA_POOL = 'eu-west-1_angazaPool';
const SCHOOL = 'sch_delete_test';
const ISSUER = (pool) => `http://localhost:9229/${pool}`;
let schema; let graphql; let ops; let consoleOps; let schoolOps; let ddb; let lib; let keys; let google; let repo; let store; let platform; let deletion;
const clock = () => Math.floor(Date.now() / 1000);

/** An identity as AppSync passes it. age: seconds since the person signed in. */
const person = (sub, group, { school = SCHOOL, age = 0 } = {}) => ({
  sub, issuer: ISSUER(SCHOOL_POOL), groups: [group],
  claims: { iss: ISSUER(SCHOOL_POOL), 'custom:school_id': school, email: `${sub}@token.example`, auth_time: clock() - age, iat: clock() - age },
});
const staff = (age = 0) => ({ sub: 'u_staff', issuer: ISSUER(ANGAZA_POOL), groups: ['PlatformAdmin'], claims: { iss: ISSUER(ANGAZA_POOL), email: 'asha@angazacenter.org', auth_time: clock() - age, iat: clock() - age } });
const admin = (age = 0) => person('u_admin', 'Admin', { age });

// ------------------------------------------------- the sign-in service, in memory
const accounts = new Map(); // sub -> { email, enabled }
const signIn = { calls: [], failDelete: false, created: 0 };
const named = (name) => Object.assign(new Error(name), { name });
async function cognitoStandIn(command) {
  const kind = command.constructor.name.replace(/Command$/, '');
  const i = command.input;
  signIn.calls.push([kind, i.Username]);
  const find = () => (accounts.has(i.Username) ? i.Username : [...accounts].find(([, a]) => a.email === i.Username)?.[0]);
  switch (kind) {
    case 'AdminCreateUser': {
      if (find()) throw named('UsernameExistsException');
      const sub = `u_new_${++signIn.created}`;
      accounts.set(sub, { email: i.Username, enabled: true });
      return { User: { Attributes: [{ Name: 'sub', Value: sub }] } };
    }
    case 'AdminGetUser': {
      const sub = find();
      if (!sub) throw named('UserNotFoundException');
      return { Enabled: accounts.get(sub).enabled, UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: sub }] };
    }
    case 'AdminDeleteUser':
      if (signIn.failDelete) throw named('ServiceUnavailableException');
      if (!accounts.delete(i.Username)) throw named('UserNotFoundException');
      return {};
    case 'AdminDisableUser': accounts.get(find()).enabled = false; return {};
    case 'AdminEnableUser': accounts.get(find()).enabled = true; return {};
    case 'AdminListGroupsForUser': return { Groups: [] };
    default: return {};
  }
}

// ------------------------------------------------- the report-card bucket, in memory (versioned)
let files = []; // { Key, VersionId }
async function s3StandIn(command) {
  const kind = command.constructor.name.replace(/Command$/, '');
  const i = command.input;
  if (kind === 'ListObjectVersions') return { Versions: files.filter((f) => f.Key.startsWith(i.Prefix)).slice(0, i.MaxKeys) };
  if (kind === 'DeleteObjects') {
    for (const o of i.Delete.Objects) assert.ok(o.VersionId, 'each version is removed by its id');
    files = files.filter((f) => !i.Delete.Objects.some((o) => o.Key === f.Key && o.VersionId === f.VersionId));
    return {};
  }
  throw new Error(`s3 stand-in: ${kind}`);
}

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
    GRADEBOOK_TABLE_NAME: 'deletion_test',
    AWS_REGION: 'eu-west-1',
    COGNITO_USER_POOL_ID: SCHOOL_POOL,
    PLATFORM_COGNITO_USER_POOL_ID: ANGAZA_POOL,
    REPORT_BUCKET: 'report-cards-test',
    SITE_URL: 'http://localhost:5173',
    MAIL_TRANSPORT: 'off',
  });
  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  lib = await import('@aws-sdk/lib-dynamodb');
  const client = await import('../../backend/library/client.js');
  ({ ddb } = client);
  client.cognito.send = cognitoStandIn;
  client.s3.send = s3StandIn;
  (await import('../helpers/transactShim.js')).emulateTransactions(ddb);
  const { TABLE_DEFINITION } = await import('../../infra/table-definition.js');
  const { StreamSpecification, ...table } = TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  keys = await import('../../backend/library/keys.js');
  repo = await import('../../backend/library/accountLinkRepo.js');
  store = await import('../../backend/library/platformStore.js');
  platform = await import('../../backend/library/platformRepo.js');
  deletion = await import('../../backend/library/schoolDeletion.js');

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
  consoleOps = await import('../../src/api/platformOperations.js');
  schoolOps = await import('../../src/api/operations.js');

  await put(keys.pk(SCHOOL), { SK: keys.sk.school(), school_id: SCHOOL, name: 'Deletion Test School', status: 'ACTIVE' });
  await teacher(SCHOOL, 'u_admin', 'Admin', 'John');
  await teacher(SCHOOL, 'u_jane', 'Teacher', 'Jane', { phone: '+254700000001', assignments: [{ class_id: 'c_4e', subject: 'Mathematics' }], historical_class_teacher_of: ['c_old'] });
  await teacher(SCHOOL, 'u_peter', 'Teacher', 'Peter');
  await teacher(SCHOOL, 'u_mary', 'Teacher', 'Mary');
  // An archived class that remembers Jane as its class teacher, and a record that copied her name.
  await put(keys.pk(SCHOOL), { SK: keys.sk.klass('c_old'), school_id: SCHOOL, class_id: 'c_old', name: 'Form 4 East 2025', grade: 'Form 4', stream: 'East', academic_year: 2025, status: 'PAST', former_class_teacher_id: 'u_jane', _version: 1 });
  await put(keys.pk(SCHOOL), { SK: keys.sk.intervention('s_1', 'i_1'), school_id: SCHOOL, intervention_id: 'i_1', student_id: 's_1', created_by: 'u_jane', created_by_name: 'Jane Test' });
  await put(keys.PLATFORM_PK, { SK: keys.platformSk.staff('u_staff'), staff_id: 'u_staff', first_name: 'Asha', last_name: 'Staff', email: 'asha@angazacenter.org', status: 'ACTIVE' });
});

after(async () => {
  await new Promise((r) => google.close(r));
  await new Promise((r) => server.close(r));
});

const put = (PK, Item) => ddb.send(new lib.PutCommand({ TableName: keys.TABLE, Item: { PK, ...Item } }));
async function teacher(school, id, role, first, extra = {}) {
  accounts.set(id, { email: `${id}@school.example`, enabled: true });
  await put(keys.pk(school), {
    SK: keys.sk.teacher(id), entity: 'Teacher', school_id: school, teacher_id: id, role, first_name: first, last_name: 'Test',
    email: `${id}@school.example`, status: 'ACTIVE', assignments: [], class_teacher_of: null, created_at: '2026-01-05T08:00:00.000Z', _version: 1, ...extra });
}
const record = async (school, id) => (await ddb.send(new lib.GetCommand({ TableName: keys.TABLE, Key: { PK: keys.pk(school), SK: keys.sk.teacher(id) }, ConsistentRead: true }))).Item;
async function partition(PK) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new lib.QueryCommand({ TableName: keys.TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': PK }, ConsistentRead: true, ExclusiveStartKey }));
    out.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function run(identity, document, variables = {}) {
  const res = await graphql.execute({ schema, document: graphql.parse(document), variableValues: variables, contextValue: { identity } });
  if (res.errors?.length) {
    const e = res.errors[0];
    if (!e.originalError?.type) throw new Error(e.message);
    return { error: { type: e.originalError.type, field: e.originalError.field, message: e.message } };
  }
  return res.data;
}
const input = (extra = {}) => ({ input: { school_id: SCHOOL, ...extra } });
const remove = (identity, teacherId) => run(identity, ops.DELETE_TEACHER, input({ teacher_id: teacherId }));
const deactivate = async (id) => {
  const { _version } = await record(SCHOOL, id);
  return run(admin(), schoolOps.DEACTIVATE_TEACHER, input({ teacher_id: id, _version }));
};
async function linkGoogle(identity, account) {
  const { startGoogleLink } = await run(identity, ops.START_GOOGLE_LINK, input());
  const res = await fetch(`${startGoogleLink.url}&account=${encodeURIComponent(account)}`, { redirect: 'manual' });
  const token = new URLSearchParams(new URL(res.headers.get('location')).hash.slice(1)).get('id_token');
  return run(identity, ops.COMPLETE_GOOGLE_LINK, input({ id_token: token }));
}

const meta = (id, scenario, data, expected, technique = 'Black box, authorisation') =>
  ({ id, requirement: 'EXT-DELETE, NFR-1', level: 'Integration (store)', technique, scenario, data, expected });

// =============================================================== deleting an account

tc(meta('TC-DEL01', 'Only an administrator, recently signed in, can delete an account, and only one that is deactivated and not their own',
  'a teacher deletes a colleague; an administrator deletes an active account, their own account, an unknown account; a deactivated account after signing in 11 minutes ago',
  'Teacher: Forbidden. Active account and own account: ValidationError. Unknown: NotFound. Old sign-in: ReauthRequired. In every case the record and the sign-in account are untouched'),
async (ev) => {
  assert.equal((await remove(person('u_peter', 'Teacher'), 'u_mary')).error.type, 'Forbidden');
  const active = await remove(admin(), 'u_mary');
  assert.equal(active.error.type, 'ValidationError');
  assert.match(active.error.message, /Deactivate Mary Test’s account first/);
  assert.equal((await remove(admin(), 'u_admin')).error.type, 'ValidationError');
  assert.equal((await remove(admin(), 'u_nobody')).error.type, 'NotFound');
  assert.equal((await deactivate('u_mary')).deactivateTeacher.status, 'INACTIVE');
  assert.equal((await remove(admin(660), 'u_mary')).error.type, 'ReauthRequired');
  const still = await record(SCHOOL, 'u_mary');
  assert.deepEqual([still.status, still.email, accounts.has('u_mary')], ['INACTIVE', 'u_mary@school.example', true]);
  assert.ok(!signIn.calls.some(([kind]) => kind === 'AdminDeleteUser'));
  ev(`teacher refused; active account refused (${active.error.message}); own and unknown refused; an 11-minute-old sign-in was asked for the password again; nothing was deleted`);
});

tc(meta('TC-DEL02', 'Deleting a deactivated account removes the sign-in account, the Google link and claim and every personal detail, and keeps the name for history',
  'u_jane has a linked Google account, a phone number, a subject assignment, an archived class that remembers her as class teacher and an intervention recorded under her name; she is deactivated, then deleted',
  'The sign-in account is gone; her Google account can be linked by someone else; her record holds her name and nothing personal; she is off the Teachers page and the Accounts list; the archived class and the intervention still name her; the deletion is audited; she cannot be reactivated or deleted twice',
  'Black box, interface'),
async (ev) => {
  await run(admin(), ops.SAVE_ACCOUNT_POLICY, input({ google_linking: 'TEACHERS', _version: 0 }));
  assert.equal((await linkGoogle(person('u_jane', 'Teacher'), 'janedoe@gmail.com')).completeGoogleLink.sign_in.google_email, 'janedoe@gmail.com');
  await deactivate('u_jane');
  const before = await record(SCHOOL, 'u_jane');

  const done = await remove(admin(), 'u_jane');
  assert.deepEqual([done.deleteTeacher.teacher_id, done.deleteTeacher.first_name, done.deleteTeacher.last_name], ['u_jane', 'Jane', 'Test']);
  assert.ok(Date.parse(done.deleteTeacher.deleted_at) > 0);

  // Sign-in account and Google.
  assert.equal(accounts.has('u_jane'), false);
  const { identityProvider } = await import('../../backend/library/googleIdentity.js');
  assert.deepEqual((await identityProvider().identities(SCHOOL_POOL, 'u_jane')).google, []);
  assert.equal((await repo.signIn(repo.schoolRealm(SCHOOL), 'u_jane')), null);
  const peter = await linkGoogle(person('u_peter', 'Teacher'), 'janedoe@gmail.com');
  assert.equal(peter.completeGoogleLink.sign_in.google_email, 'janedoe@gmail.com', 'the Google account is free for someone else');

  // The record: the name, and nothing personal.
  const kept = await record(SCHOOL, 'u_jane');
  assert.deepEqual(Object.keys(kept).sort(), ['PK', 'SK', '_version', 'assignments', 'class_teacher_of', 'created_at', 'deleted_at', 'deleted_by', 'entity', 'first_name', 'last_name', 'school_id', 'status', 'teacher_id', 'updated_at']);
  assert.deepEqual([kept.status, kept.first_name, kept.last_name, kept.assignments, kept.deleted_by, kept._version], ['DELETED', 'Jane', 'Test', [], 'u_admin', before._version + 1]);
  assert.ok(!JSON.stringify(kept).includes('school.example') && !JSON.stringify(kept).includes('+2547'));

  // Lists drop her; history keeps her name.
  const { listTeachers } = await run(admin(), schoolOps.LIST_TEACHERS, { school_id: SCHOOL });
  const { listAccountLinks } = await run(admin(), ops.LIST_ACCOUNT_LINKS, { school_id: SCHOOL });
  assert.ok(!listTeachers.some((t) => t.teacher_id === 'u_jane') && !listAccountLinks.some((t) => t.teacher_id === 'u_jane'));
  assert.equal(listTeachers.length, 3);
  assert.equal((await platform.teacherNames(SCHOOL)).get('u_jane'), 'Jane Test');
  const { listSchoolClasses } = await run(admin(), schoolOps.LIST_SCHOOL_CLASSES, { school_id: SCHOOL });
  assert.equal(listSchoolClasses.find((c) => c.class_id === 'c_old').class_teacher_name, 'Jane Test');
  assert.equal((await partition(keys.pk(SCHOOL))).find((r) => r.intervention_id === 'i_1').created_by_name, 'Jane Test');

  // Audited, with her Google address gone from the earlier entry about her.
  const audits = await repo.audits(repo.schoolRealm(SCHOOL));
  const last = audits.find((a) => a.action === 'ACCOUNT_DELETED');
  assert.deepEqual([last.action, last.by_sub, last.subject_sub, last.details.name], ['ACCOUNT_DELETED', 'u_admin', 'u_jane', 'Jane Test']);
  const linked = audits.find((a) => a.action === 'GOOGLE_LINKED' && a.subject_sub === 'u_jane');
  assert.ok(linked && !('google_email' in linked.details));

  // No way back.
  assert.equal((await run(admin(), schoolOps.REACTIVATE_TEACHER, input({ teacher_id: 'u_jane', _version: kept._version }))).error.type, 'NotFound');
  assert.equal((await remove(admin(), 'u_jane')).error.type, 'NotFound');
  assert.equal((await run(person('u_jane', 'Teacher'), schoolOps.ME, { school_id: SCHOOL })).error.type, 'Unauthorized');
  ev(`sign-in account, Google link and claim removed; record keeps ${kept.first_name} ${kept.last_name} only (${Object.keys(kept).length} fields, no email or phone); archived class and intervention still name her; audited as ACCOUNT_DELETED; reactivating and deleting again answer NotFound`);
});

tc(meta('TC-DEL03', 'A deletion that fails part-way leaves the account deactivated, and trying again finishes it',
  'u_mary (deactivated) is deleted while the sign-in service refuses to delete accounts; then again once it answers',
  'First attempt: DeleteFailed, the record is still INACTIVE with its email and the sign-in account still exists. Second attempt: deleted',
  'Black box, negative'),
async (ev) => {
  signIn.failDelete = true;
  const failed = await remove(admin(), 'u_mary');
  signIn.failDelete = false;
  assert.equal(failed.error.type, 'DeleteFailed');
  const still = await record(SCHOOL, 'u_mary');
  assert.deepEqual([still.status, still.email, accounts.has('u_mary')], ['INACTIVE', 'u_mary@school.example', true]);
  assert.equal((await remove(admin(), 'u_mary')).deleteTeacher.teacher_id, 'u_mary');
  assert.deepEqual([(await record(SCHOOL, 'u_mary')).status, accounts.has('u_mary')], ['DELETED', false]);
  ev(`${failed.error.message} Then deleted on the second attempt.`);
});

tc(meta('TC-DEL04', 'A deleted person’s school email can be used for a new account',
  'an administrator adds a teacher with u_mary@school.example, the address of the account deleted in TC-DEL03',
  'A new account is created with a new id; the deleted record is untouched and still holds only the name',
  'Black box, interface'),
async (ev) => {
  const created = await run(admin(), schoolOps.CREATE_TEACHER, input({ first_name: 'Maria', last_name: 'Newcomer', email: 'u_mary@school.example', role: 'Teacher' }));
  const fresh = created.createTeacher.teacher;
  assert.notEqual(fresh.teacher_id, 'u_mary');
  assert.deepEqual([fresh.email, fresh.status, fresh.first_name], ['u_mary@school.example', 'ACTIVE', 'Maria']);
  assert.deepEqual([(await record(SCHOOL, 'u_mary')).status, (await record(SCHOOL, 'u_mary')).email], ['DELETED', undefined]);
  ev(`new account ${fresh.teacher_id} for ${fresh.email}; the deleted record u_mary is unchanged`);
});

// ================================================================= deleting a school

let small; // a school that one request can clear
let big; // a school that needs several

const staffAdmin = (schoolId, sub = `adm_${schoolId}`) => ({
  sub, issuer: ISSUER(SCHOOL_POOL), groups: ['Admin'],
  claims: { iss: ISSUER(SCHOOL_POOL), 'custom:school_id': schoolId, email: 'x@token.example', auth_time: clock(), iat: clock() },
});
async function register(name, { records = 0, people = 2 } = {}) {
  const { createSchool: s } = await run(staff(), consoleOps.CREATE_SCHOOL, { input: { name, country: 'KE', region: 'Nairobi' } });
  const id = s.school_id;
  await teacher(id, `adm_${id}`, 'Admin', 'Ada');
  for (let i = 1; i < people; i += 1) await teacher(id, `t${i}_${id}`, 'Teacher', `T${i}`);
  await store.audit(id, 'ADMIN_ADDED', { sub: 'u_staff', name: 'Asha Staff' }, { teacher_id: `adm_${id}`, email: `adm_${id}@school.example`, emailed: true });
  for (let i = 0; i < records; i += 25) {
    await ddb.send(new lib.BatchWriteCommand({ RequestItems: { [keys.TABLE]: Array.from({ length: Math.min(25, records - i) }, (_, j) => ({
      PutRequest: { Item: { PK: keys.pk(id), SK: keys.sk.score('a_1', `s_${String(i + j).padStart(5, '0')}`), school_id: id, score: 50, GSI2PK: keys.gsi2.pk(id, `s_${i + j}`), GSI2SK: 'TERM#t#SCORE#a_1' } },
    })) } }));
  }
  return (await run(staff(), consoleOps.GET_SCHOOL, { school_id: id })).getSchool.school;
}
const suspend = async (s) => (await run(staff(), consoleOps.SUSPEND_SCHOOL, { input: { school_id: s.school_id, reason: 'Left the programme', _version: s._version } })).suspendSchool;
const destroy = (identity, s, name = s.name, version = s._version) => run(identity, consoleOps.DELETE_SCHOOL, { input: { school_id: s.school_id, confirm_name: name, _version: version } });

tc(meta('TC-DEL05', 'Only Angaza staff, recently signed in, can delete a school, only a suspended one once it has an administrator, and only by typing its name',
  'a school administrator calls deleteSchool; staff delete an active school that has an administrator; a suspended one with the wrong name, with an 11-minute-old sign-in, and from a page that is out of date',
  'School administrator: Unauthorized. Active: ValidationError saying to suspend first. Wrong name: ValidationError on confirm_name. Old sign-in: ReauthRequired. Out-of-date page: Conflict. The school keeps every record throughout'),
async (ev) => {
  small = await register('Kibera Hills Academy', { records: 30 });
  const count = (await partition(keys.pk(small.school_id))).length;
  assert.equal((await destroy(staffAdmin(small.school_id), small)).error.type, 'Unauthorized');
  const active = await destroy(staff(), small);
  assert.equal(active.error.type, 'ValidationError');
  assert.match(active.error.message, /Suspend Kibera Hills Academy first/);
  small = await suspend(small);
  const wrong = await destroy(staff(), small, 'Kibera Hills');
  assert.deepEqual([wrong.error.type, wrong.error.field], ['ValidationError', 'confirm_name']);
  assert.equal((await destroy(staff(660), small)).error.type, 'ReauthRequired');
  assert.equal((await destroy(staff(), small, small.name, small._version - 1)).error.type, 'Conflict');
  assert.equal((await partition(keys.pk(small.school_id))).length, count);
  assert.equal((await store.registration(small.school_id)).status, 'SUSPENDED');
  ev(`school administrator, active school, wrong name, old sign-in and stale page all refused; ${count} records still there`);
});

tc(meta('TC-DEL06', 'Deleting a suspended school removes everything it owns, wherever it is kept, and leaves one line in the console',
  'Kibera Hills Academy: 2 people with sign-in accounts, 30 marks, a Google claim, 3 report-card files (one in two versions); a second school, sch_other, with its own records, account, claim and file',
  'One request answers DELETED. The school’s partition, accounts, claim and files are gone; the other school is untouched; the console lists one entry with who deleted it and when; the name can be registered again; the deleted school can no longer be changed',
  'Black box, interface'),
async (ev) => {
  const id = small.school_id;
  // Another school that must not be touched, with an id that starts the same way.
  const other = `${id}x`;
  await put(keys.pk(other), { SK: keys.sk.school(), school_id: other, name: 'Other', status: 'ACTIVE' });
  await teacher(other, 'u_other', 'Teacher', 'Olive');
  await repo.claimGoogle(repo.schoolRealm(other), 'g_other', 'u_other');
  await repo.claimGoogle(repo.schoolRealm(id), 'g_small', `t1_${id}`);
  files = [
    { Key: `report-cards/${id}/t1/c1/ENDTERM/s1-calc.pdf`, VersionId: 'v1' },
    { Key: `report-cards/${id}/t1/c1/ENDTERM/s1-calc.pdf`, VersionId: 'v2' },
    { Key: `report-cards/${id}/t1/c1/ENDTERM/s2-calc.pdf`, VersionId: 'v1' },
    { Key: `report-cards/${other}/t1/c1/ENDTERM/s9-calc.pdf`, VersionId: 'v1' },
  ];
  const had = (await partition(keys.pk(id))).length;

  const done = await destroy(staff(), small);
  const s = done.deleteSchool;
  assert.deepEqual([s.status, s.name, s.deleted_by_name, s.deleted_records, s.active_admin_count], ['DELETED', 'Kibera Hills Academy', 'Asha Staff', had - 1, null]);
  assert.ok(Date.parse(s.deleted_at) > 0);

  assert.deepEqual(await partition(keys.pk(id)), []);
  assert.deepEqual([accounts.has(`adm_${id}`), accounts.has(`t1_${id}`), accounts.has('u_other')], [false, false, true]);
  assert.deepEqual((await partition(keys.GOOGLE_PK)).map((c) => c.owner_sub).filter((o) => o === `t1_${id}` || o === 'u_other'), ['u_other']);
  assert.deepEqual(files.map((f) => f.Key), [`report-cards/${other}/t1/c1/ENDTERM/s9-calc.pdf`]);
  assert.equal((await partition(keys.pk(other))).length, 2);

  // The one line that stays, and nothing of the school's in it.
  const entry = await store.registration(id);
  assert.deepEqual(Object.keys(entry).sort(), ['PK', 'SK', '_version', 'country', 'created_at', 'created_by_name', 'deleted_at', 'deleted_by', 'deleted_by_name', 'deleted_records', 'entity', 'name', 'region', 'school_id', 'status', 'time_zone', 'town', 'updated_at']);
  const audit = (await partition(keys.PLATFORM_PK)).filter((r) => r.SK.startsWith(`AUDIT#${id}#`));
  assert.deepEqual(audit.map((r) => r.action), ['SCHOOL_CREATED', 'ADMIN_ADDED', 'SCHOOL_SUSPENDED', 'SCHOOL_DELETION_STARTED', 'SCHOOL_DELETED']);
  assert.ok(!JSON.stringify(audit).includes('school.example'), 'no administrator email is left in Angaza’s audit rows');

  const { listSchools } = await run(staff(), consoleOps.LIST_SCHOOLS);
  assert.equal(listSchools.find((x) => x.school_id === id).status, 'DELETED');
  const { getSchool } = await run(staff(), consoleOps.GET_SCHOOL, { school_id: id });
  assert.deepEqual([getSchool.school.status, getSchool.admins, getSchool.usage.students], ['DELETED', [], 0]);

  // No way back; the name is free.
  assert.equal((await run(staff(), consoleOps.REACTIVATE_SCHOOL, { input: { school_id: id, _version: entry._version } })).error.type, 'ValidationError');
  assert.equal((await run(staff(), consoleOps.ADD_SCHOOL_ADMIN, { input: { school_id: id, first_name: 'A', last_name: 'B', email: 'a@b.example' } })).error.type, 'ValidationError');
  assert.equal((await destroy(staff(), small)).error.type, 'ValidationError');
  assert.equal((await run(staffAdmin(id), schoolOps.ME, { school_id: id })).error.type, 'Unauthorized');
  const again = await run(staff(), consoleOps.CREATE_SCHOOL, { input: { name: 'Kibera Hills Academy', country: 'KE', region: 'Nairobi' } });
  assert.notEqual(again.createSchool.school_id, id);
  ev(`${had - 1} records, 2 sign-in accounts, 1 Google claim and 3 file versions removed in one request; the other school untouched; entry reads "${s.name}, deleted by ${s.deleted_by_name}"; the name was registered again as ${again.createSchool.school_id}`);
});

tc(meta('TC-DEL07', 'A large school is deleted in slices: it is blocked from the first moment, an interrupted slice is carried on, and it is never left half-deleted and active',
  'Mathare North Secondary: 12 people and 400 marks. The deletion starts with time for about one batch per request; the sign-in service fails during one slice; the table hands back unprocessed deletes during another; the console then calls continueSchoolDeletion until done',
  'After the first request the school reads DELETING with a running total, its users are refused and it cannot be reactivated. The failed slice answers DeleteFailed and the school stays DELETING. Later slices finish it: DELETED, nothing left, and the total equals the records it had. Nobody is emailed',
  'White box, state'),
async (ev) => {
  big = await suspend(await register('Mathare North Secondary', { records: 400, people: 12 }));
  const id = big.school_id;
  const had = (await partition(keys.pk(id))).length;
  // Each look at the clock moves it on 10 seconds, so a slice of 18 has time for about one batch.
  let t = Date.now();
  const tight = { now: () => (t += 10_000) };
  const actor = { sub: 'u_staff', name: 'Asha Staff', authTime: Math.floor((t + 10_000) / 1000) };

  const first = await deletion.startDeletion(actor, await store.registration(id), { confirmName: '  mathare north   secondary ', version: big._version }, tight);
  assert.equal(first.status, 'DELETING');
  assert.ok(first.deleted_records > 0 && first.deleted_records < had, `a first slice removed ${first.deleted_records} of ${had}`);

  // Blocked at once, and only forwards from here.
  const refused = await run(staffAdmin(id), schoolOps.ME, { school_id: id });
  assert.equal(refused.error.type, 'Unauthorized');
  assert.match(refused.error.message, /removed from ConnectED/);
  assert.equal((await run(staff(), consoleOps.REACTIVATE_SCHOOL, { input: { school_id: id, _version: first._version } })).error.type, 'ValidationError');
  assert.equal((await run(staff(), consoleOps.LIST_SCHOOLS)).listSchools.find((x) => x.school_id === id).status, 'DELETING');

  // A slice during which the sign-in service is down: nothing is lost, the school stays DELETING.
  signIn.failDelete = true;
  const interrupted = await run(staff(), consoleOps.CONTINUE_SCHOOL_DELETION, { input: { school_id: id } });
  signIn.failDelete = false;
  assert.equal(interrupted.error.type, 'DeleteFailed');
  assert.equal((await store.registration(id)).status, 'DELETING');

  // A slice during which the table is throttled and hands back most of a batch.
  const busy = { ...store, deleteKeys: (k) => store.deleteKeys(k.slice(0, 3)) };
  const throttled = await deletion.continueDeletion(id, { ...tight, store: busy });
  assert.equal(throttled.status, 'DELETING');

  // The console keeps calling until it is done. A second start is treated as "carry on", not refused.
  let slices = 0;
  let now = (await destroy(staff(), big)).deleteSchool;
  while (now.status === 'DELETING' && slices < 50) {
    now = await deletion.continueDeletion(id, tight);
    slices += 1;
  }
  assert.equal(now.status, 'DELETED');
  assert.deepEqual(await partition(keys.pk(id)), []);
  assert.equal(now.deleted_records, had - 1, 'every record but the profile is counted once');
  assert.ok(![...accounts.keys()].some((k) => k.endsWith(id)));
  assert.equal((await run(staff(), consoleOps.CONTINUE_SCHOOL_DELETION, { input: { school_id: id } })).continueSchoolDeletion.status, 'DELETED');
  ev(`first slice removed ${first.deleted_records} of ${had}; users refused at once ("${refused.error.message}"); a slice with the sign-in service down answered DeleteFailed and one with the table throttled stopped early, both leaving it DELETING; finished after ${slices} more slices with ${now.deleted_records} records removed`);
});

tc(meta('TC-DEL09', 'A school with no administrator can be deleted without suspending it; one with an administrator cannot',
  'Wrongly Entered School is registered with no administrator and deleted while ACTIVE; the same is tried on an active school after it gets an administrator',
  'The empty school is deleted in one request and its name is free; the school with an administrator is refused until suspended',
  'Black box, interface'),
async (ev) => {
  const { createSchool: empty } = await run(staff(), consoleOps.CREATE_SCHOOL, { input: { name: 'Wrongly Entered School', country: 'KE', region: 'Nairobi' } });
  assert.equal((await destroy(staff(660), empty)).error.type, 'ReauthRequired');
  assert.equal((await destroy(staff(), empty, 'Wrong')).error.field, 'confirm_name');
  const gone = await destroy(staff(), empty);
  assert.deepEqual([gone.deleteSchool.status, gone.deleteSchool.deleted_by_name], ['DELETED', 'Asha Staff']);
  assert.deepEqual(await partition(keys.pk(empty.school_id)), []);
  const { createSchool: started } = await run(staff(), consoleOps.CREATE_SCHOOL, { input: { name: 'Wrongly Entered School', country: 'KE', region: 'Nairobi' } });
  await teacher(started.school_id, `adm_${started.school_id}`, 'Admin', 'Ada');
  const refused = await destroy(staff(), started);
  assert.equal(refused.error.type, 'ValidationError');
  assert.match(refused.error.message, /Suspend Wrongly Entered School first/);
  assert.equal((await store.registration(started.school_id)).status, 'ACTIVE');
  ev(`empty school deleted while active and its name registered again; with an administrator: ${refused.error.message}`);
});

tc(meta('TC-DEL08', 'The demo school and other schools are unaffected by deletions elsewhere',
  'after TC-DEL02 to TC-DEL07, the first school’s administrator and remaining teacher use the app',
  'Both are served as before; the school still has its records',
  'Black box, regression'),
async (ev) => {
  assert.equal((await run(admin(), schoolOps.ME, { school_id: SCHOOL })).me.teacher_id, 'u_admin');
  assert.equal((await run(person('u_peter', 'Teacher'), schoolOps.ME, { school_id: SCHOOL })).me.teacher_id, 'u_peter');
  const left = await partition(keys.pk(SCHOOL));
  assert.ok(left.some((r) => r.SK === keys.sk.school()) && left.length > 8);
  ev(`administrator and teacher served; ${left.length} records in place`);
});
