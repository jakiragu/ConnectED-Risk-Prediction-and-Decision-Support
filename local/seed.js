import 'dotenv/config';

import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../backend/library/client.js';
import { TABLE, pk, sk, gsi1, gsi2, gsi3 } from '../backend/library/keys.js';
import { ensureTable } from './create-table.js';
import * as identity from '../backend/library/identity.js';
import { seedPublishedHistory } from './seed-history.js';
import { attendancePeriods, termStatus, todayIn } from '../backend/library/calendar.js';
import * as platformIdentity from '../backend/library/platformIdentity.js';
import { putStaff, registrationItems } from '../backend/library/platformStore.js';
import { DEFAULT_ASSESSMENT_SCHEME } from '../backend/library/assessmentConfig.js';
import { pathToFileURL } from 'node:url';

const seedStartedAt = Date.now();

function progress(message) {
  const elapsed = ((Date.now() - seedStartedAt) / 1000).toFixed(1);
  console.log(`[seed +${elapsed}s] ${message}`);
}

const DEV_PASSWORD = process.env.SEED_PASSWORD || 'Gradebook-Dev-2026!';
const SCHOOL = 'sch_saint_innocent';
const TERM = 'term_2026_2';

const DEMO_SMALL = process.argv.includes('--demo-small');
const STREAMS = DEMO_SMALL ? ['South'] : ['North', 'East', 'South', 'West'];
// The full seed publishes Term 1 and leaves Term 2 Midterm for the live demonstration. The small
// demo publishes Terms 1 and 2 and leaves Term 3 Midterm live instead: on the deployed site the
// latest term (Term 3) is what every page opens on, so the live exercise is the first thing shown,
// and four published checkpoints give risk trends, history and report cards something to show.
const LIVE_POINT = DEMO_SMALL ? 'T3M' : 'T2M';
const PUBLISHED_TERM_NUMBERS = DEMO_SMALL ? [1, 2] : [1];

// Subjects used by the risk model. CRE remains the gradebook subject;
// the feature builder maps it to Religious_Education.
const MODEL_SUBJECTS = [
  'Mathematics',
  'English',
  'Kiswahili',
  'Chemistry',
  'Biology',
  'Physics',
  'History',
  'Geography',
  'CRE',
];

const FIRST = [
  'Riziki', 'Kwame', 'Justin', 'Raya', 'Troben',
  'Suka', 'Josie', 'Beatrice', 'Pete', 'Amina',
  'Otieno', 'Naliaka', 'Wanjiru', 'Baraka', 'Zawadi',
  'Mueni', 'Kip', 'Halima', 'Dedan', 'Nyokabi',
];

const LAST = [
  'Juma', 'Nkurumah', 'Flitch', 'Namaari', 'Morning',
  'Zuka', 'Botto', 'Snicket', 'Garraty', 'Were',
  'Achieng', 'Mwangi', 'Kimani', 'Odhiambo', 'Chebet',
  'Mutiso', 'Barasa', 'Njeri', 'Okumu', 'Wafula',
];

// Deterministic PRNG: generated classes, rosters and marks stay consistent.
let seedState = 20260913;
const rnd = () =>
  ((seedState = (seedState * 1103515245 + 12345) % 2147483648) /
    2147483648);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// Marks and attendance use their own per-class generator, so student names
