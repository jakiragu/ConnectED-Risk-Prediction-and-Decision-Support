import {
  assertTenant,
  assertClassRead,
  assertClassTeacherOrAdmin,
  assertCanPublish,
  assertGradebookRole,
  canReviewResults,
  assertAdmin,
  isAdmin,
  isClassTeacherOf,
  subjectsITeach,
  readableClassIds,
  visibleSubjects,
} from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, s3 } from '../../library/client.js';
import { TABLE, pk, sk } from '../../library/keys.js';
import { validation, notFound, locked, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import {
  calculateCheckpoint,
  checkpointWeightProblems,
  resultsPublishedEvent,
  CHECKPOINT,
  CHECKPOINTS,
  assessmentCheckpoint,
  labelOf,
  previousOf,
  SEVERITY,
  kindOf,
} from '../../library/results.js';
import { labelsOf, openerEnabledFor } from '../../library/assessmentConfig.js';
import * as assessmentConfig from '../../library/assessmentConfigRepo.js';
import { emit } from '../../library/events.js';
import { startReportCards, executionName } from '../../library/workflow.js';
import * as results from '../../library/resultsRepo.js';
import * as assessments from '../../library/assessmentRepo.js';
import * as scores from '../../library/scoreRepo.js';
import * as platform from '../../library/platformRepo.js';
import * as history from '../../library/historyRepo.js';
import * as gradingStore from '../../library/gradingRepo.js';
import * as riskStore from '../../library/riskRepo.js';
import * as interventionStore from '../../library/interventionRepo.js';
import * as attendanceStore from '../../library/attendanceRepo.js';
import { normaliseGrading } from '../../library/grading.js';
import {
  buildClassProfile, examMean, examValue, rangeCounts, riskSeries, topFactors, interventionMethods, RANGES,
} from '../../library/classProfile.js';
import { riskScope, checkpointPoint } from '../../library/decisionSupport.js';
import { attendancePeriods } from '../../library/calendar.js';
import { periodSummary } from '../../library/attendance.js';
import { previewResultsSms, sendResultsSms, smsColumns } from './sms.js';

export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;

  switch (event.info.fieldName) {
    case 'calculateTermResults':
      return calculateTermResults(actor, input);
    case 'calculateSchoolResults':
      return forClasses(actor, input, (classId) => calculateTermResults(actor, { ...input, class_id: classId }));
    case 'publishResults':
      return publishResults(actor, input);
    case 'publishSchoolResults':
      return forClasses(actor, { ...input, class_ids: (input.classes || []).map((c) => c.class_id) }, (classId) =>
        publishResults(actor, { ...input, class_id: classId, _version: input.classes.find((c) => c.class_id === classId)._version })
      );
    case 'listResultSets':
      return listResultSets(actor, args);
    case 'listCheckpointStatus':
      return listCheckpointStatus(actor, args);
    case 'getTermResults':
      return getTermResults(actor, args);
    case 'getGradeRule':
      return getGradeRule(actor, args);
    case 'setCheckpointWeights':
      return setCheckpointWeights(actor, input);
    case 'getGradingPolicy':
      return getGradingPolicy(actor, args);
    case 'saveGradingPolicy':
      return saveGradingPolicy(actor, input);
    case 'setTermGrading':
      return setTermGrading(actor, input);
    case 'getGradingPreview':
      return getGradingPreview(actor, args);
    case 'getClassProfile':
      return getClassProfile(actor, args);
    case 'listReportCards':
      return listReportCards(actor, args);
    case 'requestReportCardDownload':
      return requestReportCardDownload(actor, input);
    case 'previewResultsSms':
      return previewResultsSms(actor, args);
    case 'sendResultsSms':
      return sendResultsSms(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const TERM_LOCKED = 'End of term results for this class are published, so the term is locked';
const ALREADY_PUBLISHED = 'These results are already published. Correcting published results is not available yet.';
const STALE = 'These results were recalculated after you opened them. Review the latest calculation and try again.';
const MARKS_MOVED = 'Marks or papers changed after these results were calculated. Recalculate and review again.';
const STALE_PUBLISHED = 'These results were published from a different calculation than the one you reviewed.';
const WEIGHTS_MOVED = 'Checkpoint weights changed after these results were calculated. Recalculate and review again.';
const WEIGHTS_LOCKED = 'End of term results are published for this term, so checkpoint weights can no longer change.';
const GRADING_MOVED = 'The grading rules for this term changed after these results were calculated. Recalculate and review again.';
const GRADING_LOCKED = 'Results are already published this term, so its grading rules are fixed. Changes to the school default apply to later terms.';
const SETUP_MOVED = 'Whether this term holds an Opener changed after these results were calculated. Recalculate and review again.';
const notYet = (checkpoint, openerEnabled, labels) =>
  `${labelOf(previousOf(checkpoint, openerEnabled), labels)} results must be published before ${labelOf(checkpoint, labels)} results`;

/**
 * How this term is set up: its grading rule, whether it holds an Opener (the
 * term's own setting, else the school default) and the school's checkpoint names.
 */
async function termSetup(schoolId, termId) {
  const [rule, config] = await Promise.all([platform.gradeRule(schoolId, termId), assessmentConfig.get(schoolId)]);
  return { rule, config, openerEnabled: openerEnabledFor(rule, config), labels: labelsOf(config) };
}

/**
 * Why the term's Opener setting cannot change to `enable`, or null. Adding an
 * Opener after Mid-term results are out would break the publication order;
 * removing one whose results are out would orphan them.
 */
async function openerChangeBlocked(schoolId, termId, enable, labels) {
  const sets = await results.listSetsForTerm(schoolId, termId);
  const published = (c) => sets.some((x) => x.checkpoint === c && x.status === results.STATUS.PUBLISHED);
  if (enable && (published(CHECKPOINT.MIDTERM) || published(CHECKPOINT.ENDTERM))) {
    return `${labelOf(CHECKPOINT.MIDTERM, labels)} results are already published this term, ` +
      `so the ${labelOf(CHECKPOINT.OPENER, labels)} can no longer be added.`;
  }
  if (!enable && published(CHECKPOINT.OPENER)) {
    return `${labelOf(CHECKPOINT.OPENER, labels)} results are already published this term, so it can no longer be removed.`;
  }
  return null;
}

const log = (o) => console.log(JSON.stringify({ level: 'info', svc: 'results-service', ...o }));

function scopeOf(input) {
  const checkpoint = input.checkpoint;
  if (!CHECKPOINTS.includes(checkpoint)) throw validation(`Checkpoint must be one of ${CHECKPOINTS.join(', ')}`, 'checkpoint');
  if (!input.class_id) throw validation('Choose a class', 'class_id');
  if (!input.term_id) throw validation('Choose a term', 'term_id');
  return { termId: input.term_id, classId: input.class_id, checkpoint };
}

async function requireTerm(schoolId, termId) {
  if (!termId || !(await platform.term(schoolId, termId))) throw notFound('Term not found');
}

async function requireClass(actor, schoolId, classId) {
  if (!(await platform.klass(schoolId, classId))) throw notFound('Class not found');
  assertClassRead(actor, classId);
}

/** A subject teacher sees only their subjects; the class teacher and administrators see all. */
function subjectsFor(actor, classId, subjects) {
  const visible = visibleSubjects(actor, classId);
  return visible === null ? subjects : subjects.filter((s) => visible.has(s));
}

const reportCount = (set) => (set.report_cards_done ? [...set.report_cards_done].length : 0);

/** The GraphQL view of a result set. Teachers only ever see published sets. */
function view(set, scope, schoolId, actor) {
  const base = {
    school_id: schoolId, class_id: scope.classId, term_id: scope.termId, checkpoint: scope.checkpoint,
    kind: kindOf(scope.checkpoint), subjects: [], issues: [], blocking: false, assessment_count: 0, student_count: 0,
    report_cards_generated: 0, report_cards_expected: 0,
  };
  if (!set) return { ...base, status: 'NOT_CALCULATED' };
  const reviewer = canReviewResults(actor);
  const published = set.status === results.STATUS.PUBLISHED;
  if (!reviewer && !published) return { ...base, status: 'UNPUBLISHED' };
  return {
    ...base,
    status: set.status,
    calculation_id: set.calculation_id,
    subjects: subjectsFor(actor, scope.classId, set.subjects || []),
    assessment_count: (set.basis || []).length,
    student_count: (set.student_ids || []).length,
    blocking: Boolean(set.blocking),
    issues: reviewer ? set.issues || [] : [],
    calculated_at: set.calculated_at,
    calculated_by: set.calculated_by,
    published_at: set.published_at ?? null,
    published_by: set.published_by ?? null,
    event_status: reviewer ? set.event_status ?? null : null,
    report_cards_status: published ? set.report_cards_status ?? null : null,
    report_cards_generated: published ? reportCount(set) : 0,
    report_cards_expected: published ? set.report_cards_expected ?? (set.student_ids || []).length : 0,
    report_error: reviewer ? set.report_error ?? null : null,
    checkpoint_weights: set.basis_checkpoint_weights ?? null,
    _version: set._version,
  };
}

/** Rows of a published checkpoint, by student, for the End of term combination. */
async function publishedRows(schoolId, scope, checkpoint) {
  const set = await results.getSet(schoolId, { ...scope, checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) return null;
  return { set, rows: new Map((await results.listRows(schoolId, set)).map((r) => [r.student_id, r])) };
}

async function calculateTermResults(actor, input) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  const scope = scopeOf(input);
  const schoolId = input.school_id;
  await requireTerm(schoolId, scope.termId);
  await requireClass(actor, schoolId, scope.classId);

  if (await assessments.termLocked(schoolId, scope.termId, scope.classId)) throw locked(TERM_LOCKED);
  const existing = await results.getSet(schoolId, scope);
  if (existing?.status === results.STATUS.PUBLISHED) throw locked(ALREADY_PUBLISHED);

  const [live, roster, setup] = await Promise.all([
    assessments.listAllLive(schoolId, scope.classId, scope.termId),
    platform.roster(schoolId, scope.classId),
    termSetup(schoolId, scope.termId),
  ]);
  const { rule: gradeRule, openerEnabled, labels } = setup;
  const scoresByAssessment = new Map(
    await Promise.all(
      live.filter((a) => assessmentCheckpoint(a.assessment_type) === scope.checkpoint)
        .map(async (a) => [a.assessment_id, await scores.listByAssessment(schoolId, a.assessment_id)])
    )
  );

  const previous = previousOf(scope.checkpoint, openerEnabled);
  const prior = previous ? await publishedRows(schoolId, scope, previous) : null;
  const previousRows = {};
  // The setup this result is calculated under, kept with it: publication checks it and report cards print it.
  const extra = {
    basis_opener_enabled: openerEnabled,
    basis_labels: labels,
    basis_grading_version: gradeRule?.grading_version ?? 0,
  };
  if (scope.checkpoint === CHECKPOINT.ENDTERM) {
    const opener = openerEnabled ? await publishedRows(schoolId, scope, CHECKPOINT.OPENER) : null;
    if (opener) previousRows.OPENER = opener.rows;
    if (prior) previousRows.MIDTERM = prior.rows;
    extra.basis_previous = { OPENER: opener?.set.calculation_id ?? null, MIDTERM: prior?.set.calculation_id ?? null };
    extra.basis_checkpoint_weights = gradeRule?.checkpoint_weights ?? null;
    extra.basis_weights_version = gradeRule?.checkpoint_weights_version ?? 0;
  }

  const calc = calculateCheckpoint({
    checkpoint: scope.checkpoint,
    assessments: live,
    scoresByAssessment,
    roster,
    gradeRule,
    previousPublished: Boolean(prior),
    previousRows,
    openerEnabled,
    labels,
  });

  let saved;
  try {
    saved = await results.saveCalculation(schoolId, scope, { calculationId: ulid(), calc, existing, actor, extra });
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (assessments.cancelledAt(e, 1)) throw locked(TERM_LOCKED);
    throw conflict('Someone else recalculated these results at the same time. Reload and try again.');
  }
  if (existing) await results.dropRows(schoolId, existing).catch((e) => log({ msg: 'drop rows failed', err: e.message }));
  log({ op: 'calculate', ...scope, students: calc.rows.length, blocking: calc.blocking, version: saved._version });
  return view(saved, scope, schoolId, actor);
}

/** At-least-once ResultsPublished. A failure never undoes the publication. */
async function ensureEvent(schoolId, set) {
  if (set.event_status === results.EVENT_STATUS.SENT) return set;
  try {
    await emit(resultsPublishedEvent(set));
    return await results.markEventSent(schoolId, set);
  } catch (e) {
    log({ level: 'error', msg: 'ResultsPublished not delivered; publish again to resend', event_id: set.event_id, err: e.message });
    return set;
  }
}

/** Starts (or restarts after failure) the report-card workflow for a published set. */
async function ensureReports(schoolId, set) {
  let current = set;
  if (current.report_cards_status === results.REPORTS.FAILED) current = await results.retryReports(schoolId, current);
  if (current.report_cards_status !== results.REPORTS.PENDING) return current;
  try {
    const { executionArn } = await startReportCards(
      executionName('rc', current.calculation_id, `a${current.report_attempt}`),
      {
        school_id: current.school_id,
        class_id: current.class_id,
        term_id: current.term_id,
        checkpoint: current.checkpoint,
        calculation_id: current.calculation_id,
        student_ids: current.student_ids || [],
      }
    );
    return await results.markReportsRunning(schoolId, current, executionArn);
  } catch (e) {
    log({ level: 'error', msg: 'Report cards not started; publish again to retry', set: current.SK, err: e.message });
    return current;
  }
}

/**
 * Copies the published rows into each student's history (historyRepo). Runs
 * before ResultsPublished is sent, because consumers of the event read the
 * history. Idempotent; a failure is retried by publishing again.
 */
async function ensureHistory(schoolId, set) {
  if (history.historyWritten(set)) return { set, ok: true };
  try {
    const [rows, term] = await Promise.all([results.listRows(schoolId, set), platform.term(schoolId, set.term_id)]);
    await history.writeHistory(schoolId, set, rows, term);
    return { set: await history.markHistoryWritten(schoolId, set), ok: true };
  } catch (e) {
    log({ level: 'error', msg: 'Student history not written; publish again to retry', set: set.SK, err: e.message });
    return { set, ok: false };
  }
}

async function afterPublish(schoolId, set) {
  const recorded = await ensureHistory(schoolId, set);
  // The event tells consumers the history is there, so it waits for it; report cards do not.
  const withEvent = recorded.ok ? await ensureEvent(schoolId, recorded.set) : recorded.set;
  return ensureReports(schoolId, withEvent);
}

async function publishResults(actor, input) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  const scope = scopeOf(input);
  const schoolId = input.school_id;
  await requireClass(actor, schoolId, scope.classId);

  const set = await results.getSet(schoolId, scope);
  const { rule, openerEnabled, labels } = await termSetup(schoolId, scope.termId);
  if (!set) throw notFound(`Calculate the ${labelOf(scope.checkpoint, labels)} results before publishing them`);

  if (set.status === results.STATUS.PUBLISHED) {
    if (input._version !== set.published_from_version) throw conflict(STALE_PUBLISHED);
    return view(await afterPublish(schoolId, set), scope, schoolId, actor); // retry: same outcome, resumes side effects
  }
  if (input._version !== set._version) throw conflict(STALE);
  if (set.blocking) {
    const first = set.issues.find((i) => i.severity === SEVERITY.BLOCKING);
    throw validation(`Cannot publish: ${first?.message || 'the calculation has blocking problems'}`, 'checkpoint');
  }
  if ((set.basis_opener_enabled ?? true) !== openerEnabled) throw conflict(SETUP_MOVED);
  if ((rule?.grading_version ?? 0) !== (set.basis_grading_version ?? 0)) throw conflict(GRADING_MOVED);
  const previous = previousOf(scope.checkpoint, openerEnabled);
  if (previous && (await results.getSet(schoolId, { ...scope, checkpoint: previous }))?.status !== results.STATUS.PUBLISHED) {
    throw validation(notYet(scope.checkpoint, openerEnabled, labels), 'checkpoint');
  }
  if (scope.checkpoint === CHECKPOINT.ENDTERM) {
    const weightProblems = checkpointWeightProblems(rule?.checkpoint_weights, { openerEnabled, labels });
    if (weightProblems.length) {
      throw validation(`Cannot publish: ${weightProblems[0]}`, 'checkpoint');
    }
    if ((rule.checkpoint_weights_version ?? 0) !== set.basis_weights_version) throw conflict(WEIGHTS_MOVED);
  }
  if (set.basis.length > results.MAX_PUBLISH_PAPERS) {
    throw validation(`At most ${results.MAX_PUBLISH_PAPERS} papers can be published together`, 'checkpoint');
  }

  let published;
  try {
    published = await results.publish(schoolId, set, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    const failed = (name) => assessments.cancelledAt(e, e.publishIndex[name]);
    if (failed('set')) {
      const fresh = await results.getSet(schoolId, scope);
      if (fresh?.status === results.STATUS.PUBLISHED && fresh.published_from_version === input._version) {
        return view(await afterPublish(schoolId, fresh), scope, schoolId, actor); // a concurrent retry won
      }
      throw conflict(STALE);
    }
    if (failed('gate')) throw locked(TERM_LOCKED);
    if (e.publishIndex.previous !== undefined && failed('previous')) {
      throw validation(notYet(scope.checkpoint, set.basis_opener_enabled ?? true, labels), 'checkpoint');
    }
    if (e.publishIndex.weights !== undefined && failed('weights')) throw conflict(WEIGHTS_MOVED);
    if ((e.CancellationReasons || []).slice(e.publishIndex.papers).some((r) => r?.Code === 'ConditionalCheckFailed')) {
      throw conflict(MARKS_MOVED);
    }
    throw e;
  }
  log({ op: 'publish', ...scope, version: published._version, event_id: published.event_id });
  return view(await afterPublish(schoolId, published), scope, schoolId, actor);
}

async function forClasses(actor, input, run) {
  assertTenant(actor, input.school_id);
  assertCanPublish(actor);
  if (!CHECKPOINTS.includes(input.checkpoint)) throw validation('Choose a checkpoint', 'checkpoint');
  await requireTerm(input.school_id, input.term_id);
  const classes = await platform.listClasses(input.school_id);
  const wanted = input.class_ids?.length ? input.class_ids : classes.map((c) => c.class_id);
  const byId = new Map(classes.map((c) => [c.class_id, c]));

  const outcomes = [];
  for (const classId of [...new Set(wanted)]) {
    const klass = byId.get(classId);
    try {
      if (!klass) throw notFound('Class not found');
      const set = await run(classId);
      outcomes.push({ class_id: classId, class_name: klass.name, ok: true, error_type: null, message: null, result_set: set });
    } catch (e) {
      if (!e.type) throw e; // infrastructure failure: surface it rather than hide it per class
      const current = klass ? await results.getSet(input.school_id, { termId: input.term_id, classId, checkpoint: input.checkpoint }) : null;
      outcomes.push({
        class_id: classId,
        class_name: klass?.name ?? classId,
        ok: false,
        error_type: e.type,
        message: e.message,
        result_set: klass ? view(current, { termId: input.term_id, classId, checkpoint: input.checkpoint }, input.school_id, actor) : null,
      });
    }
  }
  return outcomes;
}

async function listResultSets(actor, { school_id, class_id, term_id }) {
  assertTenant(actor, school_id);
  await requireClass(actor, school_id, class_id);
  const sets = await results.listSetsForClass(school_id, { termId: term_id, classId: class_id });
  const byCheckpoint = new Map(sets.map((s) => [s.checkpoint, s]));
  return CHECKPOINTS.map((checkpoint) =>
    view(byCheckpoint.get(checkpoint) || null, { termId: term_id, classId: class_id, checkpoint }, school_id, actor)
  );
}

/** One checkpoint across every class the actor may see: the school-wide publishing list. */
async function listCheckpointStatus(actor, { school_id, term_id, checkpoint }) {
  assertTenant(actor, school_id);
  assertGradebookRole(actor);
  if (!CHECKPOINTS.includes(checkpoint)) throw validation('Choose a checkpoint', 'checkpoint');
  let classes = await platform.listClasses(school_id);
  if (!canReviewResults(actor)) {
    const mine = readableClassIds(actor);
    classes = classes.filter((c) => mine.has(c.class_id));
  }
  const sets = await results.listSetsForTerm(school_id, term_id);
  const byClass = new Map(sets.filter((s) => s.checkpoint === checkpoint).map((s) => [s.class_id, s]));
  return classes.map((c) => ({
    class_id: c.class_id,
    class_name: c.name,
    result_set: view(byClass.get(c.class_id) || null, { termId: term_id, classId: c.class_id, checkpoint }, school_id, actor),
  }));
}

async function getTermResults(actor, args) {
  assertTenant(actor, args.school_id);
  const scope = scopeOf(args);
  await requireClass(actor, args.school_id, scope.classId);
  const set = await results.getSet(args.school_id, scope);
  if (!set) return [];
  const published = set.status === results.STATUS.PUBLISHED;
  if (!published && !canReviewResults(actor)) return [];
  const rows = await results.listRows(args.school_id, set);
  return rows.map((r) => ({
    term_result_id: r.term_result_id,
    school_id: r.school_id,
    class_id: r.class_id,
    term_id: r.term_id,
    student_id: r.student_id,
    checkpoint: r.checkpoint,
    kind: r.kind,
    subjects: subjectsFor(actor, scope.classId, r.subjects.map((x) => x.subject))
      .map((name) => r.subjects.find((x) => x.subject === name)),
    checkpoint_average: r.checkpoint_average,
    term_average: r.term_average,
    term_grade: r.term_grade,
    published,
    published_at: published ? set.published_at : null,
  }));
}

const weightsView = (w) => (w ? { opener: w.OPENER ?? null, midterm: w.MIDTERM ?? null, endterm: w.ENDTERM ?? null } : null);

async function finalPublishedInTerm(schoolId, termId) {
  const sets = await results.listSetsForTerm(schoolId, termId);
  return sets.some((s) => s.checkpoint === CHECKPOINT.ENDTERM && s.status === results.STATUS.PUBLISHED);
}

async function getGradeRule(actor, { school_id, term_id }) {
  assertTenant(actor, school_id);
  assertGradebookRole(actor);
  const { rule, openerEnabled, labels } = await termSetup(school_id, term_id);
  if (!rule) return null;
  return {
    term_id,
    pass_mark: rule.pass_mark ?? null,
    missing_score_policy: rule.missing_score_policy ?? null,
    bands: rule.bands || [],
    opener_enabled: openerEnabled,
    opener_locked_reason: await openerChangeBlocked(school_id, term_id, !openerEnabled, labels),
    checkpoint_weights: weightsView(rule.checkpoint_weights),
    checkpoint_weights_version: rule.checkpoint_weights_version ?? 0,
    checkpoint_weights_problems: checkpointWeightProblems(rule.checkpoint_weights, { openerEnabled, labels }),
    checkpoint_weights_locked: await finalPublishedInTerm(school_id, term_id),
    grading_version: rule.grading_version ?? 0,
    grading_locked_reason: await gradingLocked(school_id, term_id),
    grading_updated_at: rule.grading_updated_at ?? null,
    grading_updated_by_name: await teacherName(school_id, rule.grading_updated_by),
  };
}

/**
 * Sets the term's checkpoint weights and, optionally, whether it holds an
 * Opener. Weights apply to every class in the term, so only an administrator
 * may set them (Settings -> Exams and weights); the Opener cannot be added or
 * removed once results that depend on it are published.
 */
async function setCheckpointWeights(actor, input) {
  assertTenant(actor, input.school_id);
  assertAdmin(actor);
  await requireTerm(input.school_id, input.term_id);
  const { rule, openerEnabled: current, labels } = await termSetup(input.school_id, input.term_id);
  if (!rule) throw notFound('No grading rule is set for this term');

  const openerEnabled = typeof input.opener_enabled === 'boolean' ? input.opener_enabled : current;
  if (openerEnabled !== current) {
    const blocked = await openerChangeBlocked(input.school_id, input.term_id, openerEnabled, labels);
    if (blocked) throw locked(blocked);
  }

  const weights = { OPENER: Number(input.opener), MIDTERM: Number(input.midterm), ENDTERM: Number(input.endterm) };
  const problems = checkpointWeightProblems(weights, { openerEnabled, labels });
  if (problems.length) throw validation(problems[0], 'checkpoint_weights');
  if (await finalPublishedInTerm(input.school_id, input.term_id)) throw locked(WEIGHTS_LOCKED);
  try {
    await platform.setCheckpointWeights(input.school_id, input.term_id, weights, input._version ?? 0, actor, { openerEnabled });
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw conflict('Someone else changed the checkpoint weights. Reload and try again.');
  }
  return getGradeRule(actor, { school_id: input.school_id, term_id: input.term_id });
}

// ------------------------------------------------------------ report cards

const DOWNLOAD_SECONDS = 300;
const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** Report cards of a published class checkpoint. Administrators and the class's class teacher only. */
async function listReportCards(actor, args) {
  assertTenant(actor, args.school_id);
  const scope = scopeOf(args);
  if (!(await platform.klass(args.school_id, scope.classId))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, scope.classId);
  const set = await results.getSet(args.school_id, scope);
  if (set?.status !== results.STATUS.PUBLISHED) return [];

  const cards = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      FilterExpression: 'class_id = :c AND calculation_id = :k',
      ExpressionAttributeValues: {
        ':p': pk(args.school_id), ':s': sk.reportCardPrefix(scope.termId, scope.checkpoint),
        ':c': scope.classId, ':k': set.calculation_id,
      },
      ExclusiveStartKey,
    }));
    cards.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const byStudent = new Map(cards.map((c) => [c.student_id, c]));

  const students = await Promise.all((set.student_ids || []).map((id) => platform.student(args.school_id, id)));
  const sms = await smsColumns(args.school_id, set);
  return students.filter(Boolean)
    .sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }))
    .map((st) => {
      const card = byStudent.get(st.student_id);
      return {
        student_id: st.student_id,
        admission_no: st.admission_no,
        first_name: st.first_name,
        last_name: st.last_name,
        student_status: st.status || 'ACTIVE',
        checkpoint: scope.checkpoint,
        kind: card?.kind ?? null,
        available: Boolean(card),
        generated_at: card?.generated_at ?? null,
        ...sms(st),
      };
    });
}

