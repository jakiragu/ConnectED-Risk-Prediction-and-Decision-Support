import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * Marks entered on the score-entry page while offline, and what happens when they
 * meet other people's changes. The browser side is the real offline code
 * (src/offline: IndexedDB through fake-indexeddb, the outbox, the sync engine and
 * the page's draft rules in scoreDrafts.js). The server side is the real GraphQL
 * schema and grading service against an in-process DynamoDB (dynalite), so the
 * documents the browser sends are checked against the schema as AppSync would.
 * The browser's fetch is the only stand-in: it hands each request to that schema
 * as the signed-in teacher, or fails as a dropped connection does.
 *
 *   node --test --test-concurrency=1 tests/store/offline-score-sync.test.js
 *
 * School: Form 2 East, Mathematics, one paper out of 50. Teachers Tom and Bea
 * both teach Mathematics there; students st1 to st6.
 */
const SCHOOL = 'sch_offline_test';
const CLASS = 'cls_f2e';
const TERM = 'term_2026_3';
const PAPER = 'asm_math_p1';
const SCHOOL_POOL = 'eu-west-1_schoolPool';
const ISSUER = `http://localhost:9229/${SCHOOL_POOL}`;
const who = (sub) => ({ sub, issuer: ISSUER, claims: { iss: ISSUER, 'custom:school_id': SCHOOL, email: `${sub}@school.test` }, groups: ['Teacher'] });
const TOM = who('u_tom');
const BEA = who('u_bea');
const tom = { sub: 'u_tom', schoolId: SCHOOL, groups: ['Teacher'] }; // the page's actor

const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
let graphql; let schema; let ops; let keys; let ddb; let Put;
let local; let engine; let drafts; let paper;

// ------------------------------------------------------------------ the connection
let connected = true;
let gate = null; // when set, requests wait for it: a save that is still on its way
async function bridge(_url, init) {
  if (!connected) throw new TypeError('Failed to fetch'); // what fetch does with no network
  if (gate) await gate;
  const { query, variables } = JSON.parse(init.body);
  const res = await graphql.execute({ schema, document: graphql.parse(query), variableValues: variables, contextValue: { identity: TOM } });
  if (res.errors?.length) {
    const e = res.errors[0];
    if (!e.originalError?.type) throw new Error(`the browser sent a document the schema refuses: ${e.message}`);
    return { ok: true, json: async () => ({ errors: [{ message: e.message, extensions: { errorType: e.originalError.type } }] }) };
  }
  return { ok: true, json: async () => ({ data: res.data }) };
}

/** Bea saves straight to the server from her own device. */
async function beaSaves(studentId, rawScore) {
  const current = (await serverMark(studentId))?._version ?? null;
  const res = await graphql.execute({
    schema, document: graphql.parse(ops.SUBMIT_SCORES), contextValue: { identity: BEA },
    variableValues: { input: { school_id: SCHOOL, assessment_id: PAPER, entries: [{ student_id: studentId, raw_score: rawScore, _version: current }] } },
  });
  assert.equal(res.errors, undefined);
  assert.equal(res.data.submitScores.results[0].outcome, 'APPLIED');
}

const serverMark = async (studentId) => {
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
  return (await ddb.send(new GetCommand({ TableName: keys.TABLE, Key: { PK: keys.pk(SCHOOL), SK: keys.sk.score(PAPER, studentId) } }))).Item || null;
};
const deviceMark = (studentId) => local.db().scores.get(local.scoreKey(PAPER, studentId));
const outbox = () => local.db().outbox.toArray();
/** The retry wait after a failed send has passed (the app's own timer would do this). */
const waitPassed = () => local.db().outbox.toCollection().modify({ retry_after: null });
/** The page loads (online): the device copy of the paper's marks is refreshed from the server. */
const pageLoads = () => engine.refreshScores(SCHOOL, PAPER);

/** What the page does on Save when it queues: one queueScore per changed row, with the row's base version. */
async function pageQueues(bases, saved, rows) {
  for (const [studentId, raw, status] of rows) {
    await engine.queueScore({
      schoolId: SCHOOL, assessment: paper, studentId, rawScore: raw, markStatus: status ?? null,
      version: drafts.versionFor(bases, saved, studentId), actor: tom,
    });
  }
}
const savedNow = async () => Object.fromEntries((await local.db().scores.where('assessment_id').equals(PAPER).toArray()).map((s) => [s.student_id, s]));

before(async () => {
  await new Promise((r) => server.listen(0, r));
  Object.assign(process.env, {
    DDB_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    EVENTS_ENDPOINT: 'http://127.0.0.1:9',
    GRADEBOOK_TABLE_NAME: 'offline_score_test',
    AWS_REGION: 'eu-west-1',
    PLATFORM_COGNITO_USER_POOL_ID: 'eu-west-1_angazaPool',
  });
  const { CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  ({ PutCommand: Put } = await import('@aws-sdk/lib-dynamodb'));
  ({ ddb } = await import('../../backend/library/client.js'));
  (await import('../helpers/transactShim.js')).emulateTransactions(ddb);
  const { TABLE_DEFINITION } = await import('../../infra/table-definition.js');
  const { StreamSpecification, ...table } = TABLE_DEFINITION;
  await ddb.send(new CreateTableCommand(table));
  keys = await import('../../backend/library/keys.js');

  graphql = await import('graphql');
  const { createSchema } = await import('graphql-yoga');
  const { RESOLVERS } = await import('../../local/resolvers.js');
  const resolvers = { Query: {}, Mutation: {} };
  for (const [parent, fields] of Object.entries(RESOLVERS)) {
    for (const [field, service] of Object.entries(fields)) {
      resolvers[parent][field] = (_root, args, ctx) =>
        service({ arguments: args, identity: ctx.identity, info: { fieldName: field, parentTypeName: parent } });
    }
  }
  schema = createSchema({ typeDefs: readFileSync('graphql/schema/gradebook.graphql', 'utf8'), resolvers });
  ops = await import('../../src/api/operations.js');

  const put = (Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(SCHOOL), school_id: SCHOOL, ...Item } }));
  await put({ SK: keys.sk.school(), entity: 'School', name: 'Offline Test School', status: 'ACTIVE' });
  for (const [sub, first] of [['u_tom', 'Tom'], ['u_bea', 'Bea']]) {
    await put({ SK: keys.sk.teacher(sub), entity: 'Teacher', teacher_id: sub, first_name: first, last_name: 'Teacher',
      role: 'Teacher', status: 'ACTIVE', assignments: [{ class_id: CLASS, subject: 'Mathematics' }] });
  }
  for (let i = 1; i <= 6; i++) {
    await put({ SK: keys.sk.student(`st${i}`), entity: 'Student', student_id: `st${i}`, class_id: CLASS,
      admission_no: String(100 + i), first_name: `Student${i}`, last_name: 'Test', status: 'ACTIVE' });
  }
  paper = { assessment_id: PAPER, class_id: CLASS, term_id: TERM, subject: 'Mathematics', title: 'Mathematics Paper 1',
    assessment_type: 'ENDTERM', paper_no: 1, weight: 100, max_score: 50, status: 'UNRECORDED', score_count: 0, _deleted: false, _version: 1 };
  await put({ SK: keys.sk.assessment(PAPER), entity: 'Assessment', ...paper });

  globalThis.fetch = bridge;
  local = await import('../../src/offline/db.js');
  engine = await import('../../src/offline/syncEngine.js');
  drafts = await import('../../src/offline/scoreDrafts.js');
  local.openFor('u_tom');
});