// (drawn from rnd above) stay exactly as before and each class gets its own data.
function hashString(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFor(key) {
  let a = hashString(key);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r, lo, hi) => lo + r() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const PROFILE_SLOTS = [
  { kind: 'strong', count: 4, level: [74, 88], trend: [-1, 1], attendance: [0.90, 0.98], attTrend: 0 },
  { kind: 'solid', count: 5, level: [60, 72], trend: [-1, 1], attendance: [0.85, 0.95], attTrend: 0 },
  { kind: 'borderline', count: 4, level: [47, 56], trend: [-1.5, 1.5], attendance: [0.78, 0.90], attTrend: 0 },
  { kind: 'declining', count: 3, level: [60, 66], trend: [-6, -4], attendance: [0.88, 0.94], attTrend: -0.04 },
  { kind: 'improving', count: 2, level: [38, 44], trend: [3, 5], attendance: [0.72, 0.80], attTrend: 0.03 },
  { kind: 'weak', count: 2, level: [32, 42], trend: [-1, 1], attendance: [0.65, 0.80], attTrend: 0 },
];

function classProfiles(classId, size, subjectCount) {
  const r = rngFor(`marks:${classId}`);
  const slots = PROFILE_SLOTS.flatMap((p) => Array.from({ length: p.count }, () => p));
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const classOffset = between(r, -4, 4);
  const profiles = slots.slice(0, size).map((slot) => {
    const affinity = Array.from({ length: subjectCount }, () => between(r, -5, 5));
    // Some middle and borderline students have one clearly weak subject.
    if ((slot.kind === 'solid' || slot.kind === 'borderline') && r() < 0.35) {
      affinity[Math.floor(r() * subjectCount)] -= 14;
    }
    return {
      kind: slot.kind,
      level: between(r, ...slot.level) + classOffset,
      trend: between(r, ...slot.trend),
      affinity,
      attendance: between(r, ...slot.attendance),
      attTrend: slot.attTrend,
    };
  });
  return { profiles, r };
}

const markFor = (profile, subjectIndex, checkpointIndex, r) =>
  clamp(Math.round(profile.level + profile.trend * checkpointIndex
    + profile.affinity[subjectIndex] + between(r, -5, 5)), 0, 100);

const attendanceRateFor = (profile, checkpointIndex, r) =>
  clamp(profile.attendance + profile.attTrend * checkpointIndex + between(r, -0.02, 0.02), 0.5, 1);

const items = [];
const now = new Date().toISOString();

const SCHOOL_PLACE = {
  name: 'Saint Innocent High School',
  country: 'KE',
  region: 'Nairobi',
  town: 'Kasarani',
  time_zone: 'Africa/Nairobi',
};

items.push({
  PK: pk(SCHOOL),
  SK: 'SCHOOL#PROFILE',
  entity: 'School',
  school_id: SCHOOL,
  ...SCHOOL_PLACE,
  status: 'ACTIVE',
});

// The Angaza console's registration of the same school, as createSchool would have written it.
{
  const { registration, claim } = registrationItems(SCHOOL, SCHOOL_PLACE, { byName: 'Seed data' });
  items.push(registration, claim);
}

// An Angaza staff member for the console (/angaza). Skipped if the Angaza pool is not set up yet.
const ANGAZA_STAFF = { email: 'angaza.admin@angazacenter.org', first_name: 'Angaza', last_name: 'Admin' };

items.push({
  PK: pk(SCHOOL),
  SK: 'ASSESSMENTCONFIG#SCHOOL',
  entity: 'AssessmentConfig',
  school_id: SCHOOL,
  assessment_scheme: [
    {
      key: 'MIDTERM',
      name: 'Midterm',
      order: 1,
      required: true,
      result_role: 'CHECKPOINT',
      risk_checkpoint: 'MIDTERM',
    },
    {
      key: 'ENDTERM',
      name: 'Endterm',
      order: 2,
      required: true,
      result_role: 'CHECKPOINT',
      risk_checkpoint: 'ENDTERM',
    },
  ],
  _version: 1,
  created_at: now,
  updated_at: now,
});

const BANDS = [
  { grade: 'A', min_score: 91, max_score: 100 },
  { grade: 'A-', min_score: 81, max_score: 90 },
  { grade: 'B', min_score: 71, max_score: 80 },
  { grade: 'B-', min_score: 61, max_score: 70 },
  { grade: 'C', min_score: 51, max_score: 60 },
  { grade: 'C-', min_score: 41, max_score: 50 },
  { grade: 'D', min_score: 31, max_score: 40 },
  { grade: 'D-', min_score: 21, max_score: 30 },
  { grade: 'E', min_score: 0, max_score: 20 },
];

const TERMS = [
  {
    term_id: 'term_2026_1',
    name: 'Term 1, 2026',
    academic_year: 2026,
    term_number: 1,
    start_date: '2026-01-05',
    mid_term_date: '2026-02-20',
    // Term 1 closes on the last teaching day before Good Friday (3 April), so
    // End-term publication does not fall on a public holiday.
    end_date: '2026-04-02',
    closures: [
      { from: '2026-02-26', to: '2026-03-01', label: 'Half-term break' },
    ],
  },
  {
    term_id: 'term_2026_2',
    name: 'Term 2, 2026',
    academic_year: 2026,
    term_number: 2,
    start_date: '2026-05-04',
    mid_term_date: '2026-06-19',
    end_date: '2026-08-07',
    closures: [
      { from: '2026-06-01', to: '2026-06-01', label: 'Madaraka Day' },
      { from: '2026-06-25', to: '2026-06-28', label: 'Half-term break' },
    ],
  },
  {
    term_id: 'term_2026_3',
    name: 'Term 3, 2026',
    academic_year: 2026,
    term_number: 3,
    start_date: '2026-08-31',
    mid_term_date: '2026-09-25',
    end_date: '2026-10-30',
    closures: [
      { from: '2026-10-20', to: '2026-10-20', label: 'Mashujaa Day' },
    ],
  },
];

// Use main's calendar rules; seeding does not force a current term.
const seedToday = todayIn(process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi');
for (const term of TERMS) {
  term.status = termStatus(term, seedToday);
  items.push({
    PK: pk(SCHOOL),
    SK: sk.gradeRule(term.term_id),
    entity: 'GradeRule',
    grade_rule_id: `gr_${term.term_id}`,
    school_id: SCHOOL,
    term_id: term.term_id,
    pass_mark: 50,
    missing_score_policy: 'EXCLUDE',
    bands: BANDS,
    checkpoint_weights: { OPENER: 0, MIDTERM: 30, ENDTERM: 70 },
    opener_enabled: false,
    checkpoint_weights_version: 0,
    updated_at: now,
  });

  items.push({
    PK: pk(SCHOOL),
    SK: sk.term(term.term_id),
    entity: 'Term',
    school_id: SCHOOL,
    ...term,
    _version: 1,
  });
}

// Regular teaching classes.
const classes = [];

for (const form of (DEMO_SMALL ? [4] : [2, 4])) {
  for (const stream of STREAMS) {
    const classId = `cls_f${form}${stream.toLowerCase()}`;
    classes.push({ classId, form, stream });

    items.push({
      PK: pk(SCHOOL),
      SK: sk.klass(classId),
      entity: 'Class',
      class_id: classId,
      school_id: SCHOOL,
      name: `Form ${form} ${stream}`,
      grade: `Form ${form}`,
      stream,
      year: 2026,
        _version: 1,
    });
  }
}

// Dedicated test class (also 20 students).
const TEST_CLASS = {
  classId: 'cls_test',
  name: 'Form 4 Test',
};

// Deliberately missing entries at LIVE_POINT for the live gradebook demonstration.
const T2M_DEMO_MISSING = {
  scores: [
    { student_id: 'stu_19001', subject: 'Kiswahili' },
    { student_id: 'stu_19004', subject: 'Kiswahili' },
  ],
  attendance: [
    'stu_19001',
    'stu_19003',
    'stu_19005',
  ],
};

const isMissingDemoScore = (studentId, subject) =>
  T2M_DEMO_MISSING.scores.some(
    (entry) =>
      entry.student_id === studentId &&
      entry.subject === subject
  );

const isMissingDemoAttendance = (studentId) =>
  T2M_DEMO_MISSING.attendance.includes(studentId);

items.push({
  PK: pk(SCHOOL),
  SK: sk.klass(TEST_CLASS.classId),
  entity: 'Class',
  class_id: TEST_CLASS.classId,
  school_id: SCHOOL,
  name: TEST_CLASS.name,
  grade: 'Form 4',
  stream: 'Test',
  year: 2026,
  status: 'CURRENT',
  _version: 1,
});

const allClassIds = [
  ...classes.map((c) => c.classId),
  TEST_CLASS.classId,
];

// Teachers and their existing assignments.
const TEACHERS = [
  {
    key: 'jane',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: [
      'cls_f4south',
      'cls_f4east',
      'cls_f2east',
      'cls_f2west',
      TEST_CLASS.classId,
    ].map((class_id) => ({ class_id, subject: 'Kiswahili' })),
    class_teacher_of: TEST_CLASS.classId,
  },
  {
    key: 'zama',
    first_name: 'Zama',
    last_name: 'Nile',
    email: 'zama.nile@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: allClassIds.map((class_id) => ({
      class_id,
      subject: 'CRE',
    })),
    class_teacher_of: 'cls_f4south',
  },
  {
    key: 'peter',
    first_name: 'Peter',
    last_name: 'Otieno',
    email: 'peter.otieno@saintinnocent.ac.ke',
    role: 'Teacher',
    assignments: ['cls_f4south', TEST_CLASS.classId].flatMap(
      (class_id) =>
        ['English', 'Mathematics'].map((subject) => ({
          class_id,
          subject,
        }))
    ),
    class_teacher_of: null,
  },
  {
    key: 'john',
    first_name: 'John',
    last_name: 'Man',
    email: 'john.man@saintinnocent.ac.ke',
    role: 'Admin',
    assignments: [],
    class_teacher_of: null,
  },
];

