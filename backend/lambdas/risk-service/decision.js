import { assertAdmin, isAdmin, isClassTeacherOf, readableClassIds, subjectsITeach } from '../../library/authz.js';
import { recordingStatus, SUBJECTS } from '../../library/assessment.js';
import { termStatus, todayIn } from '../../library/calendar.js';
import { canSeeFactor, CHECKPOINT_ORDER, INTERVENTION_STATUS, interventionsThatConcern, pointIndex, scopeFactors, scopeTargets, scopeView } from '../../library/decisionSupport.js';
import { explain } from '../../library/explanations.js';
import { POINT_NAMES } from '../../library/features.js';
import { CHECKPOINT_LABEL, selectedChanges } from '../../library/targets.js';
import { predictionTargets } from '../../library/targetChoice.js';
import { forbidden, notFound } from '../../library/errors.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as interventions from '../../library/interventionRepo.js';
import * as platform from '../../library/platformRepo.js';
import * as risk from '../../library/riskRepo.js';
import * as history from '../../library/historyRepo.js';
import * as promotions from '../../library/promotionRepo.js';
import { currentYear, latestOf, scopeFor, studentContext, studentYear, visibleInterventions, zone } from '../../library/riskProfile.js';

/**
 * Decision support reads (FR-11, US-01..US-06): a student's risk profile, a
 * teacher's dashboard, and the school-wide overview for administrators. Every
 * factor-level detail (SHAP pushes, targets, interventions, subject results) is
 * cut down to what the person may see: everything for administrators and the
 * class teacher; their own subjects for a subject teacher.
 */

const summary = (p) => p && ({
  prediction_point: p.prediction_point,
  label: CHECKPOINT_LABEL[p.prediction_point] ?? p.prediction_point,
  probability: p.probability,
  at_risk: Boolean(p.at_risk),
  threshold: p.threshold,
  model_version: p.model_version,
  predicted_at: p.predicted_at ?? null,
  targets_status: p.counterfactuals?.status ?? null,
});

const studentView = (s, klass) => ({
  student_id: s.student_id,
  admission_no: s.admission_no ?? '',
  first_name: s.first_name ?? '',
  last_name: s.last_name ?? '',
  class_id: s.class_id ?? null,
  class_name: klass?.name ?? null,
  status: s.status || 'ACTIVE',
  graduation_year: s.graduation_year ?? null,
});

const subjectsIn = (row, scope) => (row?.subjects || [])
  .filter((s) => canSeeFactor(scope, s.subject))
  .map((s) => ({ subject: s.subject, score: s.score ?? null, grade: s.grade ?? null }));

const resultsView = (row, scope) => row && ({
  point: row.point,
  label: CHECKPOINT_LABEL[row.point] ?? row.point,
  average: scope.all ? row.checkpoint_average ?? null : null,
  subjects: subjectsIn(row, scope),
});

/** The first option's changes the person may see, for cards and lists. */
function bestChanges(prediction, scope) {
  const t = scopeTargets(predictionTargets(prediction), scope);
  if (!t || !['FOUND', 'FALLBACK'].includes(t.status)) return [];
  return selectedChanges(t);
}

// ------------------------------------------------------------------ profile

export async function getStudentRiskProfile(actor, { school_id, student_id, academic_year }) {
  const ctx = await studentContext(actor, school_id, student_id, academic_year ?? null);
  if (!ctx) throw notFound('Student not found');
  if (!ctx.scope) throw forbidden('You do not teach this student');

  const { scope } = ctx;
  const klass = ctx.student.class_id ? await platform.klass(school_id, ctx.student.class_id) : null;
  const [year, past] = await Promise.all([
    studentYear(school_id, student_id, ctx.academicYear, ctx.terms),
    history.listStudentHistory(school_id, student_id),
  ]);
  const { latest, current, last_published_point } = latestOf(year);
  const previous = year.predictions.length > 1
    ? year.predictions[year.predictions.length - 2]
    : null;

  const e = latest ? explain(latest) : null;
  const lastResult = year.results[year.results.length - 1] ?? null;

  // Results and interventions associated with each prediction checkpoint.
  const resultsByPoint = new Map(year.results.map((r) => [r.point, r]));

  const visible = await visibleInterventions(
    school_id,
    student_id,
    scope,
    year
  );

  // Each prediction gets its own explanation, targets and linked interventions.
  const assessmentHistory = year.predictions.map((prediction) => {
    const explanation = explain(prediction);

    return {
      prediction: summary(prediction),

      base_probability: explanation?.base_probability ?? null,
      explained: Boolean(explanation),

      factors: explanation
        ? scopeFactors(explanation.factors, scope)
        : [],

      targets: scopeTargets(
        predictionTargets(prediction),
        scope
      ),

      results: resultsView(
        resultsByPoint.get(prediction.prediction_point),
        scope
      ),

      interventions: visible.filter(
        (i) => i.linked?.prediction_point === prediction.prediction_point
          && Number(i.linked?.academic_year) === Number(ctx.academicYear)
      ),
    };
  });
  // The years this student has published results in, so earlier years (before a promotion) can be opened.
  const years = [...new Set([...past.map((r) => Number(r.academic_year)), Number(ctx.academicYear)].filter(Number.isFinite))].sort((a, b) => b - a);
  const rowsThisYear = past.filter((r) => Number(r.academic_year) === Number(ctx.academicYear))
    .sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
  const yearClassId = rowsThisYear[rowsThisYear.length - 1]?.class_id ?? null;
  const yearClass = yearClassId && yearClassId !== klass?.class_id ? await platform.klass(school_id, yearClassId) : klass;

  return {
    student: studentView(ctx.student, klass),
    academic_year: ctx.academicYear,
    available_years: years,
    year_class_name: yearClass ? `${yearClass.name}${yearClass.year ? ` ${yearClass.year}` : ''}` : null,
    scope: ctx.scopeView,

    current,
    last_published_point,

    // Retain these existing fields for backward compatibility.
    latest: summary(latest),
    previous: summary(previous),
    base_probability: e?.base_probability ?? null,
    explained: Boolean(e),
    factors: e ? scopeFactors(e.factors, scope) : [],
    targets: latest
      ? scopeTargets(predictionTargets(latest), scope)
      : null,

    results: resultsView(lastResult, scope),

    // New complete assessment history.
    assessment_history: assessmentHistory,

    risk_trend: year.predictions.map(summary),

    performance_trend: year.results.map((r) => resultsView(r, scope)),

    interventions: visible,
  };
}