after(() => new Promise((r) => server.close(r)));

tc({
  id: 'TC-O01', requirement: 'FR-02', level: 'Integration (store)', technique: 'Black box, state transition',
  scenario: 'Marks saved offline, including an absent student, reach the server on reconnect',
  data: 'Tom offline: st1 = 42, st2 = Absent; then reconnects',
  expected: 'Both marks are kept on the device marked as waiting; after reconnecting the server holds 42 and ABSENT, the outbox is empty and the device copy is the server\'s',
}, async (ev) => {
  connected = false;
  await pageQueues({}, {}, [['st1', 42], ['st2', null, 'ABSENT']]);
  assert.equal((await deviceMark('st1'))._pending, true);
  assert.equal((await deviceMark('st2')).mark_status, 'ABSENT');
  await engine.push(); // what the app's timer tries while offline: nothing reaches the server
  assert.equal(await serverMark('st1'), null);
  ev(`offline: ${(await outbox()).length} marks waiting on the device`);

  connected = true;
  await waitPassed();
  await engine.push();
  const [s1, s2] = [await serverMark('st1'), await serverMark('st2')];
  assert.deepEqual([s1.raw_score, s1.mark_status, s1._version], [42, 'SCORED', 1]);
  assert.deepEqual([s2.raw_score, s2.mark_status], [null, 'ABSENT']);
  assert.equal((await outbox()).length, 0);
  assert.equal((await deviceMark('st2'))._pending, undefined);
  ev('server: st1 42 (v1), st2 ABSENT; outbox empty');
});

