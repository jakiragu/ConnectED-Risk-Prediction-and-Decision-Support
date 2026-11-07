import { assertTenant, assertClassTeacherOrAdmin, assertGradebookRole } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { todayIn } from '../../library/calendar.js';
import { FEATURE_CONTRACT, POINT_NAMES, MODEL_SUBJECTS, SUBJECT_TO_MODEL } from '../../library/features.js';
import { validation, notFound } from '../../library/errors.js';
import * as features from '../../library/featureStore.js';
import * as platform from '../../library/platformRepo.js';
import { mapLimit } from '../../library/concurrency.js';

/**
 * The risk model's inputs, as the gradebook would hand them to the model.
 * Read-only. Model inputs are student data, so only administrators and the
 * student's class teacher may see them.
 */
export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  assertTenant(actor, args.school_id);

  switch (event.info.fieldName) {
    case 'getFeatureContract':
      return getFeatureContract(actor);
    case 'getFeatureReadiness':
      return getFeatureReadiness(actor, args);
    case 'getStudentFeatures':
      return getStudentFeatures(actor, args);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const zone = () => process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

function requirePoint(point) {
  if (!POINT_NAMES.includes(point)) throw validation(`Prediction point must be one of ${POINT_NAMES.join(', ')}`, 'prediction_point');
  return point;
}

async function yearFor(schoolId, point, academicYear) {
  const year = academicYear ?? (await features.defaultYear(schoolId, point, todayIn(zone())));
  if (!year) throw validation('No school year has reached this prediction point yet', 'academic_year');
  return Number(year);
}

function getFeatureContract(actor) {
  assertGradebookRole(actor);
  return {
    points: POINT_NAMES.map((point) => ({ point, columns: FEATURE_CONTRACT[point] })),
    model_subjects: MODEL_SUBJECTS,
    subject_map: Object.entries(SUBJECT_TO_MODEL).map(([subject, model]) => ({ subject, model_subject: model })),
  };
}

const counts = (row) => ({
  missing_scores: row.missing.scores.length,
  missing_attendance: row.missing.attendance.length,
  notes: row.missing.notes,
  complete: row.missing.scores.length === 0 && row.missing.attendance.length === 0,
});

async function getFeatureReadiness(actor, { school_id, class_id, prediction_point, academic_year }) {
  const klass = await platform.klass(school_id, class_id);
  if (!klass) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, class_id);
  const point = requirePoint(prediction_point);
  const year = await yearFor(school_id, point, academic_year);
  const terms = await features.termsOfYear(school_id, year);
  const roster = await platform.roster(school_id, class_id);

  // Each student's features are several reads; eight students at a time instead of one.
  const students = await mapLimit(roster, 8, async (s) => {
    const row = await features.buildForStudent(school_id, s.student_id, point, year, terms);
    return {
      student_id: s.student_id,
      admission_no: s.admission_no,
      first_name: s.first_name,
      last_name: s.last_name,
      ...counts(row),
    };
  });
  return {
    class_id,
    class_name: klass.name,
    academic_year: year,
    prediction_point: point,
    columns: FEATURE_CONTRACT[point].length,
    complete: students.filter((s) => s.complete).length,
    students,
  };
}

async function getStudentFeatures(actor, { school_id, student_id, prediction_point, academic_year }) {
  const student = await platform.student(school_id, student_id);
  if (!student) throw notFound('Student not found');
  assertClassTeacherOrAdmin(actor, student.class_id);
  const point = requirePoint(prediction_point);
  const year = await yearFor(school_id, point, academic_year);
  const row = await features.buildForStudent(school_id, student_id, point, year);
  return {
    student_id,
    academic_year: year,
    prediction_point: point,
    values: row.columns.map((name) => ({ name, value: row.values[name] })),
    ...counts(row),
  };
}