// ---------------------------------------------------------------- dashboard

/** Each student's latest prediction this year, from one query per prediction point. */
async function latestByStudent(schoolId, year) {
  const out = new Map();
  if (!year) return out;
  const lists = await Promise.all(POINT_NAMES.map((point) => risk.listForPoint(schoolId, year, point)));
  for (const p of lists.flat()) {
    const prev = out.get(p.student_id);
    if (!prev || pointIndex(p.prediction_point) > pointIndex(prev.prediction_point)) out.set(p.student_id, p);
  }
  return out;
}

export async function getRiskDashboard(actor, { school_id }) {
  const [allClasses, terms] = await Promise.all([platform.listClasses(school_id), platform.listTerms(school_id)]);
  const ids = isAdmin(actor) ? null : readableClassIds(actor);
  const today = todayIn(zone());
  let year = currentYear(terms, today);
  // Once a year is promoted its classes are archived, so the dashboard moves to the next year's classes
  // (whose predictions start when their first results are published).
  if (year != null && (await promotions.getLock(school_id, year))?.status === promotions.RUN_STATUS.APPLIED) year += 1;
  // Only classes of the dashboard's year: last year's predictions never appear under this year's class names.
  const inYear = (c) => (year == null || c.year == null ? c.status !== 'PAST' : Number(c.year) === Number(year));
  const classes = allClasses.filter((c) => (ids ? ids.has(c.class_id) : c.status !== 'PAST') && inYear(c));
  const currentTerm = terms.find((t) => Number(t.academic_year) === Number(year) && termStatus(t, today) === 'CURRENT') ?? null;
  const [latest, names] = await Promise.all([latestByStudent(school_id, year), platform.teacherNames(school_id)]);

  // Classes are read side by side rather than one after another: each needs its
  // roster, interventions and papers, and waiting for every class in turn was
  // most of the dashboard's load time.
  const perClass = await Promise.all(classes.map(async (klass) => {
    const scope = scopeFor(actor, klass.class_id);
    const subjects = currentTerm ? (isAdmin(actor) ? new Set(SUBJECTS) : new Set(subjectsITeach(actor, klass.class_id))) : new Set();
    const [roster, logged, papers] = await Promise.all([
      platform.listStudents(school_id, klass.class_id),
      scope ? interventions.listForClass(school_id, klass.class_id) : [],
      subjects.size ? assessments.listAllLive(school_id, klass.class_id, currentTerm.term_id) : [],
    ]);
    const byId = new Map(roster.map((s) => [s.student_id, s]));
    const out = { students: 0, flagged: 0, atRisk: [], ongoing: [], pending: [] };

    if (scope) {
      out.students = roster.length;
      // What concerns this person: every subject for the class teacher and administrators,
      // only their own subjects for a subject teacher, whoever logged it.
      const visible = interventionsThatConcern(scope, logged, byId);
      for (const i of visible) {
        const s = byId.get(i.student_id);
        out.ongoing.push({
          intervention_id: i.intervention_id, student_id: i.student_id, student_name: `${s.first_name} ${s.last_name}`,
          admission_no: s.admission_no ?? null, class_id: klass.class_id, class_name: klass.name,
          factor: i.factor, method: i.method, frequency: i.frequency, started_on: i.started_on,
          created_by: i.created_by ?? null,
          created_by_name: names.get(i.created_by) ?? i.created_by_name ?? null,
          assigned_by_me: Boolean(i.created_by) && i.created_by === actor.sub,
        });
      }
      for (const s of roster) {
        const p = latest.get(s.student_id);
        if (!p?.at_risk) continue;
        out.flagged += 1;
        out.atRisk.push({
          student: studentView(s, klass),
          latest: summary(p),
          targets: bestChanges(p, scope),
          partial: !scope.all,
          // What the viewer may log an intervention for, so several students can be chosen at once.
          factors: scopeView(scope).factors,
          interventions: visible.filter((i) => i.student_id === s.student_id).map((i) => i.method),
        });
      }
    }

    // Papers this person enters marks for, still being recorded this term.
    for (const a of papers.filter((x) => subjects.has(x.subject))) {
      const status = recordingStatus(a, roster.length);
      if (status !== 'UNRECORDED' && status !== 'RECORDING') continue;
      out.pending.push({
        assessment_id: a.assessment_id, class_name: klass.name, subject: a.subject, title: a.title,
        assessment_type: a.assessment_type, status, missing: Math.max(roster.length - (a.score_count || 0), 0), due_date: a.due_date ?? null,
      });
    }
    return out;
  }));

  const all = (key) => perClass.flatMap((c) => c[key]);
  return {
    academic_year: year,
    term_name: currentTerm?.name ?? null,
    classes: classes.length,
    students: perClass.reduce((n, c) => n + c.students, 0),
    at_risk: perClass.reduce((n, c) => n + c.flagged, 0),
    // Decides which interventions the dashboard opens on: a class teacher starts with the ones they logged.
    viewer_is_class_teacher: !isAdmin(actor) && classes.some((c) => isClassTeacherOf(actor, c.class_id)),
    at_risk_students: all('atRisk').sort((a, b) => b.latest.probability - a.latest.probability),
    ongoing_interventions: all('ongoing').sort((a, b) => String(b.started_on).localeCompare(String(a.started_on))),
    pending_assessments: all('pending'),
  };
}