for (const teacher of TEACHERS) {
  teacher.assignments = teacher.assignments.filter(a => allClassIds.includes(a.class_id));
  if (!allClassIds.includes(teacher.class_teacher_of)) teacher.class_teacher_of = null;
}
const janeClasses = TEACHERS[0].assignments.map((a) => a.class_id);

// Existing named students.
const named = [
  {
    first: 'Riziki',
    last: 'Juma',
    adm: '17355',
    classId: 'cls_f4south',
  },
  {
    first: 'Kwame',
    last: 'Nkurumah',
    adm: '17921',
    classId: 'cls_f2east',
  },
  {
    first: 'Justin',
    last: 'Flitch',
    adm: '18141',
    classId: 'cls_f2north',
  },
];

for (let i = named.length - 1; i >= 0; i--) {
  if (!allClassIds.includes(named[i].classId)) named.splice(i, 1);
}

let adm = 17000;
const students = [];

for (const c of classes) {
  const size = 20 - named.filter((n) => n.classId === c.classId).length;

  for (let i = 0; i < size; i++) {
    students.push({
      student_id: `stu_${++adm}`,
      admission_no: String(adm),
      first_name: pick(FIRST),
      last_name: pick(LAST),
      class_id: c.classId,
    });
  }
}

for (const n of named) {
  students.push({
    student_id: `stu_${n.adm}`,
    admission_no: n.adm,
    first_name: n.first,
    last_name: n.last,
    class_id: n.classId,
  });
}

