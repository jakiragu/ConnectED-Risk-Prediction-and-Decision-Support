import { db, scoreKey, cursor } from './db.js';
import * as outbox from './outbox.js';
import { STATUS, backoffMs } from './outbox.js';
import { gql } from '../api/graphql.js';
import { CREATE_ASSESSMENT, LIST_ASSESSMENTS, LIST_SCORES, SUBMIT_SCORES, SYNC_SCORES } from '../api/operations.js';
import { DELETE_INTERVENTION, SAVE_INTERVENTION } from '../api/decisionOperations.js';
import { normalize, MAX_BATCH, MARK } from '@gradebook/domain/score';
import { CONFLICT_REVIEW } from '@gradebook/domain/conflict';
import { ulid } from '@gradebook/domain/ids';

/** Errors that will fail identically if retried. Anything else backs off and retries. */
const PERMANENT = new Set(['ValidationError', 'Forbidden', 'Locked', 'NotFound', 'Conflict']);
const MAX_ATTEMPTS = 8;

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
let reachable = true;
export const isOnline = () => browserOnline() && reachable;

let activeActor = null;
const listeners = new Set();
export const onSyncChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export async function getState() {
  return { online: isOnline(), ...(await outbox.counts()) };
}
async function emit() {
  const state = await getState();
  listeners.forEach((fn) => fn(state));
}

/** Runs a network call; a failure to reach the server marks us unreachable. */
async function net(fn) {
  try {
    const out = await fn();
    if (!reachable) {
      reachable = true;
      emit();
    }
    return out;
  } catch (e) {
    if (e.errorType === 'Network') {
      reachable = false;
      emit();
    }
    throw e;
  }
}

async function pendingTargets() {
  const live = await db().outbox.where('status').anyOf(STATUS.PENDING, STATUS.SENDING).toArray();
  return new Set(live.map((e) => e.target));
}

// ------------------------------------------------------------------- writes

/**
 * One mark, saved on this device at once and sent when the server can be reached.
 * markStatus is ABSENT or NOT_ASSESSED for those marks (rawScore is then null); omitted means SCORED.
 * version is the server version the teacher was editing (see scoreDrafts.js); omitted means the
 * version this device holds now.
 */
export async function queueScore({ schoolId, assessment, studentId, rawScore, markStatus = null, version, actor }) {
  const id = scoreKey(assessment.assessment_id, studentId);
  const cached = await db().scores.get(id);
  if (rawScore === null && !markStatus && !cached) return; // clearing a mark that was never there

  await outbox.supersede(id);
  const base = version !== undefined ? version : cached?._version ?? null; // the server version the teacher was looking at

  await db().scores.put({
    ...(cached || {}),
    id,
    school_id: schoolId,
    assessment_id: assessment.assessment_id,
    class_id: assessment.class_id,
    student_id: studentId,
    raw_score: rawScore,
    mark_status: markStatus || MARK.SCORED,
    normalized_score: rawScore === null ? null : normalize(rawScore, assessment.max_score),
    entered_by: actor.sub,
    status: cached?.status || 'ACTIVE',
    _version: base,
    _pending: true,
  });
  await outbox.enqueue({
    entity: 'Score',
    target: id,
    payload: {
      school_id: schoolId,
      assessment_id: assessment.assessment_id,
      class_id: assessment.class_id,
      student_id: studentId,
      raw_score: rawScore,
      ...(markStatus ? { mark_status: markStatus } : {}),
      _version: base,
    },
  });
  await emit();
  schedulePush(actor);
}

export async function queueAssessment(input, actor) {
  const payload = { ...input, assessment_id: input.assessment_id || ulid() };
  const draft = {
    ...payload,
    status: 'UNRECORDED',
    score_count: 0,
    created_at: new Date().toISOString(),
    _version: null,
    _deleted: false,
    _pending: true,
  };
  await db().assessments.put(draft);
  await outbox.enqueue({ entity: 'Assessment', target: payload.assessment_id, payload });
  await emit();
  schedulePush(actor);
  return draft;
}

