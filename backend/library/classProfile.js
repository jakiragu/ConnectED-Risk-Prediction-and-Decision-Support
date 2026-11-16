import { gradeFor, roundHalfUp, CHECKPOINT } from './results.js';
import { explain, displayGroup, ATTENDANCE } from './explanations.js';
import { canSeeFactor, INTERVENTION_STATUS, methodKey } from './decisionSupport.js';

/**
 * The class page's numbers, from published results only.
 *
 * Who sees what follows the rule the risk screens already use:
 *   - administrators and the class teacher: the whole class (FULL);
 *   - a subject teacher: only the subjects they teach in the class (SUBJECT),
 *     no attendance, and only the flagged students whose estimate their
 *     subject raised.
 * The caller works out the scope; this module never sees data outside it,
 * because the handler filters the subjects before calling.
 *
 * "Result" means the result a student got at the chosen exam: the checkpoint
 * average at an Opener or Mid-term, and the weighted term result at the
 * End-term (the number that is graded and printed on the report card).
 */

export const SCOPE = { FULL: 'FULL', SUBJECT: 'SUBJECT' };
export const MOVEMENT_LIMIT = 5;

const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : roundHalfUp(x, 1));
const share = (part, whole) => (whole > 0 ? roundHalfUp(part / whole, 4) : null);
const diff = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : r1(a - b));

/** mean, median and quartiles (linear interpolation), min and max of the finite values. */
export function describe(values) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { count: 0, mean: null, median: null, q1: null, q3: null, min: null, max: null };
  const q = (p) => {
    const pos = (xs.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  };
  return {
    count: xs.length,
    mean: r1(xs.reduce((t, x) => t + x, 0) / xs.length),
    median: r1(q(0.5)),
    q1: r1(q(0.25)),
    q3: r1(q(0.75)),
    min: r1(xs[0]),
    max: r1(xs[xs.length - 1]),
  };
}

/** A subject's result for one student at this checkpoint (term result at the End-term). */
export function subjectValue(subjectResult, checkpoint) {
  if (!subjectResult) return null;
  const v = checkpoint === CHECKPOINT.ENDTERM ? subjectResult.term?.term_score : subjectResult.score;
  return Number.isFinite(v) ? v : null;
}

/**
 * A student's result at this checkpoint, within the scope. FULL uses the
 * stored average; SUBJECT averages only the visible subjects.
 */
export function studentValue(row, checkpoint, subjects) {
  if (!row) return null;
  if (!subjects) {
    const v = checkpoint === CHECKPOINT.ENDTERM ? row.term_average : row.checkpoint_average;
    return Number.isFinite(v) ? v : null;
  }
  const vs = (row.subjects || [])
    .filter((s) => subjects.includes(s.subject))
    .map((s) => subjectValue(s, checkpoint))
    .filter((v) => v !== null);
  return vs.length ? vs.reduce((t, x) => t + x, 0) / vs.length : null;
}

// Full rows carry the counts; rows rebuilt from a result digest (resultDigest.js) carry the answer.
const incompleteSubject = (s) => s.incomplete ?? (s.absent_count || 0) + (s.missing_count || 0) + (s.not_assessed_count || 0) > 0;

