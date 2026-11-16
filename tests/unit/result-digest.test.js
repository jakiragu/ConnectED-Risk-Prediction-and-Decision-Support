import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCheckpoint } from '../../backend/library/results.js';
import { buildClassProfile, examMean, examValue } from '../../backend/library/classProfile.js';
import { digestOf, rowsOf } from '../../backend/library/resultDigest.js';

// A class's Mid-term and End-term, worked out the way the gradebook does, with an absent paper,
// a not-assessed paper and a missing mark so the "incomplete" flags are exercised.
const SUBJECTS = ['Mathematics', 'English', 'Kiswahili', 'Chemistry', 'Biology', 'Physics', 'History', 'Geography', 'CRE'];
const bands = [
  { grade: 'A', min_score: 70, max_score: 100 },
  { grade: 'B', min_score: 50, max_score: 69.99 },
  { grade: 'C', min_score: 0, max_score: 49.99 },
];
const rule = { bands, pass_mark: 50, missing_score_policy: 'EXCLUDE', checkpoint_weights: { OPENER: 0, MIDTERM: 40, ENDTERM: 60 } };
const roster = Array.from({ length: 45 }, (_, i) => ({
  student_id: `stu_01JABCDEFGHJKMNPQRSTV${String(i).padStart(5, '0')}`, first_name: `F${i}`, last_name: `L${i}`, admission_no: String(17000 + i),
}));

function exam(checkpoint, previousRows = {}) {
  const assessments = [];
  const scoresByAssessment = new Map();
  let k = 3;
  for (const subject of SUBJECTS) {
    for (const paper of [1, 2]) {
      const id = `asm_${checkpoint}_${subject}_${paper}`;
      assessments.push({ assessment_id: id, subject, paper_no: paper, component_type: 'PAPER', assessment_type: checkpoint, weight: paper === 1 ? 60 : 40, max_score: 80, title: id, _version: 1 });
      scoresByAssessment.set(id, roster.flatMap((s, i) => {
        if (subject === 'Physics' && paper === 2 && i === 4) return []; // no mark recorded
        if (subject === 'CRE' && i === 7) return [{ student_id: s.student_id, mark_status: 'NOT_ASSESSED' }];
        if (subject === 'English' && paper === 1 && i === 2) return [{ student_id: s.student_id, mark_status: 'ABSENT' }];
        k = (k * 31 + 7) % 81;
        return [{ student_id: s.student_id, raw_score: k }];
      }));
    }
  }
  const calc = calculateCheckpoint({ checkpoint, assessments, scoresByAssessment, roster, gradeRule: rule, previousPublished: true, previousRows, openerEnabled: false });
  assert.equal(calc.blocking, false, JSON.stringify(calc.issues));
  return calc.rows;
}
const mid = exam('MIDTERM');
const end = exam('ENDTERM', { MIDTERM: new Map(mid.map((r) => [r.student_id, r])) });
const set = (checkpoint) => ({ term_id: 'term_1', class_id: 'cls_a', checkpoint, calculation_id: `calc_${checkpoint}`, kind: checkpoint === 'ENDTERM' ? 'FINAL' : 'INTERIM' });
const viaDigest = (checkpoint, rows) => rowsOf(digestOf(set(checkpoint), rows));
const byId = (rows) => new Map(rows.map((r) => [r.student_id, r]));

test('result digest: the class page shows exactly the same from a digest as from the full rows', () => {
  for (const subjects of [null, ['Mathematics'], ['English', 'Physics', 'CRE']]) {
    for (const [checkpoint, rows, previous] of [['MIDTERM', mid, null], ['ENDTERM', end, { checkpoint: 'MIDTERM', rows: mid }]]) {
      const profile = (r, p, school) => buildClassProfile({
        checkpoint, roster, rows: byId(r), previousRows: p ? { checkpoint: p.checkpoint, rows: byId(p.rows) } : null,
        rule, subjects, schoolRows: school,
      });
      const full = profile(rows, previous, [...rows, ...mid]);
      const brief = profile(viaDigest(checkpoint, rows), previous && { ...previous, rows: viaDigest('MIDTERM', previous.rows) },
        [...viaDigest(checkpoint, rows), ...viaDigest('MIDTERM', mid)]);
      assert.deepEqual(brief, full, `${checkpoint} ${subjects ?? 'whole class'}`);
      if (!subjects) assert.ok(full.summary.incomplete > 0, 'the fixture has incomplete marks');
      assert.equal(examMean(viaDigest(checkpoint, rows), subjects), examMean(rows, subjects));
      rows.forEach((r, i) => assert.equal(examValue(viaDigest(checkpoint, rows)[i], subjects), examValue(r, subjects)));
    }
  }
});

test('result digest: a subject missing from a row stays missing', () => {
  const rows = [{ ...mid[0], subjects: mid[0].subjects.filter((s) => s.subject !== 'History') }, mid[1]];
  const back = viaDigest('MIDTERM', rows);
  assert.equal(back[0].subjects.some((s) => s.subject === 'History'), false);
  assert.equal(back[1].subjects.some((s) => s.subject === 'History'), true);
});

// DynamoDB's item size: names and strings by their UTF-8 bytes, numbers about one byte per two digits.
const size = (v) => {
  if (v === null || v === undefined || typeof v === 'boolean') return 1;
  if (typeof v === 'number') return Math.ceil(String(Math.abs(v)).replace(/[.-]/g, '').length / 2) + 1;
  if (typeof v === 'string') return Buffer.byteLength(v);
  if (Array.isArray(v)) return 3 + v.reduce((t, x) => t + 1 + size(x), 0);
  return 3 + Object.entries(v).reduce((t, [k, x]) => t + 1 + Buffer.byteLength(k) + size(x), 0);
};

test('result digest: a class of 45 is a few KB, a tenth of its full rows', () => {
  const digest = size(digestOf(set('ENDTERM'), end));
  const rows = end.reduce((t, r) => t + size(r), 0);
  assert.ok(digest < 8_000, `digest is ${digest} bytes`);
  assert.ok(digest * 8 < rows, `digest ${digest} bytes, rows ${rows} bytes`);
});