const TEST_STUDENTS = [
  ['Achieng', 'Otieno'],
  ['Brian', 'Kamau'],
  ['Cynthia', 'Wanjiku'],
  ['David', 'Mutua'],
  ['Esther', 'Chebet'],
  ...Array.from({ length: 15 }, (_, i) => [FIRST[i], LAST[(i + 5) % LAST.length]]),
];

TEST_STUDENTS.forEach(([first_name, last_name], i) => {
  const admission_no = String(19001 + i);

  students.push({
    student_id: `stu_${admission_no}`,
    admission_no,
    first_name,
    last_name,
    class_id: TEST_CLASS.classId,
  });
});

// Small demo only: a few students who left in an earlier year, so the Past students page has
// content. They go straight into the records, not into `students`, so no marks, attendance or
// predictions are generated for them; every roster reads active students only.
const PAST_STUDENTS = DEMO_SMALL ? [
  ['16001', 'Grace', 'Wairimu', 'GRADUATED'], ['16002', 'Kevin', 'Omondi', 'GRADUATED'],
  ['16003', 'Faith', 'Njeri', 'GRADUATED'], ['16004', 'Samuel', 'Kiprop', 'GRADUATED'],
  ['16005', 'Mercy', 'Akinyi', 'LEFT'], ['16006', 'Dennis', 'Mwangi', 'LEFT'],
] : [];
for (const [admission_no, first_name, last_name, kind] of PAST_STUDENTS) {
  const left = kind === 'LEFT';
  items.push({
    PK: pk(SCHOOL), SK: sk.student(`stu_${admission_no}`), entity: 'Student', school_id: SCHOOL, _version: 2,
    student_id: `stu_${admission_no}`, admission_no, first_name, last_name, class_id: 'cls_f4south',
    ...(left
      ? { status: 'INACTIVE', left_year: 2025, departure_kind: 'LEFT', deactivation_reason: 'Transferred to another school', deactivation_date: '2025-11-28' }
      : { status: 'GRADUATED', graduation_year: 2025 }),
  });
  items.push({ PK: pk(SCHOOL), SK: sk.admissionNo(admission_no), entity: 'AdmissionNo', admission_no, student_id: `stu_${admission_no}` });
}

/* Create the student and admission-number records. */
for (const student of students) {
  items.push({
    PK: pk(SCHOOL),
    SK: sk.student(student.student_id),
    entity: 'Student',
    school_id: SCHOOL,
    status: 'ACTIVE',
    _version: 1,
    ...student,
  });

  items.push({
    PK: pk(SCHOOL),
    SK: sk.admissionNo(student.admission_no),
    entity: 'AdmissionNo',
    admission_no: student.admission_no,
    student_id: student.student_id,
  });
}