function bucketsFor(bands) {
  if (bands?.length) {
    return [...bands]
      .sort((a, b) => a.min_score - b.min_score)
      .map((b) => ({ label: b.grade, min: b.min_score, max: b.max_score }));
  }
  // No grading scale (should not happen once the school default exists): plain 10-mark bands.
  return Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}–${i === 9 ? 100 : i * 10 + 9}`, min: i * 10, max: i === 9 ? 100 : i * 10 + 9 }));
}

function countInto(buckets, values) {
  const counts = buckets.map(() => 0);
  for (const v of values) {
    if (v === null) continue;
    const whole = roundHalfUp(v, 0);
    const i = buckets.findIndex((b) => whole >= b.min && whole <= b.max);
    if (i >= 0) counts[i] += 1;
  }
  return counts;
}

/**
 * @param {object} p
 * @param {string} p.checkpoint
 * @param {object[]} p.roster                 students in the class
 * @param {Map<string,object>} p.rows         student_id -> published result row at this checkpoint
 * @param {{checkpoint:string, rows:Map<string,object>}|null} p.previousRows  the previous published exam, or null
 * @param {object} p.rule                     the term's grading rule {bands, pass_mark}
 * @param {string[]|null} p.subjects          visible subjects; null = all (FULL)
 * @param {object[]} p.schoolRows             every published row at this checkpoint in the school (comparison)
 * @param {Map<string,number>|null} p.attendance  student_id -> attendance % for the period (FULL only)
 * @param {object|null} p.riskScope           riskScope() for this class, or null for no access
 * @param {object[]} p.predictions            this class's predictions at the matching point
 * @param {object[]} p.interventions          this class's interventions
 */
export function buildClassProfile({
  checkpoint, roster, rows, previousRows = null, rule, subjects = null, schoolRows = [],
  attendance = null, riskScope = null, predictions = [], interventions = [],
}) {
  const scope = subjects ? SCOPE.SUBJECT : SCOPE.FULL;
  const bands = rule?.bands || [];
  const passMark = Number.isFinite(rule?.pass_mark) ? rule.pass_mark : null;
  const valueOf = (row) => studentValue(row, checkpoint, subjects);
  const previousValueOf = (row) => studentValue(row, previousRows?.checkpoint ?? checkpoint, subjects);

  const students = roster.map((s) => {
    const now = valueOf(rows.get(s.student_id));
    const before = previousRows ? previousValueOf(previousRows.rows.get(s.student_id)) : null;
    return { student: s, now, before };
  });
  const nowValues = students.map((x) => x.now);
  const beforeValues = students.map((x) => x.before);
  const passed = (vs) => vs.filter((v) => v !== null && passMark !== null && v >= passMark).length;
  const assessed = nowValues.filter((v) => v !== null).length;
  const assessedBefore = beforeValues.filter((v) => v !== null).length;
  const stats = describe(nowValues);
  const statsBefore = describe(beforeValues);
  const schoolStats = describe(schoolRows.map(valueOf));

  // ---------------------------------------------------------------- subjects
  const subjectNames = [...new Set([...rows.values()].flatMap((r) => (r.subjects || []).map((s) => s.subject)))]
    .filter((name) => !subjects || subjects.includes(name));
  const subjectRows = subjectNames.map((name) => {
    const pick = (row, cp) => subjectValue((row?.subjects || []).find((x) => x.subject === name), cp);
    const values = [...rows.values()].map((r) => pick(r, checkpoint));
    const d = describe(values);
    const before = previousRows ? describe([...previousRows.rows.values()].map((r) => pick(r, previousRows.checkpoint))) : null;
    const school = describe(schoolRows.map((r) => pick(r, checkpoint)));
    const incomplete = [...rows.values()]
      .filter((r) => (r.subjects || []).some((x) => x.subject === name && incompleteSubject(x))).length;
    return {
      subject: name,
      ...d,
      assessed: d.count,
      pass_rate: share(values.filter((v) => v !== null && passMark !== null && v >= passMark).length, d.count),
      change: before ? diff(d.mean, before.mean) : null,
      school_mean: school.count ? school.mean : null,
      incomplete,
    };
  }).sort((a, b) => (a.mean ?? Infinity) - (b.mean ?? Infinity));

  // ------------------------------------------------------------ distribution
  const buckets = bucketsFor(bands);
  const nowCounts = countInto(buckets, nowValues);
  const beforeCounts = previousRows ? countInto(buckets, beforeValues) : null;
  const distribution = buckets.map((b, i) => ({
    label: b.label, min: b.min, max: b.max, count: nowCounts[i], previous_count: beforeCounts ? beforeCounts[i] : null,
  }));

  // ---------------------------------------------------------------- movement
  const moved = students
    .filter((x) => x.now !== null && x.before !== null)
    .map((x) => ({ ...x, change: r1(x.now - x.before) }));
  const person = (x) => ({
    student_id: x.student.student_id,
    first_name: x.student.first_name,
    last_name: x.student.last_name,
    admission_no: x.student.admission_no,
    now: r1(x.now),
    before: r1(x.before),
    change: x.change,
  });
  const movement = {
    compared: moved.length,
    risers: moved.filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, MOVEMENT_LIMIT).map(person),
    fallers: moved.filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, MOVEMENT_LIMIT).map(person),
  };

  // -------------------------------------------------------------------- risk
  const ongoing = interventions.filter((i) => i.status === INTERVENTION_STATUS.ONGOING && canSeeFactor(riskScope, i.factor));
  const ongoingBy = new Map();
  for (const i of ongoing) ongoingBy.set(i.student_id, (ongoingBy.get(i.student_id) || 0) + 1);
  const byStudent = new Map(predictions.map((p) => [p.student_id, p]));
  const names = new Map(roster.map((s) => [s.student_id, s]));

  let risk = null;
  if (riskScope) {
    const flagged = [];
    for (const p of predictions) {
      if (!p.at_risk || !names.has(p.student_id)) continue;
      const visible = (explain(p)?.factors || [])
        .map((f) => ({ ...f, factor: displayGroup(f.group) }))
        .filter((f) => canSeeFactor(riskScope, f.factor));
      const raising = visible.filter((f) => f.direction === 'RAISES');
      // A subject teacher sees a flagged student only when their own subject raised the estimate.
      if (!riskScope.all && !raising.length) continue;
      const s = names.get(p.student_id);
      flagged.push({
        student_id: s.student_id,
        first_name: s.first_name,
        last_name: s.last_name,
        admission_no: s.admission_no,
        probability: p.probability,
        raised_by: raising.slice(0, 3).map((f) => (f.factor === ATTENDANCE ? 'Attendance' : f.factor)),
        interventions: ongoingBy.get(s.student_id) || 0,
      });
    }
    flagged.sort((a, b) => b.probability - a.probability);
    const predicted = predictions.filter((p) => names.has(p.student_id)).length;
    const flaggedTotal = riskScope.all ? flagged.length : predictions.filter((p) => p.at_risk && names.has(p.student_id)).length;
    risk = {
      predicted,
      flagged: flaggedTotal,
      flagged_rate: share(flaggedTotal, predicted),
      threshold: predictions.find((p) => Number.isFinite(p.threshold))?.threshold ?? null,
      model_version: predictions.find((p) => p.model_version)?.model_version ?? null,
      students: flagged,
      without_intervention: flagged.filter((f) => f.interventions === 0).length,
    };
  }

  // ------------------------------------------------------------------ roster
  const rosterRows = students.map((x) => {
    const p = byStudent.get(x.student.student_id);
    return {
      student_id: x.student.student_id,
      first_name: x.student.first_name,
      last_name: x.student.last_name,
      admission_no: x.student.admission_no,
      result: r1(x.now),
      grade: x.now === null ? null : gradeFor(x.now, bands),
      change: diff(x.now, x.before),
      attendance: scope === SCOPE.FULL && attendance ? attendance.get(x.student.student_id) ?? null : null,
      probability: riskScope && p ? p.probability : null,
      at_risk: riskScope && p ? Boolean(p.at_risk) : null,
      interventions: ongoingBy.get(x.student.student_id) || 0,
      incomplete: (rows.get(x.student.student_id)?.subjects || [])
        .some((s) => (!subjects || subjects.includes(s.subject)) && incompleteSubject(s)),
    };
  }).sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));

  const attendanceValues = attendance && scope === SCOPE.FULL
    ? roster.map((s) => attendance.get(s.student_id)).filter((v) => Number.isFinite(v))
    : [];

  return {
    scope,
    subjects: subjects ?? subjectNames,
    student_count: roster.length,
    summary: {
      assessed,
      mean: stats.mean,
      mean_grade: stats.mean === null ? null : gradeFor(stats.mean, bands),
      median: stats.median,
      mean_change: previousRows ? diff(stats.mean, statsBefore.mean) : null,
      pass_mark: passMark,
      pass_rate: share(passed(nowValues), assessed),
      pass_rate_change: previousRows && assessedBefore
        ? r1(((share(passed(nowValues), assessed) ?? 0) - (share(passed(beforeValues), assessedBefore) ?? 0)) * 100)
        : null,
      school_mean: schoolStats.count ? schoolStats.mean : null,
      attendance_rate: attendanceValues.length ? r1(attendanceValues.reduce((t, x) => t + x, 0) / attendanceValues.length) : null,
      incomplete: rosterRows.filter((r) => r.incomplete).length,
    },
    distribution,
    subject_results: subjectRows,
    movement,
    risk,
    students: rosterRows,
  };
}

// ---------------------------------------------------------- charts and panels

/** Ten equal ranges: 0–9, 10–19, … 90–100. Equal widths keep an area chart's shape honest. */
export const RANGES = Array.from({ length: 10 }, (_, i) => ({ label: i === 9 ? '90–100' : `${i * 10}–${i * 10 + 9}`, min: i * 10, max: i === 9 ? 100 : i * 10 + 9 }));

export function rangeCounts(values) {
  const counts = RANGES.map(() => 0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const i = Math.min(9, Math.max(0, Math.floor(roundHalfUp(v, 0) / 10)));
    counts[i] += 1;
  }
  return counts;
}

/**
 * A student's result in one exam on its own: the exam average across subjects
 * (within the scope). Unlike the End-term term result, it does not mix in
 * earlier exams, so a Mid-term and an End-term curve compare like with like.
 */
export function examValue(row, subjects) {
  if (!row) return null;
  if (!subjects) return Number.isFinite(row.checkpoint_average) ? row.checkpoint_average : null;
  const vs = (row.subjects || []).filter((s) => subjects.includes(s.subject)).map((s) => s.score).filter(Number.isFinite);
  return vs.length ? vs.reduce((t, x) => t + x, 0) / vs.length : null;
}

/** The mean exam result of a set of rows within the scope, or null. */
export function examMean(rows, subjects) {
  return describe([...rows].map((r) => examValue(r, subjects))).mean;
}

/**
 * The factors that moved this class's estimates most: each factor's share of
 * the total absolute contribution across the class, the viewer's factors only.
 */
export function topFactors(predictions, riskScope, limit = 3) {
  if (!riskScope) return [];
  const totals = new Map();
  let all = 0;
  for (const p of predictions) {
    for (const f of explain(p)?.factors || []) {
      const factor = displayGroup(f.group);
      const size = (f.columns || []).reduce((t, c) => t + Math.abs(c.effect ?? 0), 0);
      all += size;
      if (!canSeeFactor(riskScope, factor)) continue;
      totals.set(factor, (totals.get(factor) || 0) + size);
    }
  }
  if (!all) return [];
  return [...totals.entries()]
    .map(([factor, total]) => ({ factor: factor === ATTENDANCE ? 'Attendance' : factor, share: roundHalfUp(total / all, 4) }))
    .sort((a, b) => b.share - a.share)
    .slice(0, limit);
}

/**
 * Ongoing interventions in the class grouped by method and factor, the
 * viewer's factors only: "Daily reading of set books (Kiswahili), 12 students".
 */
export function interventionMethods(interventions, riskScope, rosterIds) {
  const groups = new Map();
  for (const i of interventions) {
    if (i.status !== INTERVENTION_STATUS.ONGOING || !canSeeFactor(riskScope, i.factor) || !rosterIds.has(i.student_id)) continue;
    const key = `${methodKey(i.method)}|${i.factor}`;
    const g = groups.get(key) ?? { method: i.method, factor: i.factor, frequency: i.frequency, students: new Set() };
    g.students.add(i.student_id);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ method: g.method, factor: g.factor === ATTENDANCE ? 'Attendance' : g.factor, frequency: g.frequency ?? null, students: g.students.size }))
    .sort((a, b) => b.students - a.students || a.method.localeCompare(b.method));
}

/** Students per 10% band of estimated risk, and how many are flagged. */
export function riskSeries(predictions, rosterIds) {
  const mine = predictions.filter((p) => rosterIds.has(p.student_id) && Number.isFinite(p.probability));
  return {
    counts: rangeCounts(mine.map((p) => p.probability * 100)),
    predicted: mine.length,
    flagged: mine.filter((p) => p.at_risk).length,
  };
}
