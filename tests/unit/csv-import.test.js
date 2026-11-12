import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, parseCsv, toCsv, readDate, checkStudentRows, checkAssessmentRows, studentTemplate, assessmentTemplate, tally,
} from '../../backend/library/csvImport.js';

const classes = [
  { class_id: 'c3e', name: 'Form 3 East', grade: 'Form 3', stream: 'East', status: 'CURRENT' },
  { class_id: 'c3w', name: 'Form 3 West', grade: 'Form 3', stream: 'West', status: 'CURRENT' },
  { class_id: 'c4e', name: 'Form 4 East', grade: 'Form 4', stream: 'East', status: 'CURRENT' },
  { class_id: 'old', name: 'Form 2 East', grade: 'Form 2', stream: 'East', status: 'PAST' },
];

test('csv: quotes, commas and line breaks inside quotes, CRLF, BOM and blank lines', () => {
  const text = '\uFEFFAdmission No,First name,Last name,Class\r\n4512,"Amina, Jr",Wanjiru,Form 3 East\r\n\r\n"4513","Brian ""B""",Otieno,"Form 3\nEast"\r\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['admission_no', 'first_name', 'last_name', 'class']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].values.first_name, 'Amina, Jr');
  assert.equal(rows[1].values.first_name, 'Brian "B"');
  assert.equal(rows[1].values.class, 'Form 3\nEast');
  assert.equal(rows[0].line, 2);
  assert.equal(rows[1].line, 4);
});

test('csv: semicolon files (Excel in some locales) are read too', () => {
  const { headers, rows } = parseCsv('admission_no;first_name;last_name;class\n1;A;B;Form 3 East\n');
  assert.deepEqual(headers, ['admission_no', 'first_name', 'last_name', 'class']);
  assert.equal(rows[0].values.class, 'Form 3 East');
});

test('csv: what toCsv writes, parseCsv reads back', () => {
  const rows = [['a', 'b'], ['x, y', 'say "hi"']];
  const parsed = parseCsv(toCsv(rows));
  assert.deepEqual(parsed.rows[0].values, { a: 'x, y', b: 'say "hi"' });
});

test('dates: ISO and day-first, real dates only', () => {
  assert.equal(readDate('2026-03-14'), '2026-03-14');
  assert.equal(readDate('14/03/2026'), '2026-03-14');
  assert.equal(readDate('4/3/2026'), '2026-03-04');
  assert.equal(readDate('31/02/2026'), null);
  assert.equal(readDate('March 4'), null);
});

