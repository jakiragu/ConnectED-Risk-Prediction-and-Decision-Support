import { conflict, deleteFailed, notFound, validation } from './errors.js';
import { assertRecentSignIn } from './accountLink.js';
import * as links from './accountLinkRepo.js';
import { identitiesOrNone, identityProvider } from './googleIdentity.js';
import * as people from './platformRepo.js';
import * as school from './schoolRepo.js';

/**
 * Deleting a deactivated teacher's or administrator's account, for good.
 *
 * Removed: the sign-in account, any linked Google account and its claim (so
 * that Google account can be linked to someone else), the person's email and
 * every other detail on their record, and their subject assignments.
 *
 * Kept: a small record holding only their name, marked DELETED. Marks,
 * interventions and audit entries already copy the name of whoever acted, and
 * an archived class looks its former class teacher up by this record, so
 * history keeps reading "Assigned by Jane Doe".
 *
 * Rules, each enforced here on the server:
 *   - only a deactivated account can be deleted, and never the caller's own
 *   - the administrator must have signed in within the last ten minutes
 *   - every step can be repeated: if one fails the account stays deactivated,
 *     and deleting it again carries on from where it stopped
 *   - the deletion is audited; the person is not emailed (their account is
 *     already deactivated and the address may no longer exist)
 */
const defaults = () => ({ links, people, school, idp: identityProvider(), now: () => Date.now() });

const fullName = (t) => [t.first_name, t.last_name].filter(Boolean).join(' ');

/**
 * @param realm  the school's realm (accountLinkRepo.schoolRealm)
 * @param actor  the administrator, as resolveActor returns them (the caller has checked the role)
 * @returns {{ teacher_id: string, first_name: string, last_name: string, deleted_at: string }}
 */
export async function deleteAccount(realm, actor, teacherId, overrides) {
  const deps = { ...defaults(), ...overrides };
  const person = teacherId ? await deps.people.teacher(realm.schoolId, teacherId) : null;
  if (!person || deps.people.isDeleted(person)) throw notFound('This account does not exist, or was already deleted.');
  if (person.teacher_id === actor.sub) throw validation('You cannot delete your own account', 'teacher_id');
  if ((person.status || 'ACTIVE') !== 'INACTIVE') {
    throw validation(`Deactivate ${fullName(person)}’s account first. Only a deactivated account can be deleted.`, 'teacher_id');
  }
  if (person.class_teacher_of) throw validation(`Choose another class teacher for ${fullName(person)}’s class first`, 'teacher_id');
  assertRecentSignIn(actor, deps.now());

  const sub = person.teacher_id;
  const failed = (step) => (e) => {
    console.log(JSON.stringify({ level: 'warn', svc: 'account-deletion', step, error: e?.name }));
    throw deleteFailed(`${fullName(person)}’s account could not be deleted, and is still deactivated. Try again.`);
  };

  // 1. Google: the link in the sign-in service, then the claim, so the Google account is free for someone else.
  const record = await deps.links.signIn(realm, sub);
  const identities = await identitiesOrNone(deps.idp, realm.pool, sub).catch(failed('identities'));
  for (const g of identities.google) await deps.idp.unlink(realm.pool, g.sub).catch(failed('unlink'));
  for (const googleSub of new Set([...identities.google.map((g) => g.sub), record?.google_sub].filter(Boolean))) {
    await deps.links.releaseGoogle(realm, googleSub, sub);
  }
  // 2. The sign-in account. From here the person cannot come back; their email is free for a new account.
  await deps.idp.deleteUser(realm.pool, sub).catch(failed('sign-in-account'));
  // 3. Their sign-in records, and their Google address where earlier audit entries quoted it.
  await deps.links.forgetPerson(realm, sub);
  // 4. The record itself: replaced by one that holds only the name.
  const at = new Date(deps.now()).toISOString();
  const kept = await deps.school.tombstoneTeacher(realm.schoolId, person, { at, by: actor.sub }).catch((e) => {
    if (e.name === deps.school.STALE) throw conflict('Someone else changed this account while you were deleting it. Reload and check the list.');
    throw e;
  });
  await deps.links.audit(realm, 'ACCOUNT_DELETED', actor, sub, { name: fullName(person), role: person.role || 'Teacher' });
  return { teacher_id: kept.teacher_id, first_name: kept.first_name, last_name: kept.last_name, deleted_at: kept.deleted_at };
}
