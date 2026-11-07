import test from 'node:test';
import assert from 'node:assert/strict';
import { profileAssessments, subjectTargets, chartTerms } from '../../src/profileComparison.js';
import { loadStudentRisk } from '../../src/api/studentRisk.js';
import { getStudentRiskProfile } from '../../backend/lambdas/risk-service/decision.js';
import { ddb } from '../../backend/library/client.js';
import { pk, sk, gsi2 } from '../../backend/library/keys.js';

const prediction = (point, year = 2026) => ({ prediction_point: point, academic_year: year,
  student_id: 's', class_id: 'c', probability: 0.7, at_risk: true, threshold: 0.5,
  shap_base_value: 0, shap_values: { [`${point}_Kiswahili`]: 1, [`${point}_Mathematics`]: 2 },
  features: { [`${point}_Kiswahili`]: 40, [`${point}_Mathematics`]: 30 } });

test('legacy cache keeps latest explanation and earlier summaries without inventing historical explanations', () => {
  const profile = { academic_year: 2026, latest: prediction('T1F'), previous: prediction('T1M'),
    explained: true, factors: [{ group: 'Kiswahili' }], targets: { status: 'FOUND' },
    performance_trend: [{ point: 'T1M', subjects: [{ subject: 'Kiswahili', score: 40 }] }],
    interventions: [2025, 2026].map((year) => ({ intervention_id: String(year), linked: { academic_year: year, prediction_point: 'T1M' } })) };
  const [older, latest] = profileAssessments(profile);
  assert.equal(older.historyIncomplete, true);
  assert.equal(older.explained, false);
  assert.equal(older.targets, null);
  assert.equal(older.results.subjects[0].score, 40);
  assert.deepEqual(older.interventions.map((i) => i.intervention_id), ['2026']);
  assert.deepEqual(latest.factors, profile.factors);
  assert.equal(latest.targets, profile.targets);
});

test('next-term targets and CRE mapping work before next-term results exist', () => {
  const targets = subjectTargets({ changes: [
    { column: 'T2M_Religious_Education', kind: 'score', to: 60 },
    { column: 'Attendance_T2M', kind: 'attendance', to: 90 },
    { column: 'T2M_Mathematics', kind: 'score', to: 'invalid' },
  ] }, ['CRE', 'Mathematics']);
  assert.deepEqual([...targets], [['T2M:CRE', 60]]);
  assert.deepEqual(chartTerms([{ point: 'T1F' }], targets).map((t) => t.value), [1, 2]);
  assert.deepEqual(chartTerms([], targets).map((t) => t.value), [2]);
});

test('subject teacher does not request full-class predictions', async () => {
  let requests = 0;
  const result = await loadStudentRisk({ allowed: false, request: () => { requests++; throw new Error('forbidden'); } });
  assert.equal(result.size, 0);
  assert.equal(requests, 0);
});

test('roster indicators use newest checkpoint and explicitly request archived class year', async () => {
  const variables = [];
  const result = await loadStudentRisk({ allowed: true, schoolId: 'school', classId: 'c', academicYear: 2025,
    request: async (_, args) => {
      variables.push(args);
      return { listRiskPredictions: ['T1M', 'T1F'].includes(args.prediction_point) ? [prediction(args.prediction_point, 2025)] : [] };
    } });
  assert.equal(result.get('s').prediction_point, 'T1F');
  assert(variables.every((v) => v.academic_year === 2025));
});

test('risk request failure is reported instead of presenting an incomplete older prediction as latest', async () => {
  await assert.rejects(loadStudentRisk({ allowed: true, request: async (_, args) => {
    if (args.prediction_point === 'T2M') throw new Error('unavailable');
    return { listRiskPredictions: [prediction(args.prediction_point)] };
  } }), /unavailable/);
});