test('students: ready, already added, and the errors the form would give', () => {
  const file = parseCsv(toCsv([
    ['admission_no', 'first_name', 'last_name', 'class'],
    ['4512', 'Amina', 'Wanjiru', 'form 3  east'],
    ['4100', 'brian', 'OTIENO', 'Form 3 East'],
    ['4101', 'Carol', 'Njeri', 'Form 3 East'],
    ['4512', 'Dan', 'Kip', 'Form 3 East'],
    ['45 12', 'Eve', 'Mo', 'Form 3 East'],
    ['4600', 'Fay', 'Ali', 'Form 2 East'],
    ['4601', '', 'Ali', 'Form 3 East'],
  ]));
  const students = [
    { admission_no: '4100', first_name: 'Brian', last_name: 'Otieno', class_id: 'c3e' },
    { admission_no: '4101', first_name: 'Grace', last_name: 'Achieng', class_id: 'c4e' },
  ];
  const { problem, rows } = checkStudentRows(file, { classes, students });
  assert.equal(problem, null);
  assert.deepEqual(rows.map((r) => r.status), ['READY', 'SKIP', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
  assert.deepEqual(rows[0].input, { class_id: 'c3e', first_name: 'Amina', last_name: 'Wanjiru', admission_no: '4512' });
  assert.match(rows[1].message, /Already in Form 3 East/);
  assert.match(rows[2].message, /already belongs to Grace Achieng/);
  assert.match(rows[3].message, /also on line 2/);
  assert.match(rows[4].message, /letters, digits/);
  assert.match(rows[5].message, /No current class is called Form 2 East/);
  assert.match(rows[6].message, /first name/);
  assert.deepEqual(tally(rows), { ready: 1, skip: 1, error: 5 });
});

test('students: a file without the needed columns is refused as a whole', () => {
  const { problem } = checkStudentRows(parseCsv('name,class\nAmina,Form 3 East\n'), { classes });
  assert.match(problem, /no admission_no, first_name, last_name column/);
  assert.match(checkStudentRows(parseCsv(''), { classes }).problem, /empty/);
});

const term = { checkpoints: ['MIDTERM', 'ENDTERM'], labels: { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End-term' } };
const header = ['class', 'subject', 'exam', 'component', 'number', 'weight', 'max_score', 'due_date', 'title'];

test('assessments: a form becomes one row per current class, with the form’s suggested title', () => {
  const file = parseCsv(toCsv([header, ['Form 3', 'mathematics', 'Mid term', '', '1', '50%', '100', '14/03/2026', '']]));
  const { rows, warnings } = checkAssessmentRows(file, { classes, ...term });
  assert.deepEqual(rows.map((r) => [r.className, r.status]), [['Form 3 East', 'READY'], ['Form 3 West', 'READY']]);
  assert.deepEqual(rows[0].input, {
    class_id: 'c3e', subject: 'Mathematics', assessment_type: 'MIDTERM', component_type: 'PAPER', paper_no: 1,
    weight: 50, max_score: 100, due_date: '2026-03-14', title: 'Mathematics Mid-term Paper 1',
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Form 3 East Mathematics Mid-term adds up to 50%, not 100%/);
});

test('assessments: rows are checked against each other and against what exists', () => {
  const existing = new Map([['c4e', [
    { assessment_id: 'a1', class_id: 'c4e', subject: 'English', assessment_type: 'ENDTERM', component_type: 'PAPER', paper_no: 1, weight: 60, max_score: 80 },
  ]]]);
  const file = parseCsv(toCsv([
    header,
    ['Form 4 East', 'English', 'End-term', 'Paper', '1', '60', '80', '', ''],
    ['Form 4 East', 'English', 'End-term', 'CAT', '1', '30', '30', '', ''],
    ['Form 4 East', 'English', 'End-term', 'CAT', '2', '20', '30', '', ''],
    ['Form 4 East', 'English', 'End-term', 'CAT', '1', '10', '30', '', ''],
    ['Form 4 East', 'English', 'Opener', 'Paper', '1', '100', '100', '', ''],
    ['Form 4 East', 'Art', 'End-term', 'Paper', '1', '100', '100', '', ''],
    ['Form 4 East', 'English', 'End-term', 'Essay', '1', '10', '10', '', ''],
    ['Form 9', 'English', 'End-term', 'Paper', '2', '10', '10', '', ''],
  ]));
  const { rows, warnings } = checkAssessmentRows(file, { classes, existing, ...term });
  assert.deepEqual(rows.map((r) => r.status), ['SKIP', 'READY', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
  assert.match(rows[2].message, /Only 10% of the English End-term exam is left/);
  assert.match(rows[3].message, /also on line 3/);
  assert.match(rows[4].message, /This term has no Opener/);
  assert.match(rows[5].message, /Art is not one of/);
  assert.match(rows[6].message, /Component is one of/);
  assert.match(rows[7].message, /No current class or form is called Form 9/);
  assert.deepEqual(warnings, ['Form 4 East English End-term adds up to 90%, not 100%']);
});

test('assessments: the school’s own exam names are understood', () => {
  const file = parseCsv(toCsv([header, ['Form 4 East', 'CRE', 'CAT exam', 'paper', '1', '100', '50', '', 'My title']]));
  const labels = { ...term.labels, MIDTERM: 'CAT exam' };
  const { rows, warnings } = checkAssessmentRows(file, { classes, checkpoints: term.checkpoints, labels });
  assert.equal(rows[0].status, 'READY');
  assert.equal(rows[0].input.assessment_type, 'MIDTERM');
  assert.equal(rows[0].input.title, 'My title');
  assert.deepEqual(warnings, []);
});

test('templates parse back as valid files', () => {
  const students = checkStudentRows(parseCsv(studentTemplate(classes)), { classes });
  assert.equal(students.problem, null);
  assert.ok(students.rows.every((r) => r.status === STATUS.READY));
  const assessments = checkAssessmentRows(parseCsv(assessmentTemplate(classes)), { classes, ...term });
  assert.equal(assessments.problem, null);
  assert.ok(assessments.rows.every((r) => r.status === STATUS.READY));
  assert.deepEqual(assessments.warnings, []);
});

// ------------------------------------------------------------------ marks
import { checkScoreRows, markSheet } from '../../backend/library/csvImport.js';

const paper = (id, classId, subject, n, extra = {}) => ({
  assessment_id: id, class_id: classId, subject, assessment_type: 'MIDTERM', component_type: 'PAPER', paper_no: n, max_score: 100, status: 'UNRECORDED', ...extra,
});
const marksContext = () => ({
  classes,
  students: [
    { student_id: 'st1', admission_no: '3101', first_name: 'Brian', last_name: 'Otieno', class_id: 'c3e', status: 'ACTIVE' },
    { student_id: 'st2', admission_no: '3102', first_name: 'Joy', last_name: 'Wambui', class_id: 'c3e', status: 'ACTIVE' },
    { student_id: 'st3', admission_no: '3201', first_name: 'Ian', last_name: 'Njeri', class_id: 'c3w', status: 'ACTIVE' },
    { student_id: 'st4', admission_no: '3202', first_name: 'Old', last_name: 'Leaver', class_id: 'c3w', status: 'INACTIVE' },
  ],
  assessments: new Map([
    ['c3e', [paper('e1', 'c3e', 'Mathematics', 1), paper('e2', 'c3e', 'Mathematics', 2), paper('e3', 'c3e', 'English', 1, { max_score: 80 })]],
    ['c3w', [paper('w1', 'c3w', 'Mathematics', 1), paper('w3', 'c3w', 'English', 1, { status: 'LOCKED' })]],
  ]),
  scores: new Map([['e1', new Map([['st1', { raw_score: 40, mark_status: 'SCORED', _version: 3 }]])],
    ['e2', new Map([['st1', { raw_score: null, mark_status: 'ABSENT', _version: 1 }]])]]),
  examName: 'Mid-term',
});

test('marks: the mark sheet lists every active student with saved marks, and reads back with nothing to change', () => {
  const ctx = marksContext();
  const sheet = markSheet(ctx);
  const parsed = parseCsv(sheet);
  assert.deepEqual(parsed.titles, ['admission_no', 'name', 'class', 'Mathematics Paper 1', 'Mathematics Paper 2', 'English Paper 1']);
  assert.deepEqual(parsed.rows.map((r) => r.values.admission_no), ['3101', '3102', '3201']);
  assert.equal(parsed.rows[0].values.mathematics_paper_1, '40');
  assert.equal(parsed.rows[0].values.mathematics_paper_2, 'ABS');
  assert.equal(parsed.rows[2].values.mathematics_paper_2, '');
  assert.ok(!sheet.includes('Form 4 East'), 'classes without papers in the exam are left out');
  const { rows, problem } = checkScoreRows(parsed, ctx);
  assert.equal(problem, null);
  assert.deepEqual(rows.map((r) => r.status), ['SKIP', 'SKIP', 'SKIP']);
});

test('marks: new, changed and special marks become entries; problems name the paper', () => {
  const file = parseCsv(toCsv([
    ['Admission No', 'Name', 'Class', 'Mathematics Paper 1', 'Mathematics P2', 'English Paper 1', 'Total'],
    ['3101', '', '', '45', 'abs', '', '85'],
    ['3102', '', 'Form 3 East', '60.5', 'NA', '81', ''],
    ['3201', '', '', '50', '7', '', ''],
    ['3201', '', '', '', '', '', ''],
    ['3202', '', '', '50', '', '', ''],
    ['3101', '', '', '', '', '', ''],
  ]));
  const { rows, warnings } = checkScoreRows(file, marksContext());
  assert.deepEqual(rows.map((r) => r.status), ['READY', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
  assert.deepEqual(rows[0].input.marks.map((m) => [m.assessment_id, m.raw_score, m.mark_status, m._version]), [['e1', 45, 'SCORED', 3]]);
  assert.match(rows[0].message, /Replaces 1 saved mark/);
  assert.match(rows[1].message, /English Paper 1: score must be between 0 and 80, not 81/);
  assert.match(rows[2].message, /Form 3 West has no Mathematics P2 in the Mid-term/);
  assert.match(rows[3].message, /also on line 4/);
  assert.equal(checkScoreRows(parseCsv('admission_no,Mathematics Paper 1\n3102,\n'), marksContext()).rows[0].message, 'No marks in this row');
  assert.match(rows[4].message, /No active student/);
  assert.match(rows[5].message, /also on line 2/);
  assert.match(warnings[0], /The column Total matches no paper in the Mid-term, so it is ignored/);
  assert.match(warnings[1], /1 mark already saved will be replaced/);
});

test('marks: a wrong class, a locked paper and a file with no paper columns', () => {
  const ctx = marksContext();
  const wrong = checkScoreRows(parseCsv('admission_no,class,Mathematics Paper 1\n3101,Form 3 West,50\n'), ctx);
  assert.match(wrong.rows[0].message, /Brian Otieno is in Form 3 East, not Form 3 West/);
  const locked = checkScoreRows(parseCsv('admission_no,English Paper 1\n3201,50\n'), ctx);
  assert.match(locked.rows[0].message, /English Paper 1 is locked/);
  assert.match(checkScoreRows(parseCsv('admission_no,Physics Paper 1\n3101,50\n'), ctx).problem, /No column matches a paper in the Mid-term/);
  const ok = checkScoreRows(parseCsv('admission_no,Mathematics Paper 1\n3102,50\n'), ctx);
  assert.deepEqual(ok.rows[0].input.marks[0], { assessment_id: 'e1', column: 'Mathematics Paper 1', student_id: 'st2', raw_score: 50, mark_status: 'SCORED', _version: null });
});
