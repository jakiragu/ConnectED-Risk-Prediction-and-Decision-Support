import 'dotenv/config';

import { pathToFileURL } from 'node:url';
import * as risk from '../backend/library/riskRepo.js';
import * as platform from '../backend/library/platformRepo.js';
import * as interventions from '../backend/library/interventionRepo.js';
import { groupOf, parseColumn } from '../backend/library/explanations.js';
import { linkFor } from '../backend/library/riskProfile.js';

const SCHOOL_ID = 'sch_saint_innocent';
const ACADEMIC_YEAR = 2026;

const SUBJECTS = [
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

const METHODS = {
  Mathematics: {
    method: 'Daily vector practice questions',
    frequency: 'DAILY',
  },
  English: {
    method: 'Weekly composition writing',
    frequency: 'WEEKLY',
  },
  Kiswahili: {
    method: 'Weekly insha writing',
    frequency: 'WEEKLY',
  },
  Chemistry: {
    method: 'Daily chemical equation practice',
    frequency: 'DAILY',
  },
  Biology: {
    method: 'Weekly diagram labelling exercises',
    frequency: 'WEEKLY',
  },
  Physics: {
    method: 'Daily numerical problem solving',
    frequency: 'DAILY',
  },
  History: {
    method: 'Weekly structured essay practice',
    frequency: 'WEEKLY',
  },
  Geography: {
    method: 'Weekly map interpretation exercises',
    frequency: 'WEEKLY',
  },
  CRE: {
    method: 'Weekly structured response questions',
    frequency: 'WEEKLY',
  },
  Attendance: {
    method: 'Daily attendance follow-up',
    frequency: 'DAILY',
  },
};

const STOP_RATES = {
  T1M: 0.70,
  T1F: 0.10,
};

// Date-only arithmetic in UTC avoids local timezone differences.
function addDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function assessmentDate(point, terms) {
  const term = terms.find(
    (t) =>
      Number(t.academic_year) === ACADEMIC_YEAR &&
      Number(t.term_number) === 1
  );

  if (!term) {
    throw new Error('Term 1, 2026 was not found in the database.');
  }

  const date = point === 'T1M' ? term.mid_term_date : term.end_date;

  if (!date) {
    throw new Error(`No assessment date found for ${point}.`);
  }

  return date;
}

function hasUsableFeature(prediction, factor) {
  return Object.entries(prediction.features || {}).some(
    ([column, value]) =>
      groupOf(column) === factor &&
      value !== null &&
      value !== undefined &&
      Number.isFinite(Number(value))
  );
}

/**
 * Select every subject/attendance group whose aggregated SHAP effect
 * raises risk. Groups with entirely missing feature values are excluded.
 */
function shapTargets(prediction) {
  const totals = new Map();

  for (const [column, rawEffect] of Object.entries(
    prediction.shap_values || {}
  )) {
    const effect = Number(rawEffect);
    if (!Number.isFinite(effect)) continue;

    const factor = groupOf(column);

    if (factor !== 'Attendance' && !SUBJECTS.includes(factor)) continue;

    totals.set(factor, (totals.get(factor) || 0) + effect);
  }

  return [...totals.entries()]
    .filter(
      ([factor, effect]) =>
        effect > 0 && hasUsableFeature(prediction, factor)
    )
    .sort((a, b) => b[1] - a[1])
    .map(([factor]) => factor);
}

/**
 * Fallback: choose the subject with the lowest available score at the
 * current prediction point. If no subject score is available, use
 * Attendance if an attendance feature exists.
 *
 * Seed history already checks that the required score and attendance
 * inputs are present, so failure here indicates an unexpected data issue.
 */
function fallbackTarget(prediction) {
  const currentPoint = prediction.prediction_point;

  const currentScores = Object.entries(prediction.features || {})
    .filter(([column, value]) => {
      const parsed = parseColumn(column);
      return (
        parsed.point === currentPoint &&
        parsed.kind === 'score' &&
        SUBJECTS.includes(parsed.group) &&
        value !== null &&
        value !== undefined &&
        Number.isFinite(Number(value))
      );
    })
    .map(([column, value]) => ({
      factor: groupOf(column),
      value: Number(value),
    }));

  if (currentScores.length) {
    currentScores.sort((a, b) => a.value - b.value);
    return currentScores[0].factor;
  }

  if (hasUsableFeature(prediction, 'Attendance')) {
    return 'Attendance';
  }

  // Last resort: use the lowest available subject score from the
  // student's stored feature history.
  const historicalScores = Object.entries(prediction.features || {})
    .filter(([column, value]) => {
      const parsed = parseColumn(column);
      return (
        parsed.kind === 'score' &&
        SUBJECTS.includes(parsed.group) &&
        value !== null &&
        value !== undefined &&
        Number.isFinite(Number(value))
      );
    })
    .map(([column, value]) => ({
      factor: groupOf(column),
      value: Number(value),
    }));

  if (historicalScores.length) {
    historicalScores.sort((a, b) => a.value - b.value);
    return historicalScores[0].factor;
  }

  throw new Error(
    `No actionable feature is available for ${prediction.student_id} ` +
    `at ${currentPoint}. Cannot seed an intervention.`
  );
}

function targetsFor(prediction) {
  const targets = shapTargets(prediction);

  // Every at-risk student must receive at least one intervention.
  return targets.length ? targets : [fallbackTarget(prediction)];
}

/** A stable 0-99 number for a key, so reseeding gives every intervention the same creator. */
function bucket(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 100;
}

/**
 * Who logged it. Previously every subject intervention was attributed to that
 * subject's teacher, so a subject teacher appeared to have logged all of them.
 * In practice the class teacher logs some subject interventions too, so about
 * 40% go to the class teacher; Attendance stays with the class teacher.
 */
function actorFor(staff, classId, factor, admin, studentId = '') {
  const subjectTeacher =
    factor === 'Attendance'
      ? null
      : staff.find((teacher) =>
          (teacher.assignments || []).some(
            (assignment) =>
              assignment.class_id === classId &&
              assignment.subject === factor
          )
        );

  const classTeacher = staff.find(
    (teacher) => teacher.class_teacher_of === classId
  );

  const byClassTeacher = classTeacher && subjectTeacher && bucket(`${studentId}:${factor}`) < 40;
  const chosen = (byClassTeacher ? classTeacher : subjectTeacher) || classTeacher || admin;

  return {
    sub: chosen.sub,
    name: chosen.name,
  };
}

function interventionId(prediction, factor) {
  const safeFactor = factor.replace(/[^a-zA-Z0-9]/g, '_');

  return [
    'seed',
    prediction.prediction_point,
    prediction.student_id,
    safeFactor,
  ].join('_');
}

/**
 * Build all intervention records first, then assign stopped statuses
 * deterministically per prediction point.
 */
function buildPlans(predictions, terms, staff, admin) {
  const plans = [];

  for (const prediction of predictions) {
    if (!prediction.at_risk) continue;

    const point = prediction.prediction_point;

    if (!Object.hasOwn(STOP_RATES, point)) continue;

    if (!prediction.class_id) {
      throw new Error(
        `Missing class_id for ${prediction.student_id} at ${point}.`
      );
    }

    const date = assessmentDate(point, terms);
    const startedOn = addDays(date, 10);
    const stoppedOn = addDays(startedOn, 21);

    for (const factor of targetsFor(prediction)) {
      const template = METHODS[factor];

      if (!template) {
        throw new Error(`No intervention method configured for ${factor}.`);
      }

      plans.push({
        point,
        student_id: prediction.student_id,
        intervention_id: interventionId(prediction, factor),
        class_id: prediction.class_id,
        factor,
        method: template.method,
        frequency: template.frequency,
        started_on: startedOn,
        stopped_on: stoppedOn,
        expected_outcome: `Improve ${factor} performance or engagement.`,
        notes:
          `Seeded from the ${point} SHAP explanation. ` +
          'This is a suggested support activity, not evidence of causal effectiveness.',
        linked: linkFor(prediction, factor),
        actor: actorFor(staff, prediction.class_id, factor, admin, prediction.student_id),
      });
    }
  }

  for (const point of Object.keys(STOP_RATES)) {
    const pointPlans = plans
      .filter((plan) => plan.point === point)
      .sort((a, b) =>
        a.intervention_id.localeCompare(b.intervention_id)
      );

    const stoppedCount = Math.round(
      pointPlans.length * STOP_RATES[point]
    );

    pointPlans.forEach((plan, index) => {
      const stopped = index < stoppedCount;

      plan.status = stopped ? 'STOPPED' : 'ONGOING';
      if (!stopped) plan.stopped_on = null;
    });
  }

  return plans;
}

/**
 * Shared implementation used by both seed-history.js and the standalone
 * script. It is safe to rerun because intervention IDs are deterministic
 * and interventionRepo.create() prevents duplicate IDs.
 */
export async function seedInterventions({
  schoolId,
  predictions,
  terms,
  staff,
  admin,
}) {
  if (!schoolId || !Array.isArray(predictions) || !Array.isArray(terms)) {
    throw new Error('seedInterventions received incomplete input.');
  }

  if (!admin?.sub) {
    throw new Error('An admin actor is required for intervention seeding.');
  }

  const plans = buildPlans(predictions, terms, staff, admin);

  const summary = {
    flaggedStudents: new Set(
      predictions
        .filter((p) => p.at_risk && STOP_RATES[p.prediction_point] !== undefined)
        .map((p) => `${p.prediction_point}:${p.student_id}`)
    ).size,
    planned: plans.length,
    created: 0,
    existing: 0,
    byPoint: {},
  };

  for (const plan of plans) {
    const {
      point,
      actor,
      ...value
    } = plan;

    const result = await interventions.create(schoolId, value, actor);

    if (result.created) {
      summary.created += 1;
    } else {
      summary.existing += 1;
    }

    summary.byPoint[point] ??= { created: 0, existing: 0 };

    if (result.created) {
      summary.byPoint[point].created += 1;
    } else {
      summary.byPoint[point].existing += 1;
    }
  }

  console.log('[interventions] Seeding summary:', summary);
  return summary;
}

/**
 * Standalone execution: reads existing predictions and adds interventions.
 * It deliberately does not reset, create, or reseed the database.
 */
export async function run() {
  const [terms, teachers, t1m, t1f] = await Promise.all([
    platform.listTerms(SCHOOL_ID),
    platform.listTeachers(SCHOOL_ID),
    risk.listForPoint(SCHOOL_ID, ACADEMIC_YEAR, 'T1M'),
    risk.listForPoint(SCHOOL_ID, ACADEMIC_YEAR, 'T1F'),
  ]);

  const staff = teachers.map((teacher) => ({
    sub: teacher.teacher_id,
    name: `${teacher.first_name} ${teacher.last_name}`,
    role: teacher.role,
    assignments: teacher.assignments || [],
    class_teacher_of: teacher.class_teacher_of || null,
  }));

  const adminTeacher = staff.find(
    (teacher) => String(teacher.role).toLowerCase() === 'admin'
  );

  if (!adminTeacher) {
    throw new Error('No seeded admin teacher was found.');
  }

  const predictions = [...t1m, ...t1f];

  if (!predictions.length) {
    throw new Error(
      'No T1M or T1F predictions were found. Run the previous database seed first.'
    );
  }

  return seedInterventions({
    schoolId: SCHOOL_ID,
    predictions,
    terms,
    staff,
    admin: {
      sub: adminTeacher.sub,
      name: adminTeacher.name,
    },
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    console.error('[interventions] Seeding failed:', error);
    process.exitCode = 1;
  });
}