async function requestReportCardDownload(actor, input) {
  assertTenant(actor, input.school_id);
  const scope = scopeOf(input);
  if (!(await platform.klass(input.school_id, scope.classId))) throw notFound('Class not found');
  assertClassTeacherOrAdmin(actor, scope.classId);
  const set = await results.getSet(input.school_id, scope);
  if (set?.status !== results.STATUS.PUBLISHED) throw validation('These results are not published', 'checkpoint');
  const card = await results.getReportCard(input.school_id, scope.termId, scope.checkpoint, input.student_id);
  if (!card || card.class_id !== scope.classId || card.calculation_id !== set.calculation_id) {
    throw notFound('This report card has not been produced yet');
  }
  const student = await platform.student(input.school_id, input.student_id);
  const fileName = `${safe(student?.admission_no)}-${safe(`${student?.first_name ?? ''} ${student?.last_name ?? ''}`)}-${safe(scope.termId)}-${scope.checkpoint}.pdf`;

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: card.s3_bucket || process.env.REPORT_BUCKET,
      Key: card.s3_key,
      ResponseContentDisposition: `${input.inline ? 'inline' : 'attachment'}; filename="${fileName}"`,
      ResponseContentType: 'application/pdf',
    }),
    { expiresIn: DOWNLOAD_SECONDS }
  );
  const at = new Date();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: pk(input.school_id),
      SK: sk.reportCardDownload(ulid()),
      entity: 'ReportCardDownload',
      school_id: input.school_id,
      class_id: scope.classId,
      term_id: scope.termId,
      checkpoint: scope.checkpoint,
      student_id: input.student_id,
      calculation_id: set.calculation_id,
      s3_key: card.s3_key,
      requested_by: actor.sub,
      requested_at: at.toISOString(),
    },
  }));
  log({ op: input.inline ? 'report-card-view' : 'report-card-download', ...scope, student_id: input.student_id, by: actor.sub });
  return { url, file_name: fileName, expires_at: new Date(at.getTime() + DOWNLOAD_SECONDS * 1000).toISOString() };
}
// ------------------------------------------------------------------ grading

