import { SUBJECT_TO_MODEL } from './features.js';
import { ATTENDANCE } from './explanations.js';
import { CHECKPOINT_LABEL } from './targets.js';

/**
 * Decision-support rules shared by the services and the screens. Pure.
 *
 * Who sees what. A risk profile belongs to a student's current class:
 *   administrator, class teacher   every factor (each subject and attendance)
 *   subject teacher in that class  the risk estimate, and only the factors of the
 *                                  subjects they teach there: those subjects' SHAP
 *                                  pushes, targets and interventions
 *   anyone else                    nothing
 * A factor is a gradebook subject name (CRE, not Religious_Education) or
 * "Attendance", the same names SHAP explanations and targets use.
 *
 * Interventions are what a teacher decided to do; the system never chooses one.
 * Their outcome is descriptive monitoring: what the factor's result and the risk
 * estimate did at later published checkpoints, not evidence that the
 * intervention caused it.
 */

/** Subjects the model uses (gradebook names) and attendance; other subjects are not risk factors. */
export const FACTORS = [...Object.keys(SUBJECT_TO_MODEL), ATTENDANCE];
export const INTERVENTION_STATUS = { ONGOING: 'ONGOING', STOPPED: 'STOPPED' };
export const FREQUENCIES = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY'];
export const FREQUENCY_LABEL = { ONCE: 'Once', DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly' };
export const MAX_METHOD = 200;
export const MAX_TEXT = 1000;

/** Checkpoints in school-year order; T3F is the outcome checkpoint, never a prediction point. */
export const CHECKPOINT_ORDER = ['T1M', 'T1F', 'T2M', 'T2F', 'T3M', 'T3F'];
export const pointIndex = (point) => CHECKPOINT_ORDER.indexOf(point);

/** T1 + MIDTERM -> T1M ... T3 + ENDTERM -> T3F; Opener has no point. */
export function checkpointPoint(termNumber, checkpoint) {
  const n = Number(termNumber);
  if (![1, 2, 3].includes(n)) return null;
  if (checkpoint === 'MIDTERM') return `T${n}M`;
  if (checkpoint === 'ENDTERM') return `T${n}F`;
  return null;
}

// ------------------------------------------------------------------- access

/**
 * @param {object} access  { isAdmin, isClassTeacher, subjects: string[] } for one class
 * @returns {{all:boolean, factors:Set<string>}|null}  null: no access to this class's risk profiles
 */
export function riskScope({ isAdmin, isClassTeacher, subjects = [] }) {
  if (isAdmin || isClassTeacher) return { all: true, factors: new Set(FACTORS) };
  const mine = subjects.filter((s) => FACTORS.includes(s));
  return mine.length ? { all: false, factors: new Set(mine) } : null;
}

export const canSeeFactor = (scope, factor) => Boolean(scope && (scope.all || scope.factors.has(factor)));

/**
 * The ongoing interventions in a class that concern a person: every factor for
 * administrators and the class teacher, only their own subjects for a subject
 * teacher, whoever logged them (a class teacher's Mathematics intervention
 * concerns the Mathematics teacher). Only students still on the roster count.
 */
export const interventionsThatConcern = (scope, items, studentIds) =>
  (items || []).filter((i) => canSeeFactor(scope, i.factor) && i.status === INTERVENTION_STATUS.ONGOING && studentIds.has(i.student_id));

export const scopeView = (scope) => ({ all: Boolean(scope?.all), factors: scope ? [...scope.factors] : [] });

// ---------------------------------------------------------------- explaining

/**
 * The wireframe's "High / Medium / Low contributor", from a factor's share of
 * all SHAP pushes. Only for factors that raised the estimate.
 */
export function contributorLevel(factor) {
  if (factor.direction !== 'RAISES') return null;
  if (factor.share >= 0.25) return 'HIGH';
  if (factor.share >= 0.1) return 'MEDIUM';
  return 'LOW';
}

/** SHAP factors limited to the scope, each with its contributor level. */
export function scopeFactors(factors, scope) {
  return (factors || [])
    .filter((f) => canSeeFactor(scope, f.group))
    .map((f) => ({ ...f, level: contributorLevel(f) }));
}

/**
 * Targets limited to the scope. A subject teacher sees each option's changes to
 * their subjects only; options without any are left out, and `partial` says the
 * view is part of the whole target.
 */
export function scopeTargets(targets, scope) {
  if (!targets) return null;
  if (scope?.all) return { ...targets, partial: false };
  const keep = (c) => canSeeFactor(scope, c.group);
  const options = (targets.options || [])
    .map((o) => ({ ...o, changes: o.changes.filter(keep) }))
    .filter((o) => o.changes.length);
  return {
    ...targets,
    caps: (targets.caps || []).filter((c) => canSeeFactor(scope, groupOfColumn(c.column))),
    options,
    partial: true,
  };
}

/** T1F_Religious_Education -> CRE; Attendance_T1F -> Attendance (targets' columns). */
export function groupOfColumn(column) {
  if (column.startsWith('Attendance_')) return ATTENDANCE;
  const model = column.split('_').slice(1).join('_');
  return model === 'Religious_Education' ? 'CRE' : model;
}

/** The target set for one factor at the time an intervention is logged: the first option that changes it. */
export function targetForFactor(targets, factor) {
  const options = targets?.selection_saved
    ? (targets.options || []).filter((o) => o.option_index === targets.selected_option)
    : targets?.options || [];
  for (const o of options) {
    const c = o.changes.find((x) => x.group === factor);
    if (c) return { column: c.column, label: c.label, from: c.from, to: c.to, gain: c.gain, method: o.method };
  }
  return null;
}

// ------------------------------------------------------------- interventions

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/** @returns {{ok:true, value:object} | {ok:false, field:string, reason:string}} */
export function validateIntervention(input) {
  const method = String(input.method ?? '').trim().replace(/\s+/g, ' ');
  if (!FACTORS.includes(input.factor)) return { ok: false, field: 'factor', reason: 'Choose a subject or attendance' };
  if (!method) return { ok: false, field: 'method', reason: 'Describe the intervention' };
  if (method.length > MAX_METHOD) return { ok: false, field: 'method', reason: `Keep the intervention under ${MAX_METHOD} characters` };
  if (!FREQUENCIES.includes(input.frequency)) return { ok: false, field: 'frequency', reason: 'Choose how often it happens' };
  if (!Object.values(INTERVENTION_STATUS).includes(input.status)) return { ok: false, field: 'status', reason: 'Unknown status' };
  if (!isDate(input.started_on)) return { ok: false, field: 'started_on', reason: 'Give the start date' };
  if (input.status === INTERVENTION_STATUS.STOPPED) {
    if (!isDate(input.stopped_on)) return { ok: false, field: 'stopped_on', reason: 'Give the date it stopped' };
    if (input.stopped_on < input.started_on) return { ok: false, field: 'stopped_on', reason: 'It cannot stop before it started' };
  }
  for (const f of ['expected_outcome', 'notes']) {
    if (input[f] != null && String(input[f]).length > MAX_TEXT) return { ok: false, field: f, reason: `Keep it under ${MAX_TEXT} characters` };
  }
  return {
    ok: true,
    value: {
      factor: input.factor,
      method,
      frequency: input.frequency,
      status: input.status,
      started_on: input.started_on,
      stopped_on: input.status === INTERVENTION_STATUS.STOPPED ? input.stopped_on : null,
      expected_outcome: input.expected_outcome?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  };
}

/** The key under which a method is remembered for suggestions: case and spacing do not matter. */
export const methodKey = (method) => String(method).trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_METHOD);

// ------------------------------------------------------------------ outcomes

/**
 * The factor's value at each checkpoint of the year, from published results
 * (subjects: the checkpoint exam result) or from the predictions' inputs
 * (attendance from the start of the year).
 *
 * @param {string} factor
 * @param {{point:string, subjects:object[]}[]} results   the student's published checkpoints, with their point
 * @param {object[]} predictions                          the student's predictions this year
 * @returns {Map<string, number>} point -> value
 */
export function factorSeries(factor, results, predictions) {
  const out = new Map();
  if (factor === ATTENDANCE) {
    for (const p of predictions) {
      const v = p.features?.[`Attendance_${p.prediction_point}`];
      if (Number.isFinite(v)) out.set(p.prediction_point, v);
    }
  } else {
    for (const r of results) {
      const v = (r.subjects || []).find((s) => s.subject === factor)?.score;
      if (Number.isFinite(v)) out.set(r.point, v);
    }
  }
  return out;
}

/**
 * What happened after an intervention was logged, as monitoring only.
 *   from        the factor's value at the checkpoint the intervention responded to
 *   to          its value at the latest later checkpoint with a value (null: none yet)
 *   change      to - from;  target_gain: the gain the target asked for at that time
 *   risk_from   the estimate it responded to;  risk_to: the latest later estimate
 */
export function outcomeOf(intervention, series, predictions) {
  const link = intervention.linked || {};
  const at = link.prediction_point;
  if (!at) return null;
  const from = series.get(at) ?? null;
  const later = CHECKPOINT_ORDER.filter((p) => pointIndex(p) > pointIndex(at) && series.has(p));
  const last = later[later.length - 1] ?? null;
  const to = last ? series.get(last) : null;
  const laterRisk = predictions
    .filter((p) => pointIndex(p.prediction_point) > pointIndex(at))
    .sort((a, b) => pointIndex(a.prediction_point) - pointIndex(b.prediction_point));
  const latestRisk = laterRisk[laterRisk.length - 1] ?? null;
  const change = from != null && to != null ? round1(to - from) : null;
  const targetGain = link.target?.gain ?? null;
  return {
    from_point: at,
    from_label: CHECKPOINT_LABEL[at] ?? at,
    to_point: last,
    to_label: last ? CHECKPOINT_LABEL[last] ?? last : null,
    from: from == null ? null : round1(from),
    to: to == null ? null : round1(to),
    change,
    target_gain: targetGain,
    reached_target: change != null && targetGain != null ? change >= targetGain : null,
    risk_from: link.probability ?? null,
    risk_to: latestRisk?.probability ?? null,
    risk_to_point: latestRisk?.prediction_point ?? null,
  };
}

const round1 = (x) => Math.round(x * 10) / 10;