/**
 * Creates one assessment for each model subject at each requested checkpoint,
 * then adds scores and calendar-based attendance for every class.
 *
 * Publication and model inference follow after these records are persisted.
 */
function seedAssessmentsAndScores(enteredBy) {
  const checkpoints = [
    {
      point: 'T1M',
      term_id: 'term_2026_1',
      assessment_type: 'MIDTERM',
      title: 'Term 1 Midterm',
    },
    {
      point: 'T1F',
      term_id: 'term_2026_1',
      assessment_type: 'ENDTERM',
      title: 'Term 1 Endterm',
    },
    {
      point: 'T2M',
      term_id: 'term_2026_2',
      assessment_type: 'MIDTERM',
      title: 'Term 2 Midterm',
    },
    // {
    //   point: 'T2F',
    //   term_id: 'term_2026_2',
    //   assessment_type: 'ENDTERM',
    //   title: 'Term 2 Endterm',
    // },
    // {
    //   point: 'T3M',
    //   term_id: 'term_2026_3',
    //   assessment_type: 'MIDTERM',
    //   title: 'Term 3 Midterm',
    // },
  ];
  if (DEMO_SMALL) {
    checkpoints.push(
      { point: 'T2F', term_id: 'term_2026_2', assessment_type: 'ENDTERM', title: 'Term 2 Endterm' },
      { point: 'T3M', term_id: 'term_2026_3', assessment_type: 'MIDTERM', title: 'Term 3 Midterm' },
    );
  }

  let assessmentCount = 0;
  let scoreCount = 0;

  for (const classId of allClassIds) {
  const roster = students.filter((s) => s.class_id === classId);
  const { profiles, r } = classProfiles(classId, roster.length, MODEL_SUBJECTS.length);
  checkpoints.forEach((checkpoint, checkpointIndex) => {
    const term = TERMS.find((t) => t.term_id === checkpoint.term_id);
    const period = attendancePeriods(term).find((p) => p.period === checkpoint.assessment_type);
    checkpoint.due_date = period.to;
    const createdAt = `${period.from}T06:00:00.000Z`;
    const enteredAt = `${period.to}T09:00:00.000Z`;
    roster.forEach((student, i) => {
      // Leave selected live-point attendance records empty in the test class.
      if (
        checkpoint.point === LIVE_POINT &&
        classId === TEST_CLASS.classId &&
        isMissingDemoAttendance(student.student_id)
      ) {
        return;
      }

      items.push({
        PK: pk(SCHOOL),
        SK: sk.attendance(term.term_id, period.period, student.student_id),
        GSI2PK: gsi2.pk(SCHOOL, student.student_id),
        GSI2SK: gsi2.attendance(2026, term.term_number, period.period),
        entity: 'Attendance',
        school_id: SCHOOL,
        student_id: student.student_id,
        class_id: classId,
        term_id: term.term_id,
        academic_year: 2026,
        term_number: term.term_number,
        period: period.period,
        days_attended: Math.round(
          period.school_days * attendanceRateFor(profiles[i], checkpointIndex, r)
        ),
        days_excused: 0,
        school_days_when_entered: period.school_days,
        recorded_by: enteredBy,
        recorded_by_name: 'John Man',
        recorded_at: enteredAt,
        _version: 1,
        _lastChangedAt: Date.parse(enteredAt),
      });
    });
    MODEL_SUBJECTS.forEach((subject, subjectIndex) => {
      const assessmentId =
        `seed_${classId}_${checkpoint.point}_${subject.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const assessment = {
        PK: pk(SCHOOL),
        SK: sk.assessment(assessmentId),
        GSI1PK: gsi1.pk(SCHOOL, classId),
        GSI1SK: gsi1.assessment(checkpoint.term_id, assessmentId),
        entity: 'Assessment',
        assessment_id: assessmentId,
        school_id: SCHOOL,
        class_id: classId,
        term_id: checkpoint.term_id,
        subject,
        title: `${subject} - ${checkpoint.title}`,
        assessment_type: checkpoint.assessment_type,
        paper_no: 1,
        weight: 100,
        max_score: 100,
        due_date: checkpoint.due_date,
        score_count: roster.length - (
          checkpoint.point === LIVE_POINT && classId === TEST_CLASS.classId
            ? T2M_DEMO_MISSING.scores.filter(
                (entry) =>
                  entry.subject === subject &&
                  roster.some((student) => student.student_id === entry.student_id)
              ).length
            : 0
        ),
        created_at: createdAt,
        updated_at: enteredAt,
        created_by: enteredBy,
        updated_by: enteredBy,
        _version: 1,
        _lastChangedAt: Date.parse(enteredAt),
        _deleted: false,
      };

      items.push(assessment);

      // Reserve the paper number so it remains consistent with the
      // assessment repository's uniqueness convention.
      items.push({
        PK: pk(SCHOOL),
        SK: sk.paperSlot(
          checkpoint.term_id,
          classId,
          subject,
          checkpoint.assessment_type,
          1
        ),
        entity: 'PaperSlot',
        school_id: SCHOOL,
        class_id: classId,
        term_id: checkpoint.term_id,
        subject,
        assessment_type: checkpoint.assessment_type,
        paper_no: 1,
        assessment_id: assessmentId,
      });

      assessmentCount++;

      roster.forEach((student, studentIndex) => {
        const studentId = student.student_id;

        // Leave selected T2M marks empty in the test class.
        if (
          checkpoint.point === LIVE_POINT &&
          classId === TEST_CLASS.classId &&
          isMissingDemoScore(studentId, subject)
        ) {
          return;
        }

        const rawScore = markFor(profiles[studentIndex], subjectIndex, checkpointIndex, r);
        const normalizedScore = Math.round(rawScore * 100) / 100;
        const timestamp = Date.parse(enteredAt);

        items.push({
          PK: pk(SCHOOL),
          SK: sk.score(assessmentId, studentId),
          GSI2PK: gsi2.pk(SCHOOL, studentId),
          GSI2SK: gsi2.score(checkpoint.term_id, assessmentId),
          GSI3PK: gsi3.pk(SCHOOL, classId),
          GSI3SK: gsi3.sk(timestamp),
          entity: 'Score',
          score_id: `${assessmentId}#${studentId}`,
          school_id: SCHOOL,
          assessment_id: assessmentId,
          student_id: studentId,
          class_id: classId,
          term_id: checkpoint.term_id,
          raw_score: rawScore,
          normalized_score: normalizedScore,
          mark_status: 'SCORED',
          status: 'ACTIVE',
          entered_by: enteredBy,
          entered_at: enteredAt,
          updated_at: enteredAt,
          _version: 1,
          _lastChangedAt: timestamp,
          _deleted: false,
        });

        scoreCount++;
      });
    });
  });

  }
  return { assessmentCount, scoreCount };
}