tc({
  id: 'TC-O02', requirement: 'FR-02', level: 'Integration (store)', technique: 'Black box, concurrency',
  scenario: 'A mark saved offline meets a different mark another teacher saved meanwhile',
  data: 'Bea saves st3 = 30; Tom loads the page, goes offline and enters 38; Bea changes st3 to 33; Tom reconnects',
  expected: 'Bea\'s 33 is not replaced: the mark is held for a decision with Tom\'s 38 beside it, on the server and on Tom\'s device, and nothing is left waiting to send',
}, async (ev) => {
  await beaSaves('st3', 30);
  await pageLoads();
  const saved = await savedNow();
  const bases = drafts.afterEdit({}, 'st3', '38', saved.st3); // Tom starts typing while looking at v1
  connected = false;
  await pageQueues(bases, saved, [['st3', 38]]);
  await beaSaves('st3', 33);

  connected = true;
  await waitPassed();
  await engine.push();
  const s3 = await serverMark('st3');
  assert.deepEqual([s3.raw_score, s3.status, s3.conflict_with_score, s3.conflict_with_user], [33, 'CONFLICT_REVIEW', 38, 'u_tom']);
  const mine = await deviceMark('st3');
  assert.deepEqual([mine.raw_score, mine.status, mine.conflict_with_score, mine._pending], [33, 'CONFLICT_REVIEW', 38, undefined]);
  assert.equal((await outbox()).length, 0);
  // The page's row is no longer being edited, so it shows the device copy: Bea's 33, held.
  const shown = drafts.follow({ st3: '38' }, drafts.finish(bases, ['st3']), await savedNow());
  assert.equal(shown.st3, '33');
  ev('server and device: 33, CONFLICT_REVIEW, 38 recorded beside it; row shows 33');
});

tc({
  id: 'TC-O03', requirement: 'FR-02', level: 'Integration (store)', technique: 'Black box, concurrency',
  scenario: 'The device copy changes while a teacher is typing in that row (lost-update guard)',
  data: 'Bea saves st4 = 20; Tom starts typing in st4; Bea changes it to 25 and Tom\'s device copy is refreshed to it; Tom saves 27',
  expected: 'Tom\'s save carries the version he started from, so the server does not overwrite Bea\'s 25 without anyone deciding: it holds the mark for a decision with 27 beside it',
}, async (ev) => {
  await beaSaves('st4', 20);
  await pageLoads();
  const bases = drafts.afterEdit({}, 'st4', '2', (await savedNow()).st4); // first keystroke, at v1
  await beaSaves('st4', 25);
  await pageLoads(); // e.g. another tab pulled the class; the device copy is now v2
  const saved = await savedNow();
  assert.equal(saved.st4._version, 2);
  assert.equal(drafts.versionFor(bases, saved, 'st4'), 1, 'the save would claim to have seen Bea\'s change');

  await pageQueues(bases, saved, [['st4', 27]]);
  await engine.push();
  const s4 = await serverMark('st4');
  assert.deepEqual([s4.raw_score, s4.status, s4.conflict_with_score], [25, 'CONFLICT_REVIEW', 27]);
  ev(`sent _version 1 (device held v2): server kept 25, held with 27 beside it`);
});

tc({
  id: 'TC-O04', requirement: 'FR-02', level: 'Integration (store)', technique: 'Black box, concurrency',
  scenario: 'A teacher changes a mark again while the first save of it is still on its way',
  data: 'Tom saves st5 = 10; while that request is in flight he saves st5 = 12',
  expected: 'Both reach the server in order without a conflict: the second is re-based on the version the first created, and the server ends at 12 (v2)',
}, async (ev) => {
  let release;
  gate = new Promise((r) => { release = r; });
  await pageQueues({}, {}, [['st5', 10]]);
  const sending = engine.push();
  await new Promise((r) => setTimeout(r, 50)); // the first save is now SENDING
  assert.equal((await outbox())[0].status, 'SENDING');
  await pageQueues({ st5: { version: null } }, {}, [['st5', 12]]); // typed from the same starting point
  gate = null;
  release();
  await sending;
  await engine.push();
  const s5 = await serverMark('st5');
  assert.deepEqual([s5.raw_score, s5._version, s5.status], [12, 2, 'ACTIVE']);
  assert.equal((await outbox()).length, 0);
  assert.equal((await deviceMark('st5')).raw_score, 12);
  ev('server: 12 (v2), ACTIVE; outbox empty');
});

tc({
  id: 'TC-O05', requirement: 'FR-02', level: 'Integration (store)', technique: 'Black box, concurrency',
  scenario: 'A teacher corrects, online, a mark of their own that was saved offline',
  data: 'Tom saves st6 = 15 offline and starts correcting it to 18 before reconnecting; the 15 is sent; then he saves 18 from the version he started from',
  expected: 'The server lets his later entry stand (same author), ending at 18 with no review',
}, async (ev) => {
  connected = false;
  await pageQueues({}, {}, [['st6', 15]]);
  const bases = drafts.afterEdit({}, 'st6', '18', await deviceMark('st6')); // base: the unsent 15 (no version yet)
  connected = true;
  await waitPassed();
  await engine.push();
  assert.equal((await serverMark('st6')).raw_score, 15);

  await pageQueues(bases, await savedNow(), [['st6', 18]]);
  await engine.push();
  const s6 = await serverMark('st6');
  assert.deepEqual([s6.raw_score, s6.status], [18, 'ACTIVE']);
  ev('server: 18, ACTIVE (later entry by the same teacher replaced the earlier one)');
});
