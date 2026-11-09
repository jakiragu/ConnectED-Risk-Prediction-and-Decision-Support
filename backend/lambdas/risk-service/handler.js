import { assertTenant, assertAdmin, assertClassTeacherOrAdmin, isAdmin, isClassTeacherOf } from '../../library/authz.js';
import { selectStudentTarget } from './targetChoice.js';
import { predictionTargets } from '../../library/targetChoice.js';
import { resolveActor } from '../../library/actor.js';
import { todayIn } from '../../library/calendar.js';
import { POINT_NAMES, pointFor } from '../../library/features.js';
import { columnLabel, displayGroup, explain, importanceOver, topFactors } from '../../library/explanations.js';
import { bestTarget } from '../../library/targets.js';
import { forbidden, validation, notFound } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import { invoke, predictionFunction, scorerFunction } from '../../library/invoke.js';
import * as features from '../../library/featureStore.js';
import * as platform from '../../library/platformRepo.js';
import * as results from '../../library/resultsRepo.js';
import * as risk from '../../library/riskRepo.js';
import { getRiskDashboard, getSchoolRiskOverview, getStudentRiskProfile } from './decision.js';

/**
 * Risk predictions, their SHAP explanations, their counterfactual targets for
 * the next checkpoint and the model behind them, and
 * re-running a class's predictions (for example after the model is replaced).
 * Predictions are decision-support signals for administrators and the
 * student's class teacher; they never decide anything on their own.
 */
