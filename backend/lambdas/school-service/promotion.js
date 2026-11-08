import { createHash } from 'node:crypto';
import * as grading from '../../library/gradingRepo.js';
import { assertAdmin } from '../../library/authz.js';
import { todayIn } from '../../library/calendar.js';
import { conflict, notFound, validation } from '../../library/errors.js';
import { emit } from '../../library/events.js';
import { ulid } from '../../library/ids.js';
import { ACTION, STUDENT_STATUS, buildPlan, formsForSchool, levelsFromForms, planTeachers } from '../../library/promotion.js';
import * as classSetupStore from '../../library/classSetupRepo.js';
import * as attendance from '../../library/attendanceRepo.js';
import * as interventions from '../../library/interventionRepo.js';
import * as platform from '../../library/platformRepo.js';
import * as repo from '../../library/promotionRepo.js';
import * as results from '../../library/resultsRepo.js';
import * as school from '../../library/schoolRepo.js';
import { zone } from '../../library/riskProfile.js';

/**
 * Year-end promotion (an operational extension of the gradebook; not part of
 * the CSG Exams & Gradebook spec or the capstone proposal).
 *
 *   planPromotion     read only: what would happen, and what blocks it
 *   applyPromotion    does it; resumable and safe to send twice
 *   revertPromotion   undoes it while the new year has no records yet
 *
 * Administrators only. The plan is rebuilt here from stored data every time;
 * the client sends only per-student choices.
 */

const fullName = (t) => [t.first_name, t.last_name].filter(Boolean).join(' ');
const log = (o) => console.log(JSON.stringify({ svc: 'school-service', area: 'promotion', ...o }));

function yearOf(value) {
  const y = Number(value);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw validation('Choose the school year to close, such as 2026', 'from_year');
  return y;
}

async function context(schoolId, fromYear) {
  const [setup, classes, terms, teachers, policy] = await Promise.all([
    classSetupStore.get(schoolId),
    platform.listClasses(schoolId),
    platform.listTerms(schoolId),
    platform.listTeachers(schoolId),
    grading.getPolicy(schoolId),
  ]);
  const term3 = terms.find((t) => Number(t.academic_year) === fromYear && Number(t.term_number) === 3) || null;
  const term3Sets = term3 ? await results.listSetsForTerm(schoolId, term3.term_id) : [];
  const published = new Map(term3Sets.filter((s) => s.checkpoint === 'ENDTERM' && s.status === 'PUBLISHED').map((s) => [s.class_id, s]));
  const finalRows = new Map(), studentsByClass = new Map(), studentCounts = new Map();
  const sources = classes.filter((c) => Number(c.year) === fromYear && (c.status || 'CURRENT') === 'CURRENT');
  await Promise.all(sources.map(async (c) => {
    const set = published.get(c.class_id);
    if (!set) {
      studentCounts.set(c.class_id, await repo.promotionStudentCounts(schoolId, c.class_id));
      return; // No roster or per-student results read before publication.
    }
    const [students, rows] = await Promise.all([
      repo.promotionStudents(schoolId, c.class_id),
      set.calculation_id ? results.listRows(schoolId, set) : [],
    ]);
    studentsByClass.set(c.class_id, students);
    finalRows.set(c.class_id, new Map(rows.map((r) => [r.student_id, r])));
  }));
  return {
    // The order students move through comes from the school's forms (Settings, Classes).
    ladder: levelsFromForms(formsForSchool(setup, classes), setup?.progression_paths),
    finalRows,
    passMark: policy.pass_mark ?? 50,
    classes,
    terms,
    teachers,
    studentsByClass,
    studentCounts,
    term3,
    term3Sets,
    teacherNames: new Map(teachers.map((t) => [t.teacher_id, fullName(t)])),
  };
}