/** Create or find a seeded teacher account. */
async function account(teacher) {
  if (!process.env.COGNITO_USER_POOL_ID) {
    throw new Error(
      'COGNITO_USER_POOL_ID is not set. Run `npm run aws:setup` first.'
    );
  }

  const acct = await identity.createAccount({
    email: teacher.email,
    name: `${teacher.first_name} ${teacher.last_name}`,
    schoolId: SCHOOL,
  });

  await identity.setRole(acct.sub, teacher.role);
  await identity.setPermanentPassword(acct.sub, DEV_PASSWORD);

  return acct.sub;
}

async function batchWriteAll(allItems) {
  const totalBatches = Math.ceil(allItems.length / 25);
  let completedBatches = 0;

  for (let i = 0; i < allItems.length; i += 25) {
    let pending = allItems.slice(i, i + 25).map((Item) => ({
      PutRequest: { Item },
    }));

    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) {
        throw new Error('DynamoDB kept throttling the seed records.');
      }

      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 50 * 2 ** attempt)
        );
      }

      const result = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [TABLE]: pending },
        })
      );

      pending = result.UnprocessedItems?.[TABLE] || [];
    }
    
    completedBatches++;

    if (completedBatches % 20 === 0 || completedBatches === totalBatches) {
      progress(`Database writes: ${completedBatches}/${totalBatches} batches completed.`);
    }
  }
}

