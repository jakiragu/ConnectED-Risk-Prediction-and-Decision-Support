import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before } from 'node:test';
import dynalite from 'dynalite';
import { tc } from '../helpers/harness.js';

/**
 * Results by SMS, end to end: the web client's documents (src/api/operations.js)
 * through the real GraphQL schema and resolver map, against an in-process
 * DynamoDB. Africa's Talking is replaced by a stand-in for fetch, so nothing
 * leaves the machine and every message can be inspected.
 *
 *   npm run test:store
 */
const SCHOOL = 'sch_sms';
const TERM = 'term_2026_3';
const server = dynalite({ createTableMs: 0, updateTableMs: 0, deleteTableMs: 0 });
let schema;
let ops;
let graphql;
let keys;
let ddb;
let Put;
const outbox = [];
let providerReply = () => ({ statusCode: 101, status: 'Success' });

before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.DDB_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.EVENTS_ENDPOINT = 'http://127.0.0.1:9';
  process.env.GRADEBOOK_TABLE_NAME = 'results_sms_test';
  process.env.AWS_REGION = 'eu-west-1';
  process.env.SMS_TRANSPORT = 'africastalking';
  process.env.AT_USERNAME = 'sandbox';
  process.env.AT_API_KEY = 'test-key';

  // Only Africa's Talking calls go through fetch; the AWS SDK uses its own HTTP client.
  globalThis.fetch = async (url, init) => {
    const to = init.body.get('to');
    const message = init.body.get('message');
    outbox.push({ url, to, message });
    const r = providerReply(to);
    return {
      status: 201, ok: true,
      text: async () => JSON.stringify({ SMSMessageData: { Message: 'Sent', Recipients: [{ ...r, number: to, cost: 'KES 0.8000', messageId: `ATX_${outbox.length}` }] } }),
    };
  };

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
  await seed();
});

after(() => new Promise((r) => server.close(r)));

const put = (Item) => ddb.send(new Put({ TableName: keys.TABLE, Item: { PK: keys.pk(SCHOOL), school_id: SCHOOL, ...Item } }));

async function run(document, variables) {
  const res = await graphql.execute({
    schema,
    document: graphql.parse(document),
    variableValues: variables,
    contextValue: { identity: { sub: 'u_admin', claims: { 'custom:school_id': SCHOOL, email: 'admin@test' }, groups: [] } },
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => `${e.path?.join('.') ?? ''}: ${e.message}`).join(' | '));
  return res.data;
}

const scope = { school_id: SCHOOL, class_id: 'c3', term_id: TERM, checkpoint: 'ENDTERM' };

async function seed() {
  await put({ SK: keys.sk.school(), entity: 'School', name: 'Greenfield High' });
  await put({ SK: keys.sk.term(TERM), entity: 'Term', term_id: TERM, name: 'Term 3 2026', academic_year: 2026, term_number: 3, start_date: '2026-09-01', end_date: '2026-11-25' });
  await put({ SK: keys.sk.teacher('u_admin'), entity: 'Teacher', teacher_id: 'u_admin', first_name: 'Ada', last_name: 'Admin', role: 'Admin', status: 'ACTIVE', assignments: [], _version: 1 });
  await put({ SK: keys.sk.klass('c3'), entity: 'Class', class_id: 'c3', name: 'Form 3 East', grade: 'Form 3', stream: 'East', year: 2026, status: 'CURRENT', _version: 1 });
  const ids = ['s1', 's2', 's3', 's4'];
  await put({
    SK: keys.sk.resultSet(TERM, 'c3', 'ENDTERM'), entity: 'ResultSet', term_id: TERM, class_id: 'c3', checkpoint: 'ENDTERM', kind: 'FINAL',
    status: 'PUBLISHED', subjects: ['English', 'Mathematics'], calculation_id: 'calc_1', published_at: '2026-11-20T10:00:00Z', student_ids: ids, _version: 2,
  });
  for (const [i, id] of ids.entries()) {
    const score = 50 + i * 10;
    await put({
      SK: keys.sk.termResult(TERM, 'c3', 'ENDTERM', 'calc_1', id), entity: 'TermResult', student_id: id, class_id: 'c3', term_id: TERM,
      checkpoint: 'ENDTERM', kind: 'FINAL', checkpoint_average: score, term_average: score, term_grade: 'C',
      subjects: [
        { subject: 'English', papers: [{}], score, term: { term_score: score, grade: 'C', weight_applied: 100 } },
        { subject: 'Mathematics', papers: [{}], score, term: { term_score: score, grade: 'C', weight_applied: 100 } },
      ],
    });
    await put({ SK: keys.sk.student(id), entity: 'Student', student_id: id, class_id: 'c3', admission_no: `450${i}`, first_name: `Pupil${i}`, last_name: 'Otieno', status: 'ACTIVE', _version: 1 });
    await put({ SK: keys.sk.admissionNo(`450${i}`), entity: 'AdmissionNo', admission_no: `450${i}`, student_id: id });
  }
}