async function teacherName(schoolId, sub) {
  if (!sub) return null;
  const t = await platform.teacher(schoolId, sub).catch(() => null);
  return t ? [t.first_name, t.last_name].filter(Boolean).join(' ') || null : null;
}

/** Why the term's grading rules can no longer change, or null. Any published result fixes them. */
async function gradingLocked(schoolId, termId) {
  const sets = await results.listSetsForTerm(schoolId, termId);
  return sets.some((s) => s.status === results.STATUS.PUBLISHED) ? GRADING_LOCKED : null;
}

async function policyView(schoolId, policy) {
  return {
    school_id: schoolId,
    pass_mark: policy.pass_mark,
    missing_score_policy: policy.missing_score_policy,
    bands: policy.bands,
    is_default: Boolean(policy.is_default),
    updated_at: policy.updated_at ?? null,
    updated_by_name: await teacherName(schoolId, policy.updated_by),
    _version: policy._version ?? 0,
  };
}

/** The school's default grading rules. Readable by every gradebook role; they explain how results are worked out. */
async function getGradingPolicy(actor, { school_id }) {
  assertTenant(actor, school_id);
  assertGradebookRole(actor);
  return policyView(school_id, await gradingStore.getPolicy(school_id));
}

async function saveGradingPolicy(actor, input) {
  assertTenant(actor, input.school_id);
  assertAdmin(actor);
  const { rules, problems } = normaliseGrading(input);
  if (problems.length) throw validation(problems[0], 'grading');
  try {
    const saved = await gradingStore.savePolicy(input.school_id, rules, input._version ?? 0, actor);
    log({ op: 'saveGradingPolicy', version: saved._version });
    return policyView(input.school_id, saved);
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw conflict('Someone else changed the default grading rules. Reload and try again.');
  }
}

