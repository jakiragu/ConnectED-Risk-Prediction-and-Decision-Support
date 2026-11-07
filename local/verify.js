import 'dotenv/config';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ddb, cognito } from '../backend/library/client.js';
import { TABLE, pk, sk } from '../backend/library/keys.js';
import { BASE_KEYS, INDEXES } from '../infra/table-definition.js';
import { verifyIdToken } from './cognito-auth.js';
import { attendancePeriods } from '../backend/library/calendar.js';
import * as risk from '../backend/library/riskRepo.js';

const SCHOOL = 'sch_saint_innocent';
const TERM = 'term_2026_3';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  ok ? passed++ : failed++;
}

const raw = new DynamoDBClient({
  region: process.env.AWS_REGION || 'eu-west-1',
  endpoint: process.env.DDB_ENDPOINT || 'http://localhost:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

/** Every item of one entity type (paginated scan; fine for the local seed table). */
async function scanEntity(entity) {
  const out = [];
  let cursor;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: '#e = :e AND PK = :school',
      ExpressionAttributeNames: { '#e': 'entity' },
      ExpressionAttributeValues: { ':e': entity, ':school': pk(SCHOOL) },
      ExclusiveStartKey: cursor,
    }));
    out.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return out;
}

const day = (iso) => String(iso || '').slice(0, 10);

const count = (prefix, extra = {}) => ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  ...extra,
  ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': prefix, ...(extra.ExpressionAttributeValues || {}) },
  Select: 'COUNT',
}));