const cardsBy = async () => new Map((await run(ops.LIST_REPORT_CARDS, scope)).listReportCards.map((c) => [c.student_id, c]));

tc({
  id: 'TC-M01', requirement: 'EXT-SMS', level: 'Integration (store)', technique: 'Black box, interface',
  scenario: 'Guardian contacts are entered, validated and stored through the student documents',
  data: 'UPDATE_STUDENT with 0712 345 678; with a non-Kenyan local number; with SMS turned off; LIST_STUDENTS',
  expected: 'The number is stored as +254712345678; an invalid number is refused with a reason; the opt-out is kept',
}, async (ev) => {
  const { listStudents } = await run(ops.LIST_STUDENTS, { school_id: SCHOOL, class_id: 'c3', include_inactive: true });
  const v = (id) => listStudents.find((s) => s.student_id === id)._version;
  const { updateStudent: s1 } = await run(ops.UPDATE_STUDENT, { input: { school_id: SCHOOL, student_id: 's1', guardian_name: 'Grace Otieno', guardian_phone: '0712 345 678', _version: v('s1') } });
  assert.deepEqual([s1.guardian_name, s1.guardian_phone, s1.results_sms, s1.first_name], ['Grace Otieno', '+254712345678', true, 'Pupil0']);
  await assert.rejects(
    run(ops.UPDATE_STUDENT, { input: { school_id: SCHOOL, student_id: 's2', guardian_phone: '0212 345 678', _version: v('s2') } }),
    /Kenyan mobile/
  );
  await run(ops.UPDATE_STUDENT, { input: { school_id: SCHOOL, student_id: 's2', guardian_phone: '0722 111 222', _version: v('s2') } });
  await run(ops.UPDATE_STUDENT, { input: { school_id: SCHOOL, student_id: 's3', guardian_phone: '+256 712 000 333', results_sms: false, _version: v('s3') } });
  // s4 has no number.
  const after = (await run(ops.LIST_STUDENTS, { school_id: SCHOOL, class_id: 'c3', include_inactive: true })).listStudents;
  const s3 = after.find((s) => s.student_id === 's3');
  assert.deepEqual([s3.guardian_phone, s3.results_sms], ['+256712000333', false]);
  ev(`s1 ${s1.guardian_phone}; s3 ${s3.guardian_phone} opted out`);
});

tc({
  id: 'TC-M02', requirement: 'EXT-SMS', level: 'Integration (store)', technique: 'Black box, interface',
  scenario: 'Text parents sends a published result once to each reachable guardian and records the outcome per student',
  data: 'PREVIEW_RESULTS_SMS, SEND_RESULTS_SMS twice for the class, LIST_REPORT_CARDS; s1 and s2 have numbers, s3 opted out, s4 has none',
  expected: 'Two messages go out; the second press sends nothing; s3 and s4 are skipped with their reasons; the report cards list shows Sent with the last digits',
}, async (ev) => {
  const { previewResultsSms: preview } = await run(ops.PREVIEW_RESULTS_SMS, scope);
  assert.equal(preview.ready, true);
  assert.equal(preview.sandbox, true);
  assert.equal(preview.student_id, 's1');
  assert.match(preview.text, /^Greenfield High: Term 3 2026 End of term results for Pupil0 Otieno \(4500\), Form 3 East\. Mean 50 C\./);
  assert.equal(preview.segments, 2); // just over 160 characters

  outbox.length = 0;
  const { sendResultsSms: first } = await run(ops.SEND_RESULTS_SMS, { input: scope });
  assert.deepEqual({ ...first }, { sent: 2, failed: 0, no_number: 1, opted_out: 1, already_sent: 0, not_attempted: 0, problem: null });
  assert.deepEqual(outbox.map((m) => m.to).sort(), ['+254712345678', '+254722111222']);
  assert.ok(outbox.every((m) => m.url.includes('sandbox')));

  const { sendResultsSms: again } = await run(ops.SEND_RESULTS_SMS, { input: scope });
  assert.deepEqual([again.sent, again.already_sent], [0, 2]);
  assert.equal(outbox.length, 2, 'pressing again sends nothing new');

  const cards = await cardsBy();
  assert.deepEqual([cards.get('s1').sms_status, cards.get('s1').sms_to_hint], ['SENT', '…678']);
  assert.deepEqual([cards.get('s3').has_guardian_phone, cards.get('s3').results_sms, cards.get('s3').sms_status], [true, false, null]);
  assert.deepEqual([cards.get('s4').has_guardian_phone, cards.get('s4').sms_status], [false, null]);
  ev(`first ${JSON.stringify(first)}; second sent ${again.sent}`);
});