/** Changes one term's bands, pass mark and missing-mark rule, until any of its results are published. */
async function setTermGrading(actor, input) {
  assertTenant(actor, input.school_id);
  assertAdmin(actor);
  await requireTerm(input.school_id, input.term_id);
  const rule = await platform.gradeRule(input.school_id, input.term_id);
  if (!rule) throw notFound('No grading rule is set for this term');
  const blocked = await gradingLocked(input.school_id, input.term_id);
  if (blocked) throw locked(blocked);
  const { rules, problems } = normaliseGrading(input);
  if (problems.length) throw validation(problems[0], 'grading');
  try {
    await gradingStore.setTermGrading(input.school_id, input.term_id, rules, input._version ?? 0, actor);
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw conflict('Someone else changed this term’s grading rules. Reload and try again.');
  }
  log({ op: 'setTermGrading', term_id: input.term_id });
  return getGradeRule(actor, { school_id: input.school_id, term_id: input.term_id });
}

/**
 * Marks to preview a grading change against: every student's result from the
 * most recent published exam, preferring a term's End-term results (the graded
 * term result). Numbers only, no names.
 */
async function getGradingPreview(actor, { school_id }) {
  assertTenant(actor, school_id);
  assertAdmin(actor);
  const [terms, config] = await Promise.all([platform.listTerms(school_id), assessmentConfig.get(school_id)]);
  const labels = labelsOf(config);
  const ordered = [...terms].sort((a, b) => (b.academic_year - a.academic_year) || (b.term_number - a.term_number));
  for (const t of ordered) {
    const published = (await results.listSetsForTerm(school_id, t.term_id)).filter((s) => s.status === results.STATUS.PUBLISHED);
    const checkpoint = [CHECKPOINT.ENDTERM, CHECKPOINT.MIDTERM, CHECKPOINT.OPENER].find((c) => published.some((s) => s.checkpoint === c));
    if (!checkpoint) continue;
    const sets = published.filter((s) => s.checkpoint === checkpoint);
    const rows = (await Promise.all(sets.map((set) => results.listRows(school_id, set)))).flat();
    const value = (r) => (checkpoint === CHECKPOINT.ENDTERM ? r.term_average : r.checkpoint_average);
    return { term_id: t.term_id, term_name: `${t.name} ${labelOf(checkpoint, labels)}`, marks: rows.map(value).filter((v) => Number.isFinite(v)) };
  }
  return { term_id: null, term_name: null, marks: [] };
}