/**
 * An intervention change: saved on this device at once, sent when the server
 * can be reached. `input` is the whole intervention (SaveInterventionInput) or,
 * for a delete, its ids and version. A newer change to the same intervention
 * replaces one still waiting; deleting one that never reached the server just
 * forgets it.
 */
export async function queueIntervention({ action, input, actor }) {
  const id = input.intervention_id;
  const waiting = await db().outbox.where('target').equals(id)
    .filter((e) => e.entity === 'Intervention' && (e.status === STATUS.PENDING || e.status === STATUS.FAILED)).toArray();
  const cached = await db().interventions.get(id);

  if (action === 'DELETE' && cached && cached._version == null) {
    // Never reached the server: nothing to delete there.
    await db().outbox.bulkDelete(waiting.map((e) => e.seq));
    await db().interventions.delete(id);
    await emit();
    return;
  }
  const base = cached?._version ?? null;
  await db().outbox.bulkDelete(waiting.map((e) => e.seq));
  if (action === 'DELETE') {
    await db().interventions.put({ ...cached, _pending: 'DELETE', _failed: null });
  } else {
    await db().interventions.put({ ...(cached || {}), ...input, _version: base, _pending: 'SAVE', _failed: null });
  }
  await outbox.enqueue({
    entity: 'Intervention',
    target: id,
    payload: { action, input: { ...input, _version: base } },
  });
  await emit();
  schedulePush(actor);
}

/** Drops a change the server refused and shows the server's copy again. */
export async function discardIntervention(id) {
  const keys = await db().outbox.where('target').equals(id).filter((e) => e.entity === 'Intervention').primaryKeys();
  await db().outbox.bulkDelete(keys);
  const row = await db().interventions.get(id);
  if (row?._version == null) await db().interventions.delete(id);
  else if (row) await db().interventions.put({ ...row, ...(row._server || {}), _pending: null, _failed: null });
  await emit();
}

// --------------------------------------------------------------------- push

async function cacheScore(id, item) {
  if (item) await db().scores.put({ ...item, id });
  else await db().scores.delete(id);
}

/** Apply one per-entry result from submitScores to the outbox and the cache. */
async function settleScore(entry, result) {
  if (result.outcome === 'REJECTED') {
    await outbox.settle(entry.seq, { status: STATUS.FAILED, reason: result.reason });
    return;
  }
  const underReview = result.item?.status === CONFLICT_REVIEW;
  if (result.outcome === 'CONFLICT' && !underReview) {
    await retryLater(entry, result.reason);
    return;
  }
  if (result.outcome === 'CONFLICT') {
    await outbox.settle(entry.seq, { status: STATUS.CONFLICT, reason: result.reason });
  } else {
    await outbox.remove([entry.seq]);
  }

  // If the teacher typed again while this was in flight, keep their newer value
  // on screen and base the newer edit on the version just written.
  const newer = await db().outbox.where('target').equals(entry.target)
    .filter((e) => e.seq > entry.seq && e.status === STATUS.PENDING).first();
  if (newer && result.outcome === 'APPLIED') {
    await outbox.settle(newer.seq, { payload: { ...newer.payload, _version: result.item?._version ?? null } });
    const row = await db().scores.get(entry.target);
    if (row) await db().scores.put({ ...row, _version: result.item?._version ?? null });
    return;
  }
  await cacheScore(entry.target, result.item);
}

async function retryLater(entry, reason) {
  const attempts = entry.attempts + 1;
  await outbox.settle(entry.seq, {
    status: attempts >= MAX_ATTEMPTS ? STATUS.FAILED : STATUS.PENDING,
    attempts,
    reason,
    retry_after: Date.now() + backoffMs(attempts),
  });
}