tc({
  id: 'TC-M03', requirement: 'EXT-SMS', level: 'Integration (store)', technique: 'Black box, error guessing',
  scenario: 'A refused number fails only its own message, and can be sent again once fixed; one parent can be resent on purpose',
  data: 'Provider refuses s2 (InvalidPhoneNumber) on a resend to the class; then a single-student resend of s1',
  expected: 'The class resend reports 1 sent and 1 failed with the reason on s2; resending only s1 sends exactly one message',
}, async (ev) => {
  providerReply = (to) => (to === '+254722111222' ? { statusCode: 403, status: 'InvalidPhoneNumber' } : { statusCode: 101, status: 'Success' });
  outbox.length = 0;
  const { sendResultsSms: resend } = await run(ops.SEND_RESULTS_SMS, { input: { ...scope, resend: true } });
  assert.deepEqual([resend.sent, resend.failed, resend.problem], [1, 1, null]);
  const cards = await cardsBy();
  assert.equal(cards.get('s2').sms_status, 'FAILED');
  assert.match(cards.get('s2').sms_problem, /not a valid mobile number/);

  providerReply = () => ({ statusCode: 101, status: 'Success' });
  outbox.length = 0;
  const { sendResultsSms: retry } = await run(ops.SEND_RESULTS_SMS, { input: scope });
  assert.deepEqual([retry.sent, retry.already_sent], [1, 1], 'a failed message is retried without resend; the sent one is left alone');
  assert.deepEqual(outbox.map((m) => m.to), ['+254722111222']);

  outbox.length = 0;
  const { sendResultsSms: one } = await run(ops.SEND_RESULTS_SMS, { input: { ...scope, student_ids: ['s1'], resend: true } });
  assert.equal(one.sent, 1);
  assert.deepEqual(outbox.map((m) => m.to), ['+254712345678']);
  ev(`resend ${JSON.stringify(resend)}; retry sent ${retry.sent}; single resend to ${outbox.length}`);
});

tc({
  id: 'TC-M04', requirement: 'EXT-SMS', level: 'Integration (store)', technique: 'Black box, error guessing',
  scenario: 'An SMS account with no credit stops the batch instead of failing every message',
  data: 'Provider answers InsufficientBalance; resend to the class',
  expected: 'One message fails, the rest are not attempted, and the reason is returned once',
}, async (ev) => {
  providerReply = () => ({ statusCode: 405, status: 'InsufficientBalance' });
  const { sendResultsSms: out } = await run(ops.SEND_RESULTS_SMS, { input: { ...scope, resend: true } });
  assert.equal(out.sent, 0);
  assert.ok(out.failed >= 1 && out.failed + out.not_attempted === 2, JSON.stringify(out));
  assert.match(out.problem, /run out of credit/);
  providerReply = () => ({ statusCode: 101, status: 'Success' });
  ev(JSON.stringify(out));
});

tc({
  id: 'TC-M05', requirement: 'EXT-SMS', level: 'Integration (store)', technique: 'Black box, error guessing',
  scenario: 'Results that are not published cannot be texted',
  data: 'SEND_RESULTS_SMS for the Mid-term checkpoint, which has no published result',
  expected: 'Refused with a message saying the results are not published',
}, async (ev) => {
  await assert.rejects(run(ops.SEND_RESULTS_SMS, { input: { ...scope, checkpoint: 'MIDTERM' } }), /not published/);
  ev('refused');
});