// -------------------------------------------------------------- class page

/**
 * Everything the class page shows, worked out on the server so the browser
 * receives only what the caller may see: administrators and the class teacher
 * get the whole class, a subject teacher only their subjects.
 *
 *   profile                  the chosen exam (summary, subjects, movement, risk, students); null until published
 *   trend                    the class average at every published exam this school year, with the school's
 *   performance_distribution students per 10-mark range at each published exam of the chosen term
 *   risk_distribution        students per 10% of estimated risk at the term's prediction points
 *   top_factors, intervention_methods   for the panels at the top of the page
 */
async function archivedRoster(schoolId, classId, exams) {
  const onClass = await platform.listStudents(schoolId, classId, { includeInactive: true });
  const known = new Set(onClass.map((s) => s.student_id));
  const named = [...new Set(exams.flatMap((e) => e.classRows.map((r) => r.student_id)))].filter((id) => !known.has(id));
  const moved = (await Promise.all(named.map((id) => platform.student(schoolId, id)))).filter(Boolean);
  return [...onClass, ...moved].sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true }));
}

async function getClassProfile(actor, args) {
  assertTenant(actor, args.school_id);
  const scope = scopeOf(args);
  const schoolId = args.school_id;
  const klass = await platform.klass(schoolId, scope.classId);
  if (!klass) throw notFound('Class not found');
  assertClassRead(actor, scope.classId);

  const [term, terms, liveRoster, setup, set] = await Promise.all([
    platform.term(schoolId, scope.termId),
    platform.listTerms(schoolId),
    platform.roster(schoolId, scope.classId),
    termSetup(schoolId, scope.termId),
    results.getSet(schoolId, scope),
  ]);
  if (!term) throw notFound('Term not found');
  const { rule, labels } = setup;
  const admin = isAdmin(actor);
  const classTeacher = isClassTeacherOf(actor, scope.classId);
  const full = admin || classTeacher;
  const subjects = full ? null : subjectsITeach(actor, scope.classId);
  const rScope = riskScope({ isAdmin: admin, isClassTeacher: classTeacher, subjects: subjects ?? [] });

  // Published results of this class, and of the whole school, for every exam this school year.
  const year = terms
    .filter((t) => Number(t.academic_year) === Number(term.academic_year))
    .sort((a, b) => a.term_number - b.term_number);
  const setsByTerm = new Map(await Promise.all(year.map(async (t) => [t.term_id, (await results.listSetsForTerm(schoolId, t.term_id))
    .filter((x) => x.status === results.STATUS.PUBLISHED)])));
  const exams = [];
  for (const t of year) {
    for (const c of CHECKPOINTS) {
      const published = setsByTerm.get(t.term_id).filter((x) => x.checkpoint === c);
      const mine = published.find((x) => x.class_id === scope.classId);
      if (!mine) continue;
      const [classRows, schoolRows] = await Promise.all([
        results.listRows(schoolId, mine),
        Promise.all(published.map((x) => results.listRows(schoolId, x))).then((r) => r.flat()),
      ]);
      exams.push({ term: t, checkpoint: c, set: mine, classRows, schoolRows });
    }
  }
  // A current class's roster is who is in it now. An archived class's students have moved up or
  // graduated on it, so its roster is everyone its published results name, plus anyone still on it.
  const roster = (klass.status || 'CURRENT') === 'CURRENT'
    ? liveRoster
    : await archivedRoster(schoolId, scope.classId, exams);
  const rosterIds = new Set(roster.map((s) => s.student_id));
  const short = (t, c) => `T${t.term_number} ${labelOf(c, labels)}`;
  const trend = exams.map((e) => ({
    label: short(e.term, e.checkpoint),
    term_id: e.term.term_id,
    checkpoint: e.checkpoint,
    mean: examMean(e.classRows, subjects),
    school_mean: examMean(e.schoolRows, subjects),
  }));
  const termExams = exams.filter((e) => e.term.term_id === term.term_id);
  const performanceDistribution = {
    ranges: RANGES.map((r) => r.label),
    series: termExams.map((e) => ({
      checkpoint: e.checkpoint,
      label: labelOf(e.checkpoint, labels),
      counts: rangeCounts(e.classRows.map((r) => examValue(r, subjects))),
      students: e.classRows.filter((r) => examValue(r, subjects) !== null).length,
    })),
  };

  // Risk at the term's prediction points (Term 3 has no End-term prediction: that is the outcome).
  const termPoints = [CHECKPOINT.MIDTERM, CHECKPOINT.ENDTERM]
    .map((c) => ({ checkpoint: c, point: checkpointPoint(term.term_number, c) }))
    .filter((x) => x.point);
  const [predictionsByPoint, interventions] = rScope
    ? await Promise.all([
      Promise.all(termPoints.map((x) => riskStore.listForClass(schoolId, term.academic_year, x.point, scope.classId))),
      interventionStore.listForClass(schoolId, scope.classId),
    ])
    : [termPoints.map(() => []), []];
  const riskDistribution = rScope
    ? {
      ranges: RANGES.map((r) => `${r.min}–${r.max === 100 ? 100 : r.max + 1}%`),
      threshold: predictionsByPoint.flat().find((p) => Number.isFinite(p.threshold))?.threshold ?? null,
      series: termPoints.map((x, i) => ({ checkpoint: x.checkpoint, point: x.point, label: labelOf(x.checkpoint, labels), ...riskSeries(predictionsByPoint[i], rosterIds) }))
        .filter((x) => x.predicted > 0),
    }
    : null;

  const point = checkpointPoint(term.term_number, scope.checkpoint);
  const pointPredictions = predictionsByPoint[termPoints.findIndex((x) => x.point === point)] ?? [];
  const published = set?.status === results.STATUS.PUBLISHED;
  const chosen = exams.find((e) => e.term.term_id === term.term_id && e.checkpoint === scope.checkpoint);

  const base = {
    class_id: klass.class_id,
    class_name: klass.name,
    form: klass.grade ?? null,
    stream: klass.stream ?? null,
    class_year: klass.year ?? null,
    class_teacher_name: await teacherName(schoolId, klass.class_teacher_id),
    term_id: term.term_id,
    term_name: term.name,
    academic_year: term.academic_year,
    checkpoint: scope.checkpoint,
    checkpoint_label: labelOf(scope.checkpoint, labels),
    published,
    published_at: published ? set.published_at : null,
    viewer_is_admin: admin,
    viewer_is_class_teacher: classTeacher,
    my_subjects: admin ? [] : subjectsITeach(actor, scope.classId),
    scope: full ? 'FULL' : 'SUBJECT',
    subjects: subjects ?? [],
    student_count: roster.length,
    risk_point: point,
    rules: {
      pass_mark: rule?.pass_mark ?? null,
      missing_score_policy: rule?.missing_score_policy ?? null,
      bands: rule?.bands ?? [],
      checkpoint_weights: weightsView(rule?.checkpoint_weights),
      opener_enabled: setup.openerEnabled,
      labels: CHECKPOINTS.map((c) => ({ checkpoint: c, label: labelOf(c, labels) })),
    },
    trend,
    performance_distribution: performanceDistribution,
    risk_distribution: riskDistribution,
    top_factors: topFactors(pointPredictions.filter((p) => rosterIds.has(p.student_id)), rScope),
    intervention_methods: rScope ? interventionMethods(interventions, rScope, rosterIds) : [],
    profile: null,
  };
  if (!published || !chosen) return base;

  // The chosen exam in detail, compared with the published exam before it.
  const at = exams.indexOf(chosen);
  const previous = at > 0 ? exams[at - 1] : null;
  const toMap = (rows) => new Map(rows.map((r) => [r.student_id, r]));

  // Attendance for the period leading up to this exam (the Opener has none). Whole class only.
  let attendance = null;
  const period = scope.checkpoint === CHECKPOINT.OPENER ? null : scope.checkpoint;
  if (full && period) {
    const days = attendancePeriods(term).find((p) => p.period === period)?.school_days ?? null;
    const entries = (await attendanceStore.listPeriod(schoolId, scope.termId, period)).filter((e) => rosterIds.has(e.student_id));
    attendance = new Map(entries.map((e) => [e.student_id, periodSummary(e, days ?? e.school_days_when_entered).percentage]));
  }

  const profile = buildClassProfile({
    checkpoint: scope.checkpoint,
    roster,
    rows: toMap(chosen.classRows),
    previousRows: previous ? { checkpoint: previous.checkpoint, rows: toMap(previous.classRows) } : null,
    rule,
    subjects,
    schoolRows: chosen.schoolRows,
    attendance,
    riskScope: point ? rScope : null,
    predictions: pointPredictions,
    interventions,
  });
  return {
    ...base,
    previous_label: previous ? `${previous.term.name} ${labelOf(previous.checkpoint, labels)}` : null,
    school_classes: setsByTerm.get(term.term_id).filter((x) => x.checkpoint === scope.checkpoint).length,
    profile,
  };
}