async function failAll(entries, error) {
  for (const entry of entries) {
    if (PERMANENT.has(error.errorType)) {
      await outbox.settle(entry.seq, { status: STATUS.FAILED, reason: error.message });
    } else {
      await retryLater(entry, error.message);
    }
  }
}

async function pushAssessment(entry) {
  try {
    const { createAssessment } = await net(() => gql(CREATE_ASSESSMENT, { input: entry.payload }));
    await db().assessments.put(createAssessment);
    await outbox.remove([entry.seq]);
  } catch (e) {
    await failAll([entry], e);
    if (PERMANENT.has(e.errorType)) {
      const draft = await db().assessments.get(entry.target);
      if (draft) await db().assessments.put({ ...draft, _failed: e.message });
    }
  }
}

async function pushIntervention(entry) {
  const { action, input } = entry.payload;
  try {
    if (action === 'DELETE') {
      await net(() => gql(DELETE_INTERVENTION, { input: {
        school_id: input.school_id, student_id: input.student_id, intervention_id: input.intervention_id, _version: input._version,
      } }));
      await outbox.remove([entry.seq]);
      await db().interventions.delete(entry.target);
      return;
    }
    const { saveIntervention } = await net(() => gql(SAVE_INTERVENTION, { input }));
    await outbox.remove([entry.seq]);
    // A change made while this one was on its way is based on the version just saved.
    const newer = await db().outbox.where('target').equals(entry.target)
      .filter((e) => e.seq > entry.seq && e.status === STATUS.PENDING).first();
    if (newer) {
      await outbox.settle(newer.seq, { payload: { ...newer.payload, input: { ...newer.payload.input, _version: saveIntervention._version } } });
      const row = await db().interventions.get(entry.target);
      if (row) await db().interventions.put({ ...row, _version: saveIntervention._version, _server: saveIntervention });
      return;
    }
    await db().interventions.put({ ...saveIntervention, _server: saveIntervention, _pending: null, _failed: null });
  } catch (e) {
    await failAll([entry], e);
    if (PERMANENT.has(e.errorType)) {
      const row = await db().interventions.get(entry.target);
      if (row) await db().interventions.put({ ...row, _failed: e.message });
    }
  }
}

async function pushScores(entries) {
  const { school_id, assessment_id } = entries[0].payload;
  try {
    const { submitScores } = await net(() =>
      gql(SUBMIT_SCORES, {
        input: {
          school_id,
          assessment_id,
          entries: entries.map((e) => ({
            student_id: e.payload.student_id,
            raw_score: e.payload.raw_score,
            ...(e.payload.mark_status ? { mark_status: e.payload.mark_status } : {}),
            _version: e.payload._version,
          })),
        },
      })
    );
    const byStudent = new Map(submitScores.results.map((r) => [r.student_id, r]));
    for (const entry of entries) {
      const result = byStudent.get(entry.payload.student_id);
      if (result) await settleScore(entry, result);
      else await retryLater(entry, 'No result returned');
    }
  } catch (e) {
    await failAll(entries, e);
  }
}

async function drain() {
  for (let pass = 0; pass < 5 && browserOnline(); pass++) {
    const batch = await outbox.claimBatch(MAX_BATCH);
    if (!batch.length) break;

    // Assessments first: marks behind them may need the assessment to exist.
    for (const entry of batch.filter((e) => e.entity === 'Assessment')) await pushAssessment(entry);
    for (const entry of batch.filter((e) => e.entity === 'Intervention')) await pushIntervention(entry);

    const groups = new Map();
    for (const e of batch.filter((x) => x.entity === 'Score')) {
      const k = e.payload.assessment_id;
      groups.set(k, [...(groups.get(k) || []), e]);
    }
    for (const group of groups.values()) await pushScores(group);
    await emit();
    if (!reachable) break;
  }
}

let draining = null;
/** Drain the outbox. Concurrent callers share one drain. */
export function push() {
  if (!draining) draining = drain().finally(() => { draining = null; emit(); });
  return draining;
}