test('backend history scopes subjects and associates interventions by both year and checkpoint', async (t) => {
  const school = 'school';
  const terms = [2025, 2026].map((year) => ({ term_id: `term_${year}_1`, academic_year: year, term_number: 1,
    start_date: `${year}-01-05`, mid_term_date: `${year}-02-20`, end_date: `${year}-04-02` }));
  const student = { student_id: 's', class_id: 'c', first_name: 'Test', last_name: 'Student', status: 'ACTIVE' };
  const history = terms.flatMap((term) => ['MIDTERM', 'ENDTERM'].map((checkpoint) => ({
    student_id: 's', class_id: 'c', term_id: term.term_id, academic_year: term.academic_year,
    checkpoint, published_at: term.end_date, checkpoint_average: 35,
    subjects: [{ subject: 'Kiswahili', score: 40 }, { subject: 'Mathematics', score: 30 }],
  })));
  const interventions = [2025, 2026].map((year) => ({ intervention_id: String(year), student_id: 's',
    factor: 'Kiswahili', method: 'Practice', status: 'ONGOING', started_on: `${year}-02-21`,
    linked: { academic_year: year, prediction_point: 'T1M' } }));
  t.mock.method(ddb, 'send', async ({ input }) => {
    if (input.Key?.SK === sk.student('s')) return { Item: student };
    if (input.Key?.SK === sk.klass('c')) return { Item: { class_id: 'c', name: 'Form 2', year: 2026 } };
    const prefix = input.ExpressionAttributeValues?.[':s'];
    if (prefix === sk.termPrefix()) return { Items: terms };
    if (prefix === sk.studentResultPrefix('s')) return { Items: history };
    if (prefix === sk.interventionStudentPrefix('s')) return { Items: interventions };
    if (prefix === sk.teacherPrefix()) return { Items: [] }; // intervention creators are named from teacher records
    for (const year of [2025, 2026]) for (const point of ['T1M', 'T1F', 'T2M', 'T2F', 'T3M']) {
      if (input.Key?.SK === sk.risk(year, point, 's')) {
        assert.equal(input.ConsistentRead, true);
        return { Item: ['T1M', 'T1F'].includes(point) ? prediction(point, year) : undefined };
      }
    }
    throw new Error(`Unexpected read ${JSON.stringify(input)}`);
  });
  const actor = { groups: ['Teacher'], access: { assignments: [{ class_id: 'c', subject: 'Kiswahili' }], classTeacherOf: null } };
  const profile = await getStudentRiskProfile(actor, { school_id: school, student_id: 's', academic_year: 2026 });
  assert.equal(profile.assessment_history.length, 2);
  assert.deepEqual(profile.assessment_history[0].interventions.map((i) => i.intervention_id), ['2026']);
  assert.deepEqual(profile.assessment_history[0].factors.map((f) => f.group), ['Kiswahili']);
  assert.deepEqual(profile.assessment_history[0].results.subjects.map((s) => s.subject), ['Kiswahili']);
  assert.equal(profile.assessment_history[0].results.average, null);
  const past = await getStudentRiskProfile(actor, { school_id: school, student_id: 's', academic_year: 2025 });
  assert.equal(past.academic_year, 2025);
  assert.deepEqual(past.assessment_history[0].interventions.map((i) => i.intervention_id), ['2025']);
  assert.deepEqual(past.available_years, [2026, 2025]);
});

test('repository sends the requested year and keeps separate offline profile caches', async (t) => {
  await import('fake-indexeddb/auto');
  const { openFor, db, dropFor } = await import('../../src/offline/db.js');
  const { repository } = await import('../../src/offline/repository.js');
  const owner = 'graph-year-cache-test';
  openFor(owner);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('GetStudentRiskProfile')) {
      requested.push(variables.academic_year);
      return new Response(JSON.stringify({ data: { getStudentRiskProfile: {
        academic_year: variables.academic_year ?? 2026, student: { student_id: 's', class_id: 'c' }, interventions: [],
      } } }), { status: 200 });
    }
    if (query.includes('ListMyClasses')) return new Response(JSON.stringify({ data: { listMyClasses: [
      { class_id: 'c', status: 'CURRENT', my_subjects: ['Kiswahili'], is_class_teacher: true },
    ] } }), { status: 200 });
    throw new Error(`Unexpected query: ${query}`);
  });
  try {
    assert.equal((await repository.loadProfile('school', 's')).data.academic_year, 2026);
    assert.equal((await repository.loadProfile('school', 's', 2025)).data.academic_year, 2025);
    assert.deepEqual(requested, [null, 2025]);
    assert.equal((await db().cache.get('profile:s')).value.academic_year, 2026);
    assert.equal((await db().cache.get('profile:s:2025')).value.academic_year, 2025);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
    const past = await repository.loadProfile('school', 's', 2025);
    assert.equal(past.fromDevice, true);
    assert.equal(past.data.academic_year, 2025);
    assert.deepEqual(past.data.teaching.subjects, ['Kiswahili']);
  } finally {
    await dropFor(owner);
  }
});