function strategyOf(input) {
  const strategy = input.teacher_strategy ?? (input.copy_teachers === false ? 'MANUAL' : 'FOLLOW');
  if (!['STAY', 'FOLLOW', 'MANUAL'].includes(strategy)) throw validation('Choose a teacher assignment strategy', 'teacher_strategy');
  return strategy;
}
function planFor(ctx, fromYear, input = {}) {
  const strategy = strategyOf(input);
  const plan = buildPlan({ ...ctx, fromYear, overrides: input.overrides || [], teacherStrategy: strategy });
  const preview = planTeachers(plan, ctx.teachers, ctx.classes, strategy, input.excluded_teachers || []);
  plan.blockers.push(...preview.blockers);
  plan.teacher_strategy = strategy;
  plan.teacher_preview = preview.rows;
  plan.teacher_warnings = preview.warnings;
  // Changes to averages, overrides, rosters or assignments require a fresh review.
  plan.review_token = createHash('sha256').update(JSON.stringify({ moves: plan.moves, creates: plan.creates, strategy, preview, teachers: ctx.teachers, classes: ctx.classes })).digest('hex');
  return plan;
}

// --------------------------------------------------------------------- views

const refView = (d) => d && {
  key: d.key, class_id: d.class_id ?? null, name: d.name, grade: d.grade, stream: d.stream, year: d.year, level: d.level, exists: d.exists,
};

function planView(plan, run) {
  return {
    from_year: plan.from_year,
    to_year: plan.to_year,
    levels: plan.levels,
    review_token: plan.review_token,
    teacher_strategy: plan.teacher_strategy,
    teacher_preview: plan.teacher_preview,
    teacher_warnings: plan.teacher_warnings,
    final_levels: [...plan.finals].map((f) => plan.levels[f - 1]),
    blockers: plan.blockers,
    summary: plan.summary,
    choices: plan.choices.map(refView),
    classes: plan.classes.map((c) => ({
      source_class_id: c.source_class_id,
      source_name: c.source_name,
      grade: c.grade,
      stream: c.stream,
      level: c.level,
      graduating: c.graduating,
      publication_status: c.publication_status,
      class_teacher_name: c.class_teacher_name,
      inactive_count: c.inactive_count,
      active_count: c.active_count,
      destination: refView(c.destination),
      repeat_destination: refView(c.repeat_destination),
      students: c.students.map((s) => ({
        student_id: s.student_id,
        admission_no: s.admission_no,
        first_name: s.first_name,
        last_name: s.last_name,
        average: s.average, pass_mark: s.pass_mark, result_problem: s.result_problem, override_reason: s.override_reason,
        default_action: s.default_action,
        action: s.action,
        to_key: s.to_key,
        to_class_id: s.to_class_id,
        to_class_name: s.to_class_name,
        overridden: s.overridden,
      })),
    })),
    run,
  };
}

// Who overrode or undid something is stored by id and, since this fix, by name as it was at the
// time. Older records have only the id: their name is looked up from the current staff list.
async function withActorNames(schoolId, run, decisions) {
  const missing = (run.reverted_by && !run.reverted_by_name) || decisions.some((d) => d.overridden_by && !d.overridden_by_name);
  const names = missing ? await platform.teacherNames(schoolId) : new Map();
  const nameOf = (id, saved) => saved ?? (id ? names.get(id) ?? null : null);
  return {
    decisions: decisions.map((d) => ({ ...d, overridden_by_name: nameOf(d.overridden_by, d.overridden_by_name) })),
    reverted_by_name: nameOf(run.reverted_by, run.reverted_by_name),
  };
}

async function runView(schoolId, run) {
  if (!run) return null;
  const reason = run.status === repo.RUN_STATUS.APPLIED ? await revertBlockedReason(schoolId, run) : null;
  const named = await withActorNames(schoolId, run, await repo.listMoves(schoolId, run.run_id));
  return {
    run_id: run.run_id,
    from_year: run.from_year,
    to_year: run.to_year,
    status: run.status,
    teacher_strategy: run.teacher_strategy ?? (run.copy_teachers ? 'FOLLOW' : 'MANUAL'),
    decisions: named.decisions,
    copy_teachers: Boolean(run.copy_teachers),
    summary: run.summary,
    skipped: run.skipped || [],
    skipped_teachers: run.skipped_teachers || [],
    interventions_stopped: run.interventions_stopped ?? 0,
    created_by_name: run.created_by_name ?? null,
    created_at: run.created_at ?? null,
    applied_at: run.applied_at ?? null,
    reverted_at: run.reverted_at ?? null,
    reverted_by: run.reverted_by ?? null,
    reverted_by_name: named.reverted_by_name,
    can_revert: run.status === repo.RUN_STATUS.APPLIED && !reason,
    revert_blocked_reason: reason,
  };
}