// --------------------------------------------------------- school overview

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export async function getSchoolRiskOverview(actor, { school_id, academic_year }) {
  assertAdmin(actor);
  const [classes, terms] = await Promise.all([platform.listClasses(school_id), platform.listTerms(school_id)]);
  const year = academic_year ?? currentYear(terms);
  const byPoint = year ? await Promise.all(POINT_NAMES.map((point) => risk.listForPoint(school_id, year, point))) : POINT_NAMES.map(() => []);
  const classById = new Map(classes.map((c) => [c.class_id, c]));

  const points = POINT_NAMES.map((point, i) => {
    const list = byPoint[i];
    const flagged = list.filter((p) => p.at_risk).length;
    return { point, label: CHECKPOINT_LABEL[point], students: list.length, at_risk: flagged, rate: rate(flagged, list.length) };
  });

  // Per class and per form (grade): the at-risk rate at each point, from the class the prediction was made in.
  const groupRows = (keyOf, labelOf) => {
    const rows = new Map();
    POINT_NAMES.forEach((point, i) => {
      for (const p of byPoint[i]) {
        const key = keyOf(p);
        if (key == null) continue;
        if (!rows.has(key)) rows.set(key, { key, label: labelOf(key), points: Object.fromEntries(POINT_NAMES.map((x) => [x, { students: 0, at_risk: 0 }])) });
        const cell = rows.get(key).points[point];
        cell.students += 1;
        if (p.at_risk) cell.at_risk += 1;
      }
    });
    return [...rows.values()].map((r) => {
      const series = POINT_NAMES.map((point) => ({ point, students: r.points[point].students, at_risk: r.points[point].at_risk, rate: rate(r.points[point].at_risk, r.points[point].students) }));
      const last = [...series].reverse().find((x) => x.students) ?? null;
      return { key: r.key, label: r.label, series, latest: last };
    }).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }));
  };

  const classRows = groupRows((p) => p.class_id ?? null, (id) => classById.get(id)?.name ?? id);
  const counts = await Promise.all(classRows.map((r) => interventions.listForClass(school_id, r.key)));
  const helped = new Set();
  classRows.forEach((r, i) => {
    const ongoing = counts[i].filter((x) => x.status === INTERVENTION_STATUS.ONGOING);
    r.interventions_ongoing = ongoing.length;
    r.interventions_logged = counts[i].length;
    for (const x of ongoing) helped.add(x.student_id);
  });
  const formRows = groupRows((p) => classById.get(p.class_id)?.grade ?? null, (g) => String(g)); // grade is already "Form 4"

  return {
    academic_year: year ?? null,
    points,
    forms: formRows,
    classes: classRows,
    interventions_ongoing: classRows.reduce((s, r) => s + r.interventions_ongoing, 0),
    interventions_logged: classRows.reduce((s, r) => s + r.interventions_logged, 0),
    // One student usually has several interventions (one per subject), so the count of students is shown beside it.
    students_with_interventions: helped.size,
    checkpoints: CHECKPOINT_ORDER,
  };
}