export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id);

  switch (event.info.fieldName) {
    case 'listRiskPredictions':
      return listRiskPredictions(actor, args);
    case 'getRiskExplanation':
      return getRiskExplanation(actor, args);
    case 'getRiskImportance':
      return getRiskImportance(actor, args);
    case 'getRiskRun':
      return getRiskRun(actor, args);
    case 'getRiskModel':
      return getRiskModel(actor);
    case 'getStudentRiskProfile':
      return getStudentRiskProfile(actor, args);
    case 'getRiskDashboard':
      return getRiskDashboard(actor, args).then(withTrends);
    case 'getSchoolRiskOverview':
      return getSchoolRiskOverview(actor, args);
    case 'selectStudentTarget':
      return selectStudentTarget(actor, input);
    case 'runRiskPredictions':
      return runRiskPredictions(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const zone = () => process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

// The scorer's description of the published model changes only when a model is
// published, but asking for it starts the Python scorer (often a cold start), so
// it is kept for a few minutes in this warm Lambda instead of fetched every view.
const DESCRIBE_TTL_MS = 5 * 60 * 1000;
let described = null;
async function describeModel() {
  if (described && Date.now() - described.at < DESCRIBE_TTL_MS) return described.value;
  const value = await invoke(scorerFunction(), { action: 'describe' });
  described = { at: Date.now(), value };
  return value;
}

function requirePoint(point) {
  if (!POINT_NAMES.includes(point)) throw validation(`Prediction point must be one of ${POINT_NAMES.join(', ')}`, 'prediction_point');
  return point;
}

const yearFor = async (schoolId, point, academicYear) =>
  academicYear ?? (await features.defaultYear(schoolId, point, todayIn(zone())));

const runView = (r) => r && {
  run_id: r.run_id,
  class_id: r.class_id,
  term_id: r.term_id,
  checkpoint: r.checkpoint,
  prediction_point: r.prediction_point,
  academic_year: r.academic_year ?? null,
  status: r.status,
  trigger: r.trigger ?? null,
  model_version: r.model_version ?? null,
  threshold: r.threshold ?? null,
  students: r.students ?? null,
  at_risk: r.at_risk ?? null,
  with_targets: r.with_targets ?? null,
  targets_found: r.targets_found ?? null,
  targets_fallback: r.targets_fallback ?? null,
  targets_maintain: r.targets_maintain ?? null,
  targets_failed: r.targets_failed ?? null,
  error: r.error ?? null,
  started_at: r.started_at ?? null,
  finished_at: r.finished_at ?? null,
};

const predictionView = (p, student) => ({
  student_id: p.student_id,
  admission_no: student?.admission_no ?? '',
  first_name: student?.first_name ?? '',
  last_name: student?.last_name ?? '',
  class_id: p.class_id,
  academic_year: p.academic_year,
  prediction_point: p.prediction_point,
  probability: p.probability,
  at_risk: p.at_risk,
  threshold: p.threshold,
  model_version: p.model_version,
  missing_scores: p.missing_scores,
  missing_attendance: p.missing_attendance,
  run_id: p.run_id,
  predicted_at: p.predicted_at,
  explained: Boolean(p.shap_values),
  top_factors: topFactors(p, 3),
  targets_status: p.counterfactuals?.status ?? null,
  best_target: bestTarget(p.counterfactuals, p.target_choice),
});

/**
 * One class's predictions, or (administrators, no class_id) every class's in one
 * read: the Risk prediction page's "All classes" view used to ask once per class,
 * and each of those requests read the whole school's predictions.
 */
async function listRiskPredictions(actor, { school_id, class_id, prediction_point, academic_year }) {
  if (class_id) {
    if (!(await platform.klass(school_id, class_id))) throw notFound('Class not found');
    assertClassTeacherOrAdmin(actor, class_id);
  } else {
    assertAdmin(actor);
  }
  const point = requirePoint(prediction_point);
  const year = await yearFor(school_id, point, academic_year);
  if (!year) return [];
  const items = class_id ? await risk.listForClass(school_id, year, point, class_id) : await risk.listForPoint(school_id, year, point);
  const students = await platform.studentsByIds(school_id, items.map((p) => p.student_id));
  return items
    .map((p) => predictionView(p, students.get(p.student_id)))
    .sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
}

/**
 * One student's prediction with its full explanation (every subject's and
 * attendance's push on the estimated risk, and the individual inputs under
 * each) and, when the model flags the student, its counterfactual targets for
 * the next checkpoint.
 * Administrators, and the class teacher of the class the prediction was made in
 * or of the student's current class.
 */
async function getRiskExplanation(actor, { school_id, student_id, prediction_point, academic_year }) {
  const point = requirePoint(prediction_point);
  const student = await platform.student(school_id, student_id);
  if (!student) throw notFound('Student not found');
  const year = await yearFor(school_id, point, academic_year);
  const p = year ? await risk.getPrediction(school_id, year, point, student_id) : null;
  if (!p) throw notFound('There is no prediction for this student at this point yet');
  if (!isAdmin(actor) && !isClassTeacherOf(actor, p.class_id) && !isClassTeacherOf(actor, student.class_id)) {
    throw forbidden('Only the class teacher or an administrator can see this explanation');
  }
  const e = explain(p);
  return {
    prediction: predictionView(p, student),
    explainer: p.explainer ?? null,
    explained: Boolean(e),
    base_probability: e?.base_probability ?? null,
    factors: e?.factors ?? [],
    targets: predictionTargets(p),
  };
}

/**
 * What drives the model at a prediction point:
 *   model     mean |SHAP| on the held-out students the model was evaluated on (from its package)
 *   observed  mean |SHAP| over the predictions made here, for a class or the whole school
 * A class teacher sees their own class; administrators any class or the school.
 */
async function getRiskImportance(actor, { school_id, prediction_point, academic_year, class_id }) {
  const point = requirePoint(prediction_point);
  if (class_id) {
    if (!(await platform.klass(school_id, class_id))) throw notFound('Class not found');
    assertClassTeacherOrAdmin(actor, class_id);
  } else {
    assertAdmin(actor);
  }
  const year = await yearFor(school_id, point, academic_year);

  let model = null;
  let modelVersion = null;
  try {
    const m = await describeModel();
    modelVersion = m.model_version;
    const g = m.points.find((x) => x.point === point)?.global_importance;
    if (g) {
      model = {
        method: g.method,
        rows: g.rows ?? null,
        groups: Object.entries(g.groups || {})
          .map(([name, importance]) => ({ name: displayGroup(name), label: displayGroup(name), importance }))
          .sort((a, b) => b.importance - a.importance),
        features: Object.entries(g.features || {})
          .map(([name, importance]) => ({ name, label: columnLabel(name), importance }))
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 15),
      };
    }
  } catch {
    // no model published, or the scorer is unavailable: observed importance can still be shown
  }

  const predictions = year
    ? class_id
      ? await risk.listForClass(school_id, year, point, class_id, risk.FIELDS.importance)
      : await risk.listForPoint(school_id, year, point, risk.FIELDS.importance)
    : [];
  const observed = importanceOver(predictions);
  return {
    prediction_point: point,
    academic_year: year ?? null,
    model_version: modelVersion,
    model,
    observed: { scope: class_id ? 'CLASS' : 'SCHOOL', class_id: class_id ?? null, students: observed.students, groups: observed.groups },
  };
}

async function getRiskRun(actor, { school_id, class_id, term_id, checkpoint }) {
  if (!(await platform.klass(school_id, class_id))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, class_id);
  return runView(await risk.getRun(school_id, term_id, class_id, checkpoint));
}

async function getRiskModel(actor) {
  assertAdmin(actor);
  try {
    const m = await describeModel();
    return { available: true, message: null, ...m, points: m.points.map(({ global_importance, ...rest }) => rest) };
  } catch (e) {
    return { available: false, message: e.message, model_version: null, points: [] };
  }
}

/** Queues a fresh run for a published Mid-term or End-term (Terms 1-2) or Term 3 Mid-term. */
async function runRiskPredictions(actor, input) {
  assertAdmin(actor);
  const term = await platform.term(input.school_id, input.term_id);
  if (!term) throw notFound('Term not found');
  if (!(await platform.klass(input.school_id, input.class_id))) throw notFound('Class not found');
  const point = pointFor(term.term_number, input.checkpoint);
  if (!point) throw validation('The model predicts at Mid-term and End of term in terms 1 and 2, and at Term 3 Mid-term', 'checkpoint');
  const set = await results.getSet(input.school_id, { termId: input.term_id, classId: input.class_id, checkpoint: input.checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) throw validation('Publish these results first', 'checkpoint');

  const run = await risk.putRun(input.school_id, {
    run_id: ulid(),
    term_id: input.term_id,
    class_id: input.class_id,
    checkpoint: input.checkpoint,
    prediction_point: point,
    academic_year: term.academic_year,
    calculation_id: set.calculation_id,
    status: risk.RUN.QUEUED,
    trigger: 'manual',
    requested_by: actor.sub,
    started_at: new Date().toISOString(),
  });
  await invoke(predictionFunction(), {
    action: 'run', school_id: input.school_id, class_id: input.class_id, term_id: input.term_id,
    checkpoint: input.checkpoint, run_id: run.run_id, requested_by: actor.sub,
  }, { wait: false });
  return runView(run);
}

function withTrends(dashboard) {
  if (!dashboard) return dashboard;
  return {
    ...dashboard,
    at_risk_students: (dashboard.at_risk_students ?? []).map((s) => ({
      ...s,
      trend: Array.isArray(s.trend) ? s.trend.filter(Boolean) : [],
    })),
  };
}