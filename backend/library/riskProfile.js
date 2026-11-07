import { isAdmin, isClassTeacherOf, subjectsITeach } from './authz.js';
import { todayIn } from './calendar.js';
import { checkpointPoint, factorSeries, outcomeOf, pointIndex, riskScope, scopeView, targetForFactor, canSeeFactor } from './decisionSupport.js';
import { predictionTargets } from './targetChoice.js';
import * as history from './historyRepo.js';
import * as interventions from './interventionRepo.js';
import * as platform from './platformRepo.js';
import * as risk from './riskRepo.js';

/**
 * Reading a student's risk record for decision support: which factors this
 * person may see, the student's predictions and published results for a school
 * year in checkpoint order, and their interventions with what followed them.
 */
export const zone = () => process.env.SCHOOL_TIME_ZONE || 'Africa/Nairobi';

/** The factors the actor may see in a class, or null for no access. */
export const scopeFor = (actor, classId) =>
  riskScope({ isAdmin: isAdmin(actor), isClassTeacher: isClassTeacherOf(actor, classId), subjects: subjectsITeach(actor, classId) });

/** The school year in progress: the latest year with a term that has started (else the earliest planned). */
export function currentYear(terms, today = todayIn(zone())) {
  const years = terms.map((t) => Number(t.academic_year)).filter(Number.isFinite);
  const started = terms.filter((t) => t.start_date && t.start_date <= today).map((t) => Number(t.academic_year)).filter(Number.isFinite);
  if (started.length) return Math.max(...started);
  return years.length ? Math.min(...years) : null;
}

/**
 * A student's year: predictions and published checkpoint results, each with its
 * point (T1M ... T3F), in order. A transferred student can have one result row
 * per class at a checkpoint; the latest published one counts.
 */
export async function studentYear(schoolId, studentId, academicYear, terms) {
  const termById = new Map(terms.map((t) => [t.term_id, t]));
  const [predictions, rows] = await Promise.all([
    academicYear ? risk.listForStudent(schoolId, studentId, academicYear) : [],
    history.listStudentHistory(schoolId, studentId),
  ]);
  const byPoint = new Map();
  for (const r of rows) {
    const term = termById.get(r.term_id);
    if (!term || Number(term.academic_year) !== Number(academicYear)) continue;
    const point = checkpointPoint(term.term_number, r.checkpoint);
    if (!point) continue;
    const prev = byPoint.get(point);
    if (!prev || String(r.published_at) > String(prev.published_at)) byPoint.set(point, { ...r, point, term_name: term.name });
  }
  return {
    predictions: predictions.sort((a, b) => pointIndex(a.prediction_point) - pointIndex(b.prediction_point)),
    results: [...byPoint.values()].sort((a, b) => pointIndex(a.point) - pointIndex(b.point)),
  };
}

/**
 * The latest prediction and whether it is current: it is not when results were
 * published at a later prediction point and no prediction followed (the run
 * failed or is still to come). NFR-2: the previous value is then shown, labelled.
 */
export function latestOf(year) {
  const latest = year.predictions[year.predictions.length - 1] ?? null;
  const lastPublished = [...year.results].reverse().find((r) => r.point !== 'T3F') ?? null;
  const current = Boolean(latest) && (!lastPublished || pointIndex(lastPublished.point) <= pointIndex(latest.prediction_point));
  return { latest, current, last_published_point: lastPublished?.point ?? null };
}

/** What an intervention responds to: the student's latest prediction this year, with the target set for its factor then. */
export function linkFor(prediction, factor) {
  if (!prediction) return null;
  const targets = predictionTargets(prediction);
  return {
    academic_year: prediction.academic_year,
    prediction_point: prediction.prediction_point,
    run_id: prediction.run_id ?? null,
    model_version: prediction.model_version ?? null,
    probability: prediction.probability,
    at_risk: Boolean(prediction.at_risk),
    threshold: prediction.threshold ?? null,
    predicted_at: prediction.predicted_at ?? null,
    targets_status: targets?.status ?? null,
    target: targetForFactor(targets && { ...targets, selection_saved: true }, factor),
    ...(targets ? { target_option: targets.selected_option, target_changes: targets.options.find((o) => o.option_index === targets.selected_option)?.changes ?? [] } : {}),
  };
}

/** The intervention as the screens show it, with its descriptive outcome. */
export function interventionView(item, year) {
  const series = year ? factorSeries(item.factor, year.results, year.predictions) : new Map();
  return {
    intervention_id: item.intervention_id,
    student_id: item.student_id,
    class_id: item.class_id,
    factor: item.factor,
    method: item.method,
    frequency: item.frequency,
    status: item.status,
    started_on: item.started_on,
    stopped_on: item.stopped_on ?? null,
    expected_outcome: item.expected_outcome ?? null,
    notes: item.notes ?? null,
    linked: item.linked ?? null,
    outcome: year && item.linked ? outcomeOf(item, series, year.predictions) : null,
    created_by: item.created_by,
    created_by_name: item.created_by_name ?? null,
    created_at: item.created_at,
    updated_by_name: item.updated_by_name ?? null,
    updated_at: item.updated_at,
    _version: item._version,
  };
}

/**
 * The actor's view of one student: their class, the factors they may see, and
 * the year's record. Throws nothing for "no access": callers decide.
 */
export async function studentContext(actor, schoolId, studentId, academicYear = null) {
  const student = await platform.student(schoolId, studentId);
  if (!student) return null;
  const scope = student.class_id ? scopeFor(actor, student.class_id) : (isAdmin(actor) ? scopeFor(actor, null) : null);
  const terms = await platform.listTerms(schoolId);
  const year = academicYear ?? currentYear(terms);
  return { student, scope, scopeView: scopeView(scope), terms, academicYear: year };
}

/** A student's interventions the actor may see, newest first, each with its outcome. */
export async function visibleInterventions(schoolId, studentId, scope, year) {
  const items = await interventions.listForStudent(schoolId, studentId);
  return items
    .filter((i) => canSeeFactor(scope, i.factor))
    .map((i) => interventionView(i, year))
    .sort((a, b) => String(b.started_on).localeCompare(String(a.started_on)) || String(b.created_at).localeCompare(String(a.created_at)));
}