let pushTimer = null;
function schedulePush(actor) {
  if (actor) activeActor = actor;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => browserOnline() && push(), 600);
}

// --------------------------------------------------------------------- pull

/** Merge server rows into the cache. Cells with unsent edits keep the local value. */
async function mergeScores(items) {
  const pending = await pendingTargets();
  for (const item of items) {
    const id = scoreKey(item.assessment_id, item.student_id);
    if (pending.has(id)) continue;
    if (item._deleted) await db().scores.delete(id);
    else await db().scores.put({ ...item, id });
  }
}

export async function pull(schoolId, classId) {
  if (!browserOnline()) return 0;
  const lastSync = await cursor.get(classId);
  let nextToken = null;
  let startedAt = null;
  let count = 0;
  do {
    const { syncScores: page } = await net(() =>
      gql(SYNC_SCORES, { school_id: schoolId, class_id: classId, lastSync, nextToken })
    );
    startedAt ??= page.startedAt;
    await mergeScores(page.items);
    count += page.items.length;
    nextToken = page.nextToken;
  } while (nextToken);
  await cursor.set(classId, startedAt);
  await emit();
  return count;
}

/** Full re-list of a class's assessments; removes cached ones the server no longer has. */
export async function refreshAssessments(schoolId, classId, termId) {
  const { listAssessmentsByClass } = await net(() =>
    gql(LIST_ASSESSMENTS, { school_id: schoolId, class_id: classId, term_id: termId })
  );
  const server = listAssessmentsByClass.items;
  const keep = new Set(server.map((a) => a.assessment_id));
  const cached = await db().assessments.where('[class_id+term_id]').equals([classId, termId]).toArray();
  const gone = cached.filter((a) => !keep.has(a.assessment_id) && !a._pending).map((a) => a.assessment_id);
  if (gone.length) {
    await db().assessments.bulkDelete(gone);
    for (const id of gone) await db().scores.where('assessment_id').equals(id).delete();
  }
  await db().assessments.bulkPut(server);
  return server;
}

/** Full re-list of one assessment's marks; removes cached marks that were cleared elsewhere. */
export async function refreshScores(schoolId, assessmentId) {
  const { listScoresByAssessment } = await net(() =>
    gql(LIST_SCORES, { school_id: schoolId, assessment_id: assessmentId })
  );
  const server = listScoresByAssessment.items;
  const pending = await pendingTargets();
  const keep = new Set(server.map((s) => scoreKey(s.assessment_id, s.student_id)));
  const cached = await db().scores.where('assessment_id').equals(assessmentId).toArray();
  const gone = cached.filter((s) => !keep.has(s.id) && !pending.has(s.id) && !s._pending).map((s) => s.id);
  if (gone.length) await db().scores.bulkDelete(gone);
  await mergeScores(server);
}

// ---------------------------------------------------------------- lifecycle

const watched = new Map(); // classId -> termId
export function watchClass(classId, termId) {
  watched.set(classId, termId);
  return () => watched.delete(classId);
}

async function cycle(schoolId) {
  try {
    await push();
    for (const [classId, termId] of watched) {
      await pull(schoolId, classId);
      if (termId) await refreshAssessments(schoolId, classId, termId);
    }
  } catch (e) {
    if (e.errorType !== 'Network') console.warn('sync cycle failed', e.message);
  }
}

/** Background sync. A reconnect drains at once rather than waiting for the timer. */
export function startSync(actor, { intervalMs = 20000 } = {}) {
  activeActor = actor;
  const run = () => cycle(actor.schoolId);
  const onOnline = () => {
    reachable = true;
    emit();
    run();
  };
  const onOffline = () => emit();
  const onVisible = () => document.visibilityState === 'visible' && run();

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  outbox.recoverInterrupted().then(run);
  const timer = setInterval(run, intervalMs);

  return () => {
    clearInterval(timer);
    clearTimeout(pushTimer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

export const currentActor = () => activeActor;