// --------------------------------------------------------------------- reads

export async function planPromotion(actor, input) {
  const { school_id, from_year } = input;
  assertAdmin(actor);
  const fromYear = yearOf(from_year);
  const [ctx, lock] = await Promise.all([context(school_id, fromYear), repo.getLock(school_id, fromYear)]);
  const run = lock && lock.status !== repo.RUN_STATUS.REVERTED ? await repo.getRun(school_id, lock.run_id) : null;
  return planView(planFor(ctx, fromYear, input), await runView(school_id, run));
}

export async function getPromotionRun(actor, { school_id, run_id }) {
  assertAdmin(actor);
  const run = await repo.getRun(school_id, run_id);
  if (!run) throw notFound('Promotion not found');
  return runView(school_id, run);
}

export async function listPromotionRuns(actor, { school_id }) {
  assertAdmin(actor);
  const runs = await repo.listRuns(school_id);
  return Promise.all(runs.map((r) => runView(school_id, r)));
}

/** Graduates and students who left or were deactivated: read-only records, administrators only. */
export async function listPastStudents(actor, { school_id, year }) {
  assertAdmin(actor);
  const [students, classes] = await Promise.all([repo.listAllStudents(school_id), platform.listClasses(school_id)]);
  const byId = new Map(classes.map((c) => [c.class_id, c]));
  const wanted = year == null ? null : Number(year);
  return students
    .filter((s) => (s.status || STUDENT_STATUS.ACTIVE) !== STUDENT_STATUS.ACTIVE)
    .filter((s) => wanted == null || Number(s.graduation_year) === wanted || Number(s.left_year) === wanted)
    .map((s) => {
      const c = byId.get(s.class_id);
      return {
        student_id: s.student_id,
        admission_no: s.admission_no,
        first_name: s.first_name,
        last_name: s.last_name,
        status: s.status,
        graduation_year: s.graduation_year ?? null,
        left_year: s.left_year ?? null,
        departure_kind: s.departure_kind ?? null, deactivation_reason: s.deactivation_reason ?? null, deactivation_date: s.deactivation_date ?? null,
        class_id: s.class_id ?? null,
        class_name: c ? `${c.name} ${c.year ?? ''}`.trim() : null,
      };
    })
    .sort((a, b) => (b.graduation_year ?? b.left_year ?? 0) - (a.graduation_year ?? a.left_year ?? 0)
      || String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
}

// ------------------------------------------------------------------- apply

export async function applyPromotion(actor, input) {
  assertAdmin(actor);
  const schoolId = input.school_id;
  const fromYear = yearOf(input.from_year);
  const key = String(input.idempotency_key || '').trim();
  if (!/^[0-9A-Za-z_-]{10,64}$/.test(key)) throw validation('idempotency_key must be the id the client generated', 'idempotency_key');

  const settled = await settledByLock(schoolId, fromYear, key, actor);
  if (settled) return settled;

  const ctx = await context(schoolId, fromYear);
  const plan = planFor(ctx, fromYear, input);
  if (plan.blockers.length) {
    const more = plan.blockers.length > 1 ? ` (and ${plan.blockers.length - 1} more)` : '';
    throw validation(`${plan.blockers[0].message}${more}`, 'from_year');
  }

  if (!input.review_token || input.review_token !== plan.review_token) throw conflict('The promotion plan has changed or has not been reviewed. Refresh the plan and confirm the latest decisions.');

  const runId = `prm_${ulid().toLowerCase()}`;
  const newIds = new Map(plan.creates.map((d) => [d.key, `cls_${ulid().toLowerCase()}`]));
  const choice = new Map(plan.choices.map((c) => [c.key, c]));
  const classIdOf = (k) => choice.get(k)?.class_id ?? newIds.get(k) ?? null;

  const mainDestination = new Map();
  for (const c of plan.classes) {
    const id = c.destination ? classIdOf(c.destination.key) : null;
    if (id) mainDestination.set(c.source_class_id, id);
  }
  const sourceIds = new Set(plan.classes.map((c) => c.source_class_id));
  const existingDest = new Map(ctx.classes.filter((c) => Number(c.year) === plan.to_year).map((c) => [c.class_id, c]));
  const previewById = new Map(plan.teacher_preview.map((t) => [t.teacher_id, t]));
  const changes = ctx.teachers.filter((t) => previewById.has(t.teacher_id)).map((t) => {
    const preview = previewById.get(t.teacher_id);
    const before = { assignments: t.assignments || [], class_teacher_of: t.class_teacher_of || null, historical_class_teacher_of: t.historical_class_teacher_of || [], _version: t._version ?? 1 };
    const assignments = [...before.assignments];
    for (const a of preview.assignments) {
      const id = classIdOf(a.key);
      if (id && !assignments.some((x) => x.class_id === id && x.subject === a.subject)) assignments.push({ class_id: id, subject: a.subject });
    }
    const history = [...new Set([...before.historical_class_teacher_of, ...(sourceIds.has(before.class_teacher_of) ? [before.class_teacher_of] : [])])];
    return { teacher_id: t.teacher_id, before, after: { assignments, historical_class_teacher_of: history, class_teacher_of: sourceIds.has(before.class_teacher_of) ? classIdOf(preview.class_key) : before.class_teacher_of } };
  });
  const teacherFor = new Map(changes.filter((c) => c.after.class_teacher_of && c.after.class_teacher_of !== c.before.class_teacher_of)
    .map((c) => [c.after.class_teacher_of, c.teacher_id]));

  const sourceOf = new Map([...mainDestination].map(([s, d]) => [d, s]));
  const moves = plan.moves.map((m) => ({ ...m, overridden_by: m.overridden ? actor.sub : null, overridden_by_name: m.overridden ? actor.name ?? null : null, to_class_id: m.to_key ? classIdOf(m.to_key) : null, from_year: fromYear }));
  const run = {
    run_id: runId,
    from_year: fromYear,
    to_year: plan.to_year,
    status: repo.RUN_STATUS.APPLYING,
    pending_claim: true,
    idempotency_key: key,
    teacher_strategy: plan.teacher_strategy,
    copy_teachers: plan.teacher_strategy !== 'MANUAL',
    summary: plan.summary,
    sources: plan.classes.map((c) => ({
      class_id: c.source_class_id, name: c.source_name, class_teacher_id: c.class_teacher_id,
      promoted_to_class_id: mainDestination.get(c.source_class_id) ?? null,
    })),
    creates: plan.creates.map((d) => {
      const id = newIds.get(d.key);
      const from = sourceOf.get(id) ?? moves.find((m) => m.to_class_id === id)?.from_class_id ?? null;
      return { class_id: id, key: d.key, name: d.name, grade: d.grade, stream: d.stream, level: d.level, year: d.year, promoted_from_class_id: from, class_teacher_id: teacherFor.get(id) ?? null };
    }),
    destinations: [...new Set([...moves.map((m) => m.to_class_id), ...plan.creates.map((d) => classIdOf(d.key))].filter(Boolean))],
    dest_teacher_sets: [...teacherFor].filter(([classId]) => existingDest.has(classId)).map(([class_id, teacher_id]) => ({ class_id, teacher_id })),
    teachers: changes,
    skipped: [],
    created_by: actor.sub,
    created_by_name: actor.name ?? null,
    created_at: new Date().toISOString(),
  };

  await repo.saveRun(schoolId, run, moves);
  if (!(await repo.claimLock(schoolId, fromYear, run))) {
    const again = await settledByLock(schoolId, fromYear, key, actor);
    if (again) return again;
    throw conflict(`Another promotion of ${fromYear} has just started. Reload the page.`);
  }
  log({ msg: 'promotion started', run_id: runId, from_year: fromYear, moves: moves.length });
  return runView(schoolId, await execute(schoolId, run, actor));
}

/** A year already promoted (or being promoted): the same request again returns it; an interrupted one is finished. */
async function settledByLock(schoolId, fromYear, key, actor) {
  const lock = await repo.getLock(schoolId, fromYear);
  if (!lock || lock.status === repo.RUN_STATUS.REVERTED) return null;
  const run = await repo.getRun(schoolId, lock.run_id);
  if (!run) throw conflict('This promotion has no complete stored decision snapshot. Contact an administrator before retrying.');
  if (lock.status === repo.RUN_STATUS.APPLYING) {
    log({ msg: 'finishing an interrupted promotion', run_id: run.run_id });
    return runView(schoolId, await execute(schoolId, run, actor));
  }
  if (lock.idempotency_key === key) return runView(schoolId, run);
  throw conflict(`${fromYear} has already been promoted. Undo that promotion first if it needs to be done again.`);
}

/**
 * Carries out a stored run. Every step is repeatable, so an interrupted run is
 * finished by calling this again. Teachers go first, so a class is only given
 * a class teacher whose own record was updated to match.
 */
async function execute(schoolId, run, actor) {
  const moves = await repo.listMoves(schoolId, run.run_id);

  const teacherApplied = new Set();
  const skippedTeachers = [];
  for (const change of run.teachers || []) {
    if (await repo.applyTeacherChange(schoolId, change, run.run_id)) teacherApplied.add(change.teacher_id);
    else skippedTeachers.push(change.teacher_id);
  }

  for (const c of run.creates || []) {
    const teacherId = c.class_teacher_id && teacherApplied.has(c.class_teacher_id) ? c.class_teacher_id : null;
    const outcome = await repo.createClassForRun(schoolId, { ...c, class_teacher_id: teacherId }, run.run_id, actor);
    if (outcome === 'SKIPPED') throw conflict(`Class ${c.name} ${c.year} could not be created. Reload and try again.`);
  }
  for (const s of run.dest_teacher_sets || []) {
    if (teacherApplied.has(s.teacher_id)) await repo.setClassTeacherForRun(schoolId, s.class_id, s.teacher_id, run.run_id);
  }

  const outcomes = await repo.eachLimited(moves, 8, (m) => repo.applyMove(schoolId, m, run, actor));
  const skipped = [];
  const leftBySource = new Map();
  moves.forEach((m, i) => {
    const o = outcomes[i];
    if (o.outcome === 'SKIPPED') {
      skipped.push({ student_id: m.student_id, name: m.name, reason: o.reason });
      return;
    }
    if (!leftBySource.has(m.from_class_id)) leftBySource.set(m.from_class_id, new Set());
    leftBySource.get(m.from_class_id).add(m.student_id);
  });

  const today = todayIn(zone());
  let stopped = 0;
  for (const [classId, ids] of leftBySource) {
    stopped += await repo.stopInterventionsForRun(schoolId, classId, ids, run.run_id, actor, today);
  }

  for (const source of run.sources || []) await repo.archiveClassForRun(schoolId, source, run.run_id);

  const names = new Map((await platform.listTeachers(schoolId)).map((t) => [t.teacher_id, fullName(t)]));
  const applied = await repo.updateRun(schoolId, run.run_id, {
    status: repo.RUN_STATUS.APPLIED,
    pending_claim: false,
    applied_at: run.applied_at || new Date().toISOString(),
    skipped,
    skipped_teachers: skippedTeachers.map((id) => names.get(id) || id),
    interventions_stopped: (run.interventions_stopped ?? 0) + stopped,
  });
  await repo.setLockStatus(schoolId, run.from_year, run.run_id, repo.RUN_STATUS.APPLIED);
  log({ msg: 'promotion applied', run_id: run.run_id, skipped: skipped.length, interventions_stopped: stopped });
  await announce(schoolId, applied, moves);
  return applied;
}

/** For other modules (a future Alumni Tracker). Best effort: the promotion has already happened. */
async function announce(schoolId, run, moves) {
  try {
    await emit({
      source: 'csg.gradebook',
      detail_type: 'StudentsPromoted',
      detail: { school_id: schoolId, run_id: run.run_id, from_year: run.from_year, to_year: run.to_year, summary: run.summary },
    });
    const graduated = moves.filter((m) => m.action === ACTION.GRADUATE).map((m) => m.student_id);
    if (graduated.length) {
      await emit({
        source: 'csg.gradebook',
        detail_type: 'StudentsGraduated',
        detail: { school_id: schoolId, run_id: run.run_id, graduation_year: run.from_year, student_ids: graduated },
      });
    }
  } catch (e) {
    log({ level: 'warn', msg: 'could not announce the promotion', err: e.message });
  }
}

// ------------------------------------------------------------------ revert

/**
 * Undo is allowed only until the new year has its own records in the classes
 * the promotion filled: after that, moving students back would separate them
 * from marks, attendance or interventions recorded against the new class.
 */
async function revertBlockedReason(schoolId, run) {
  const classes = new Map((await platform.listClasses(schoolId)).map((c) => [c.class_id, c]));
  const label = (id) => { const c = classes.get(id); return c ? `${c.name} ${c.year ?? ''}`.trim() : 'A new class'; };
  for (const id of run.destinations || []) {
    if (await school.classHasAssessments(schoolId, id)) return `${label(id)} already has assessments, so the promotion can no longer be undone.`;
    if ((await interventions.listForClass(schoolId, id)).some((i) => !i.stopped_by_promotion)) {
      return `${label(id)} already has interventions, so the promotion can no longer be undone.`;
    }
  }
  const dest = new Set(run.destinations || []);
  const terms = (await platform.listTerms(schoolId)).filter((t) => Number(t.academic_year) === Number(run.to_year));
  for (const t of terms) {
    for (const period of ['MIDTERM', 'ENDTERM']) {
      const entries = await attendance.listPeriod(schoolId, t.term_id, period);
      const hit = entries.find((e) => dest.has(e.class_id));
      if (hit) return `${label(hit.class_id)} already has attendance for ${run.to_year}, so the promotion can no longer be undone.`;
    }
  }
  return null;
}

export async function revertPromotion(actor, { school_id, run_id }) {
  assertAdmin(actor);
  const run = await repo.getRun(school_id, run_id);
  if (!run) throw notFound('Promotion not found');
  if (run.status === repo.RUN_STATUS.REVERTED) return runView(school_id, run);
  if (run.status !== repo.RUN_STATUS.APPLIED) throw validation('This promotion is still being applied. Try again in a moment.', 'run_id');
  const reason = await revertBlockedReason(school_id, run);
  if (reason) throw validation(reason, 'run_id');

  const moves = await repo.listMoves(school_id, run.run_id);
  const outcomes = await repo.eachLimited(moves, 8, (m) => repo.revertMove(school_id, m, run, actor));
  const skipped = moves
    .map((m, i) => (outcomes[i].outcome === 'SKIPPED' ? { student_id: m.student_id, name: m.name, reason: outcomes[i].reason } : null))
    .filter(Boolean);

  for (const source of run.sources || []) {
    await repo.restartInterventionsForRun(school_id, source.class_id, run.run_id, actor);
    await repo.restoreClassForRun(school_id, source, run.run_id);
  }
  for (const change of run.teachers || []) await repo.revertTeacherChange(school_id, change, run.run_id);
  for (const s of run.dest_teacher_sets || []) await repo.clearClassTeacherForRun(school_id, s.class_id, run.run_id);

  const kept = [];
  for (const c of run.creates || []) {
    const left = await platform.listStudents(school_id, c.class_id, { includeInactive: true });
    if (left.length || !(await repo.deleteClassForRun(school_id, c.class_id, run.run_id))) {
      await repo.clearClassTeacherForRun(school_id, c.class_id, run.run_id);
      kept.push(`${c.name} ${c.year}`);
    }
  }

  const reverted = await repo.updateRun(school_id, run.run_id, {
    status: repo.RUN_STATUS.REVERTED,
    reverted_at: new Date().toISOString(),
    reverted_by: actor.sub,
    reverted_by_name: actor.name ?? null,
    revert_skipped: skipped,
    classes_kept: kept,
  });
  await repo.setLockStatus(school_id, run.from_year, run.run_id, repo.RUN_STATUS.REVERTED);
  log({ msg: 'promotion undone', run_id: run.run_id, skipped: skipped.length, classes_kept: kept.length });
  return runView(school_id, reverted);
}
