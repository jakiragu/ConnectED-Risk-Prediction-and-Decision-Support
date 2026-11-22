import { deleteFailed, notFound, validation } from './errors.js';
import { assertRecentSignIn } from './accountLink.js';
import { identitiesOrNone, identityProvider } from './googleIdentity.js';
import { isDeleted } from './platformRepo.js';
import * as store from './platformStore.js';
import { purgeSchool } from './reportStore.js';

/**
 * Deleting a school, for good: a suspended one, or one that has no active administrator
 * yet (registered by mistake, never started). Angaza staff only (the caller has checked).
 * Nobody at the school is emailed.
 *
 * Removed: every record in the school's partition, its people's sign-in accounts,
 * their Google links and claims, its report-card PDFs, and its name reservation,
 * so the name can be used again. Kept: one line in the console (name, place, who
 * deleted it and when) and Angaza's own audit rows, with no data from the school.
 *
 * A large school has tens of thousands of records, far more than one request can
 * remove, so the work is done in slices:
 *
 *   startDeletion     checks, marks the school DELETING, does a first slice
 *   continueDeletion  does another slice; the console calls it until the school reads DELETED
 *
 * DELETING blocks every sign-in at once (actor.js) and can only move forward to
 * DELETED. Nothing remembers how far a slice got: each one looks at what is still
 * there and removes it, in this order, so an interrupted slice is simply followed
 * by the next and no half-deleted school is ever active.
 *
 *   1. people      Google links, then the sign-in account, then the person's record
 *   2. claims      any Google-account claim still held for the school
 *   3. files       report-card PDFs, every version
 *   4. records     everything else in the school's partition
 *   5. the entry   registration replaced by the one-line entry, name released, profile removed
 */
export const SLICE_MS = 18_000; // AppSync waits 30 seconds for an answer
const PEOPLE_AT_ONCE = 5;
const RECORDS_AT_ONCE = 100;

const defaults = () => ({
  store,
  idp: identityProvider(),
  files: { purge: purgeSchool },
  now: () => Date.now(),
  sliceMs: SLICE_MS,
  pool: process.env.COGNITO_USER_POOL_ID,
});

const sameName = (a, b) => {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
};

/**
 * @param reg  the school's registration, read by the caller
 * @param {{ confirmName: string, version: number }} input  the name as typed, and the version of the page it was typed on
 * @returns the registration afterwards: DELETING with a running total, or DELETED if one slice was enough
 */
export async function startDeletion(actor, reg, { confirmName, version }, overrides) {
  const deps = { ...defaults(), ...overrides };
  if (reg.status === 'DELETED') throw validation(`${reg.name} was already deleted.`);
  if (reg.status === 'DELETING') return continueDeletion(reg.school_id, overrides);
  // A school in use must be suspended first. One with no active administrator has nobody using it.
  if (reg.status !== 'SUSPENDED' && (await deps.store.activeAdminCount(reg.school_id)) > 0) {
    throw validation(`Suspend ${reg.name} first. A school with an administrator can be deleted only while it is suspended.`);
  }
  if (!sameName(confirmName, reg.name)) throw validation('Type the school’s name exactly as shown to confirm', 'confirm_name');
  assertRecentSignIn(actor, deps.now());

  const marked = await deps.store.beginDeletion(reg, version, actor); // throws store.STALE if the page was out of date
  return continueDeletion(marked.school_id, overrides);
}

/** One more slice. Safe to call at any time, by anyone on the Angaza staff, as often as needed. */
export async function continueDeletion(schoolId, overrides) {
  const deps = { ...defaults(), ...overrides };
  const reg = schoolId ? await deps.store.registration(schoolId) : null;
  if (!reg) throw notFound('This school is not registered.');
  if (reg.status === 'DELETED') return reg;
  if (reg.status !== 'DELETING') throw validation(`${reg.name} is not being deleted.`);

  const until = deps.now() + deps.sliceMs;
  const outOfTime = () => deps.now() >= until;
  const paused = (step) => (e) => {
    if (e?.type) throw e;
    console.log(JSON.stringify({ level: 'warn', svc: 'school-deletion', school_id: schoolId, step, error: e?.name }));
    throw deleteFailed(`Deleting ${reg.name} was interrupted. Nothing is lost by trying again: it carries on from where it stopped.`);
  };
  /** Deletes the keys and adds them to the running total. False: the table is busy, stop for now. */
  const remove = async (keys, counted = true) => {
    const deleted = await deps.store.deleteKeys(keys);
    if (deleted && counted) await deps.store.addDeletionProgress(schoolId, deleted);
    return deleted === keys.length;
  };
  const again = () => deps.store.registration(schoolId);

  // 1. People: each one's Google links and sign-in account first, their record only after both are gone.
  for (;;) {
    const people = await deps.store.staffPage(schoolId, PEOPLE_AT_ONCE).catch(paused('people'));
    if (!people.length) break;
    await Promise.all(people.filter((p) => !isDeleted(p)).map(async (p) => {
      const identities = await identitiesOrNone(deps.idp, deps.pool, p.teacher_id);
      for (const g of identities.google) await deps.idp.unlink(deps.pool, g.sub);
      await deps.idp.deleteUser(deps.pool, p.teacher_id);
    })).catch(paused('sign-in-accounts'));
    if (!(await remove(people).catch(paused('people'))) || outOfTime()) return again();
  }
  // 2. Google-account claims, so those Google accounts can be linked elsewhere.
  const claims = await deps.store.googleClaimKeys(deps.pool, schoolId).catch(paused('claims'));
  if (claims.length && !(await remove(claims, false).catch(paused('claims')))) return again();
  // 3. Report-card PDFs.
  const files = await deps.files.purge(schoolId, until).catch(paused('files'));
  if (!files.done || outOfTime()) return again();
  // 4. Everything else the school holds.
  for (;;) {
    const keys = await deps.store.recordKeysPage(schoolId, RECORDS_AT_ONCE).catch(paused('records'));
    if (!keys.length) break;
    if (!(await remove(keys).catch(paused('records'))) || outOfTime()) return again();
  }
  // 5. The one-line entry.
  await deps.store.scrubAudit(schoolId).catch(paused('audit'));
  return deps.store.finishDeletion(await again()).catch(paused('entry'));
}