async function run() {
  // 1. The table is built the way the deployment builds it.
  const { Table } = await raw.send(new DescribeTableCommand({ TableName: TABLE }));
  check('table key columns are PK and SK',
    Table.KeySchema.map((k) => k.AttributeName), [BASE_KEYS.pk, BASE_KEYS.sk]);
  check('all three lookup routes exist',
    (Table.GlobalSecondaryIndexes || []).map((i) => i.IndexName).sort(),
    INDEXES.map((i) => i.name));
  check('change recording is on', Table.StreamSpecification?.StreamEnabled, true);

  // 2. Verify this school without counting optional platform/model records.
  check('one school record', (await scanEntity('School')).length, 1);
  check('180 admission number claims', (await scanEntity('AdmissionNo')).length, 180);

  // 3. Students, rosters and classes.
  check('students at the school', (await count('STUDENT#')).Count, 180);
  const roster = await count('STUDENT#', {
    FilterExpression: 'class_id = :c AND #st = :a',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':c': 'cls_f4south', ':a': 'ACTIVE' },
  });
  check('Form 4 South roster', roster.Count, 20);
  check('classes', (await count('CLASS#')).Count, 9);

  const one = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.student('stu_17355') } }));
  check('Riziki Juma found directly',
    [one.Item?.first_name, one.Item?.last_name, one.Item?.class_id], ['Riziki', 'Juma', 'cls_f4south']);

  // 4. Teachers, assignments and class teachers.
  const teachers = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'TEACHER#' },
  }));
  const jane = teachers.Items.find((t) => t.email === 'jane.doe@saintinnocent.ac.ke');
  check('four teachers, one administrator',
    [teachers.Count, teachers.Items.filter((t) => t.role === 'Admin').length], [4, 1]);
  check('Jane teaches Kiswahili in 5 classes',
    [jane?.assignments?.length, [...new Set(jane?.assignments?.map((a) => a.subject))]], [5, ['Kiswahili']]);
  check('Jane is a Teacher and class teacher of the test class', [jane?.role, jane?.class_teacher_of], ['Teacher', 'cls_test']);
  const testClass = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.klass('cls_test') } }));
  check('the test class points back at Jane', testClass.Item?.class_teacher_id, jane?.teacher_id);
  const claim = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.admissionNo('17355') } }));
  check('admission number 17355 is claimed by Riziki', claim.Item?.student_id, 'stu_17355');

  // 5. Terms and grading rules.
  const rule = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(SCHOOL), SK: sk.gradeRule(TERM) } }));
  check('pass mark is 50', rule.Item?.pass_mark, 50);
  check('grading scale has 9 bands', rule.Item?.bands?.length, 9);
  const terms = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(SCHOOL), ':s': 'TERM#' },
  }));
  check('terms 1-3 seeded, all in academic year 2026',
    [terms.Count, [...new Set(terms.Items.map((t) => t.academic_year))]], [3, [2026]]);
  check('every term has a Mid-term date and a term number',
    terms.Items.every((t) => t.mid_term_date && t.term_number), true);
  const t1 = terms.Items.find((t) => t.term_id === 'term_2026_1');
  check('Term 1 school days: 35 to Mid-term, 27 after', attendancePeriods(t1).map((p) => p.school_days), [35, 27]);

  check('term statuses use the calendar vocabulary',
    terms.Items.every((t) => ['PAST', 'CURRENT', 'UPCOMING'].includes(t.status)), true);
  const termById = new Map(terms.Items.map((t) => [t.term_id, t]));
  const inTerm = (termId, iso) => {
    const t = termById.get(termId);
    return Boolean(t && day(iso) >= t.start_date && day(iso) <= t.end_date);
  };
  const outside = (rows, termOf, dateOf) => rows.filter((r) => !inTerm(termOf(r), dateOf(r))).length;

  // 6a. Gradebook activity: assessments, scores, attendance, publications, all inside their term.
  const assessmentRows = await scanEntity('Assessment');
  const scoreRows = await scanEntity('Score');
  const attendanceRows = await scanEntity('Attendance');
  const resultSets = await scanEntity('ResultSet');
  check('assessments: 9 classes x 9 subjects x 3 checkpoints', assessmentRows.length, 243);
  check('scores: 4860 minus two deliberate T2M gaps', scoreRows.length, 4858);
  check('attendance: 540 minus three deliberate T2M gaps', attendanceRows.length, 537);
  const testT2M = assessmentRows.filter((a) => a.class_id === 'cls_test' &&
    a.term_id === 'term_2026_2' && a.assessment_type === 'MIDTERM');
  const testStudents = (await scanEntity('Student')).filter((s) => s.class_id === 'cls_test');
  const scoreKeys = new Set(scoreRows.map((s) => `${s.assessment_id}:${s.student_id}`));
  const missingScores = testT2M.flatMap((a) => testStudents
    .filter((s) => !scoreKeys.has(`${a.assessment_id}:${s.student_id}`))
    .map((s) => `${s.student_id}:${a.subject}`)).sort();
  check('only the two intended T2M marks are missing', missingScores,
    ['stu_19001:Kiswahili', 'stu_19004:Kiswahili']);
  const t2Attendance = new Set(attendanceRows.filter((r) => r.term_id === 'term_2026_2' &&
    r.period === 'MIDTERM').map((r) => r.student_id));
  check('only the three intended T2M attendance entries are missing',
    testStudents.filter((s) => !t2Attendance.has(s.student_id)).map((s) => s.student_id).sort(),
    ['stu_19001', 'stu_19003', 'stu_19005']);
  check('assessments created and due inside their term',
    [outside(assessmentRows, (r) => r.term_id, (r) => r.created_at), outside(assessmentRows, (r) => r.term_id, (r) => r.due_date)], [0, 0]);
  check('marks entered inside their term', outside(scoreRows, (r) => r.term_id, (r) => r.entered_at), 0);
  check('attendance recorded inside its term', outside(attendanceRows, (r) => r.term_id, (r) => r.recorded_at), 0);
  check('attendance never exceeds school days',
    attendanceRows.filter((r) => r.days_attended < 0 || r.days_attended > r.school_days_when_entered).length, 0);
  const published = resultSets.filter((r) => r.published_at);
  check('18 published result sets (Term 1 only)', published.length, 18);
  check('results published inside their term', outside(published, (r) => r.term_id, (r) => r.published_at), 0);
  check('Term 2 and Term 3 remain unpublished for the demo',
    published.filter((r) => r.term_id !== 'term_2026_1').length, 0);
  const marksByClass = new Map();
  for (const r of scoreRows) {
    if (!marksByClass.has(r.class_id)) marksByClass.set(r.class_id, []);
    marksByClass.get(r.class_id).push(r.raw_score);
  }
  const classMeans = [...marksByClass.values()].map((v) => Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10);
  check('classes do not share identical mark sets', new Set(classMeans).size > 1, true);

  // 6b. Risk layer: a prediction with SHAP for every student at every checkpoint.
  const studentRows = await scanEntity('Student');
  const POINTS = ['T1M', 'T1F'];
  const predictions = [];
  for (const point of POINTS) {
    for (const s of studentRows) {
      const p = await risk.getPrediction(SCHOOL, 2026, point, s.student_id);
      predictions.push({ point, class_id: s.class_id, p });
    }
  }
  check('360 predictions, all with SHAP values',
    [predictions.filter((x) => x.p).length, predictions.filter((x) => x.p?.shap_values).length], [360, 360]);
  const flagged = predictions.filter((x) => x.p?.at_risk);
  const classIds = [...new Set(studentRows.map((s) => s.class_id))];
  const missingFlags = [];
  const missingTargets = [];
  for (const c of classIds) {
    for (const point of POINTS) {
      const here = flagged.filter((x) => x.class_id === c && x.point === point);
      if (!here.length) missingFlags.push(`${c} ${point}`);
      else if (!here.some((x) => ['FOUND', 'FALLBACK'].includes(x.p.counterfactuals?.status))) missingTargets.push(`${c} ${point}`);
    }
  }
  check('every class has a flagged student at every checkpoint', missingFlags, []);
  check('every flagged student has a counterfactual result (no errors)',
    flagged.filter((x) => !x.p.counterfactuals || x.p.counterfactuals.status === 'ERROR').length, 0);
  check('every class checkpoint has improvement targets for a flagged student', missingTargets, []);
  check('DiCE found a counterfactual in every class',
    classIds.filter((c) => !flagged.some((x) => x.class_id === c && x.p.counterfactuals?.status === 'FOUND')), []);
  const statusCounts = {};
  for (const x of flagged) statusCounts[x.p.counterfactuals?.status] = (statusCounts[x.p.counterfactuals?.status] || 0) + 1;
  console.log(`INFO  flagged ${flagged.length}; counterfactual statuses ${JSON.stringify(statusCounts)}`);

  // 6c. Interventions link to flagged Term 1 predictions. They may continue
  // into the holiday; dates are not required to lie inside Term 2.
  const interventionRows = (await scanEntity('Intervention')).filter((r) => String(r.intervention_id || '').startsWith('seed_'));
  const perClass = classIds.map((c) => interventionRows.filter((r) => r.class_id === c).length);
  check('every class has seeded interventions', perClass.every((n) => n > 0), true);
  const predictionByKey = new Map(predictions.filter((x) => x.p)
    .map((x) => [`${x.point}:${x.p.student_id}`, x.p]));
  check('every intervention links to a flagged Term 1 prediction',
    interventionRows.filter((r) => !predictionByKey.get(`${r.linked?.prediction_point}:${r.student_id}`)?.at_risk).length, 0);
  check('every flagged student/checkpoint has an intervention',
    flagged.filter((x) => !interventionRows.some((r) =>
      r.student_id === x.p.student_id && r.linked?.prediction_point === x.point)).length, 0);
  check('intervention dates follow their prediction and stop after starting',
    interventionRows.filter((r) => {
      const date = r.linked?.prediction_point === 'T1M' ? t1.mid_term_date : t1.end_date;
      return !r.started_on || r.started_on < date ||
        (r.status === 'STOPPED' && (!r.stopped_on || r.stopped_on < r.started_on));
    }).length, 0);
  const bySubject = {};
  for (const r of interventionRows) bySubject[r.factor] = (bySubject[r.factor] || 0) + 1;
  console.log(`INFO  ${interventionRows.length} interventions by subject ${JSON.stringify(bySubject)}`);

  // 6. GSI1 is the class+term index, and only assessments belong in it.
  const gsi1 = await ddb.send(new ScanCommand({
    TableName: TABLE, IndexName: 'GSI1', Select: 'COUNT',
    FilterExpression: '#e <> :a AND #e <> :i',
    ExpressionAttributeNames: { '#e': 'entity' },
    ExpressionAttributeValues: { ':a': 'Assessment', ':i': 'Intervention' },
  }));
  check('GSI1 holds assessments and interventions', gsi1.Count, 0);

  // 7. Signing in through the user pool gives a token the API accepts; a tampered one is rejected.
  const auth = await cognito.send(new InitiateAuthCommand({
    ClientId: process.env.COGNITO_CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: 'jane.doe@saintinnocent.ac.ke', PASSWORD: process.env.SEED_PASSWORD || 'Gradebook-Dev-2026!' },
  }));
  const token = auth.AuthenticationResult?.IdToken;
  const identity = token ? await verifyIdToken(token) : null;
  check('sign-in token carries role, school and the teacher id',
    [identity?.groups, identity?.claims?.['custom:school_id'], identity?.sub], [['Teacher'], SCHOOL, jane?.teacher_id]);
  const [h, p, sig] = token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  forged['cognito:groups'] = ['Admin'];
  check('self-promotion to Admin is rejected',
    await verifyIdToken(`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`), null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nVerification could not run.');
  console.error('Did you set up and seed first? Try: npm run aws:setup && npm run db:seed\n');
  console.error(err.message);
  process.exit(1);
});