async function run() {
  // This generator resets data/passwords and must never target hosted services.
  for (const name of ['DDB_ENDPOINT', 'COGNITO_ENDPOINT', 'LAMBDA_ENDPOINT', 'S3_ENDPOINT', 'EVENTS_ENDPOINT', 'SFN_ENDPOINT']) {
    const endpoint = process.env[name];
    if (!endpoint || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
      throw new Error(`Local seed requires loopback ${name}. Use scripts/demo/data.mjs for AWS.`);
    }
  }
  progress('Starting database setup...');
  await ensureTable({ reset: process.argv.includes('--reset') });
  progress('Database setup complete.');

  const subs = {};
  for (const teacher of TEACHERS) {
    progress(`Creating account: ${teacher.email}`);
    subs[teacher.key] = await account(teacher);
    progress('Teacher accounts created.');
  }

  for (const teacher of TEACHERS) {
    const { key, ...profile } = teacher;

    items.push({
      PK: pk(SCHOOL),
      SK: sk.teacher(subs[key]),
      entity: 'Teacher',
      teacher_id: subs[key],
      school_id: SCHOOL,
      status: 'ACTIVE',
      _version: 1,
      ...profile,
    });

    if (teacher.class_teacher_of) {
      const klass = items.find(
        (item) =>
          item.entity === 'Class' &&
          item.class_id === teacher.class_teacher_of
      );

      if (klass) klass.class_teacher_id = subs[key];
    }
  }

  progress('Generating assessments, scores and attendance...');
  const seeded = seedAssessmentsAndScores(subs.john);
  progress(`Generated ${items.length} records in memory.`);

  progress(`Writing ${items.length} records to DynamoDB...`);
  let angaza = null;
  if (process.env.PLATFORM_COGNITO_USER_POOL_ID) {
    const acct = await platformIdentity.createStaffAccount({
      email: ANGAZA_STAFF.email,
      name: `${ANGAZA_STAFF.first_name} ${ANGAZA_STAFF.last_name}`,
    });
    await platformIdentity.setPermanentPassword(acct.sub, DEV_PASSWORD);
    await putStaff({ staff_id: acct.sub, ...ANGAZA_STAFF });
    angaza = ANGAZA_STAFF.email;
  }

  await batchWriteAll(items);
  progress('Initial database write complete.');
  const staff = TEACHERS.map((t) => ({
    sub: subs[t.key],
    name: `${t.first_name} ${t.last_name}`,
    role: t.role,
    assignments: t.assignments,
    class_teacher_of: t.class_teacher_of,
  }));
  progress('Starting historical result publication and risk predictions...');
  const riskSummary = await seedPublishedHistory({
    schoolId: SCHOOL, terms: TERMS, classIds: allClassIds, items, staff,
    subjects: MODEL_SUBJECTS, actor: { sub: subs.john, name: 'John Man' },
    publishedTermNumbers: PUBLISHED_TERM_NUMBERS,
  });
  progress('Historical publication and risk predictions complete.');

  console.log(`Seeded ${items.length} items into ${TABLE}`);
  console.log(`  school        ${SCHOOL}`);

  console.log(`  classes       ${classes.length + 1}`);
  console.log(`  students      ${students.length}`);
  console.log(`  test class    ${TEST_CLASS.name} (${TEST_CLASS.classId})`);
  console.log(`  assessments   ${seeded.assessmentCount}`);
  console.log(`  score records ${seeded.scoreCount}`);
  console.log(`  attendance    ${items.filter((i) => i.entity === 'Attendance').length}`);
  console.log(`  publications  ${allClassIds.length * 2 * PUBLISHED_TERM_NUMBERS.length} (with model predictions and SHAP)`);
  if (PAST_STUDENTS.length) console.log(`  past students ${PAST_STUDENTS.length}`);
  console.log(`  flagged       ${riskSummary.flagged} (counterfactuals: ${JSON.stringify(riskSummary.counterfactuals)})`);
  console.log(`  interventions ${riskSummary.interventions}`);

  console.log(`\nSign-in accounts (password ${DEV_PASSWORD}):`);
  for (const teacher of TEACHERS) {
    const classTeacher = teacher.class_teacher_of
      ? `, class teacher of ${teacher.class_teacher_of}`
      : '';
    const teaches =
      [...new Set(teacher.assignments.map((a) => a.subject))].join(', ') ||
      'all classes';

    console.log(
      `  ${teacher.role.padEnd(8)} ${teacher.email.padEnd(36)} ${teaches}${classTeacher}`
    );
  }
  console.log(angaza
    ? `  Angaza   ${angaza.padEnd(36)} the Angaza console at /angaza`
    : '\n  No Angaza console account: PLATFORM_COGNITO_USER_POOL_ID is not set. Run `npm run aws:setup`, then seed again.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { SCHOOL, TERM, TERMS, janeClasses, classes, students };
