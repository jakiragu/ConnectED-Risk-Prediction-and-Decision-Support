import assert from 'node:assert/strict';
import { tc } from '../helpers/harness.js';
import { interventionsThatConcern, riskScope } from '../../backend/library/decisionSupport.js';
import { mapLimit } from '../../backend/library/concurrency.js';

const CLASS_TEACHER = 'tch_class';
const MATHS_TEACHER = 'tch_maths';
const roster = new Set(['stu_1', 'stu_2']);
const logged = [
  { intervention_id: 'a', student_id: 'stu_1', factor: 'Mathematics', status: 'ONGOING', created_by: CLASS_TEACHER },
  { intervention_id: 'b', student_id: 'stu_1', factor: 'Mathematics', status: 'ONGOING', created_by: MATHS_TEACHER },
  { intervention_id: 'c', student_id: 'stu_2', factor: 'Biology', status: 'ONGOING', created_by: CLASS_TEACHER },
  { intervention_id: 'd', student_id: 'stu_2', factor: 'Attendance', status: 'ONGOING', created_by: CLASS_TEACHER },
  { intervention_id: 'e', student_id: 'stu_2', factor: 'Mathematics', status: 'STOPPED', created_by: MATHS_TEACHER },
  { intervention_id: 'f', student_id: 'stu_gone', factor: 'Mathematics', status: 'ONGOING', created_by: MATHS_TEACHER },
];
const ids = (list) => list.map((i) => i.intervention_id).sort();

tc({
  id: 'TC-U13', requirement: 'NFR-1 / US-05', level: 'Unit', technique: 'White box, equivalence classes',
  scenario: 'Which ongoing interventions the dashboard shows a subject teacher and a class teacher',
  data: 'one class: Mathematics interventions logged by the class teacher and by the Mathematics teacher, a Biology and an Attendance intervention, a stopped one, and one for a student no longer on the roster',
  expected: "The Mathematics teacher sees both ongoing Mathematics interventions, including the class teacher's, and nothing for Biology or Attendance; the class teacher sees every ongoing one; stopped ones and students who left are excluded",
}, (ev) => {
  const maths = interventionsThatConcern(riskScope({ subjects: ['Mathematics'] }), logged, roster);
  assert.deepEqual(ids(maths), ['a', 'b']);
  const classTeacher = interventionsThatConcern(riskScope({ isClassTeacher: true }), logged, roster);
  assert.deepEqual(ids(classTeacher), ['a', 'b', 'c', 'd']);
  assert.deepEqual(interventionsThatConcern(null, logged, roster), []);
  ev(`maths teacher: ${ids(maths).join(',')}; class teacher: ${ids(classTeacher).join(',')}`);
});

tc({
  id: 'TC-U14', requirement: 'NFR-2', level: 'Unit', technique: 'White box',
  scenario: 'Bounded parallel reads keep their order and never exceed the limit',
  data: '20 items, limit 4, each call waiting a few milliseconds',
  expected: 'Results come back in input order and at most 4 calls run at once',
}, async (ev) => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async (n) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    running -= 1;
    return n * 2;
  });
  assert.deepEqual(out, Array.from({ length: 20 }, (_, i) => i * 2));
  assert.ok(peak <= 4 && peak > 1);
  ev(`peak concurrency ${peak}`);
});
