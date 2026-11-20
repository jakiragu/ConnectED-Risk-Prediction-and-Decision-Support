import { conflict, forbidden, reauthRequired, ServiceError, validation } from './errors.js';
import { ROLE } from './authz.js';
import * as store from './accountLinkRepo.js';
import { identityProvider } from './googleIdentity.js';
import { authorizeUrl, googleConfig, hashNonce, randomToken, sameHash, verifyGoogleIdToken } from './googleToken.js';
import { googleLinked, googleUnlinked } from './accountEmails.js';
import { sendEmail } from './mailer.js';

export { SESSION_ENDED } from './sessions.js';

/**
 * Linking a person's own Google account to their ConnectED account.
 *
 * The school decides who a person is and what they can reach; Google becomes a
 * second way to prove it. Nothing here changes a school, role, class or email.
 *
 * Rules, each enforced here on the server:
 *   - the school chooses who may link (nobody by default); Angaza staff may always link
 *   - linking, changing and removing need a sign-in from the last ten minutes
 *   - the Google account is proved by Google's own signed answer to this person's
 *     one-time request (googleToken.js), never by anything the browser claims
 *   - one Google account opens one ConnectED account; one account has one Google link
 *   - a change that fails leaves the earlier link in place
 *   - removing or changing a link ends the person's sessions and emails their account address
 *   - every link, change, removal and policy change is audited
 */
export const RECENT_SIGN_IN_SECONDS = 10 * 60;
export const LINK_REQUEST_SECONDS = 10 * 60;
const RANK = { NOBODY: 0, TEACHERS: 1, TEACHERS_AND_ADMINS: 2 };


const defaults = () => ({ store, idp: identityProvider(), verify: verifyGoogleIdToken, config: googleConfig(), mail: sendEmail, now: () => Date.now() });
const withDefaults = (deps) => ({ ...defaults(), ...deps });

/** Whether this person may link, and if not, why and who can change it. */
export function linkPermission({ realm, role, policy, configured = true }) {
  if (!configured) return { allowed: false, reason: 'Google sign-in is not set up on this deployment yet.' };
  if (realm.kind === 'angaza') return { allowed: true, reason: null };
  if (role === ROLE.ADMIN) {
    if (policy === 'TEACHERS_AND_ADMINS') return { allowed: true, reason: null };
    return {
      allowed: false,
      reason: policy === 'TEACHERS'
        ? 'Your school lets teachers, but not administrators, link a personal Google account. An administrator can change this in Settings, under Accounts.'
        : 'Your school has not turned on linking a personal Google account. An administrator can turn it on in Settings, under Accounts.',
    };
  }
  if (policy === 'TEACHERS' || policy === 'TEACHERS_AND_ADMINS') return { allowed: true, reason: null };
  return { allowed: false, reason: 'Your school has not turned on linking a personal Google account. A school administrator can turn it on.' };
}

/** A sign-in within the last ten minutes, by the token's own auth_time (a renewed token keeps the original). */
export function assertRecentSignIn(actor, now = Date.now()) {
  const age = now / 1000 - Number(actor.authTime || 0);
  if (!actor.authTime || age > RECENT_SIGN_IN_SECONDS || age < -300) throw reauthRequired();
}

/**
 * What is linked, merged from the sign-in service (whether a link exists) and the record
 * (the address and date to show). They can disagree, for example after the demo data is reset
 * while the sign-in service keeps its links; the sign-in service wins, and the address is shown
 * only when the record is about the same Google account.
 */
export function describeLink(record, identities) {
  if (!identities) {
    // The sign-in service did not answer: say what the record says, and that it could not be confirmed.
    const linked = Boolean(record?.google_sub);
    return { google_linked: linked, google_email: linked ? record.google_email ?? null : null, google_linked_at: linked ? record.linked_at ?? null : null, confirmed: false };
  }
  const google = identities.google || [];
  if (!google.length) return { google_linked: false, google_email: null, google_linked_at: null, confirmed: true };
  const known = google.find((g) => g.sub === record?.google_sub);
  return {
    google_linked: true,
    google_email: known ? record.google_email ?? null : identities.lastSeenEmail || null,
    google_linked_at: known ? record.linked_at ?? known.linkedAt : google[0].linkedAt,
    confirmed: true,
  };
}

const policyOf = async (realm, deps) => (realm.kind === 'school' ? (await deps.store.policy(realm.schoolId)).google_linking : null);

/** @param person { sub, role } */
export async function signInMethods(realm, person, overrides) {
  const deps = withDefaults(overrides);
  const [record, identities, policy] = await Promise.all([
    deps.store.signIn(realm, person.sub),
    deps.idp.identities(realm.pool, person.sub).catch(() => null),
    policyOf(realm, deps),
  ]);
  const permission = linkPermission({ realm, role: person.role, policy, configured: Boolean(deps.config) });
  return {
    password: true,
    ...describeLink(record, identities),
    google_available: Boolean(deps.config),
    can_link: permission.allowed,
    blocked_reason: permission.reason,
  };
}

async function assertMayLink(realm, actor, deps) {
  const permission = linkPermission({ realm, role: actor.role, policy: await policyOf(realm, deps), configured: Boolean(deps.config) });
  if (!permission.allowed) throw forbidden(permission.reason);
}

/** Step 1: a one-time request, and the address of Google's account chooser for it. */
export async function startLink(realm, actor, overrides) {
  const deps = withDefaults(overrides);
  await assertMayLink(realm, actor, deps);
  assertRecentSignIn(actor, deps.now());
  const nonce = randomToken();
  const state = randomToken();
  await deps.store.putLinkRequest(realm, actor.sub, { nonceHash: hashNonce(nonce), expiresAt: Math.floor(deps.now() / 1000) + LINK_REQUEST_SECONDS });
  return { url: authorizeUrl(deps.config, { nonce, state }), state };
}

const EXPIRED = 'This link request expired or was already used. Start again from your profile.';
const TAKEN = 'That Google account is already linked to another ConnectED account, so it was not linked to yours. Nothing was changed.';

/**
 * Step 2: Google's answer. Links the Google account it proves, replacing an earlier link.
 * @returns {{ changed: boolean, google_email: string|null }}
 */
export async function completeLink(realm, actor, idToken, overrides) {
  const deps = withDefaults(overrides);
  await assertMayLink(realm, actor, deps);
  const google = await deps.verify(idToken, deps.config, { now: deps.now() });
  // Tied to THIS person's request, and used up before anything is changed.
  const nonceHash = hashNonce(google.nonce);
  if (!(await deps.store.consumeLinkRequest(realm, actor.sub, nonceHash, Math.floor(deps.now() / 1000)))) throw validation(EXPIRED);

  const before = await deps.idp.identities(realm.pool, actor.sub);
  const linkedBefore = before.google.map((g) => g.sub);
  const earlier = linkedBefore.filter((sub) => sub !== google.sub);
  const record = await deps.store.signIn(realm, actor.sub);
  const at = new Date(deps.now()).toISOString();

  if (!(await deps.store.claimGoogle(realm, google.sub, actor.sub))) throw conflict(TAKEN);
  const alreadyLinked = linkedBefore.includes(google.sub);
  if (!alreadyLinked) {
    try {
      await deps.idp.link(realm.pool, actor.sub, google.sub);
    } catch (e) {
      await deps.store.releaseGoogle(realm, google.sub, actor.sub);
      console.log(JSON.stringify({ level: 'warn', svc: 'account-link', op: 'link', error: e?.name }));
      // The sign-in service refuses a Google account that another account already uses.
      if (['InvalidParameterException', 'AliasExistsException'].includes(e?.name)) throw conflict(TAKEN);
      throw new ServiceError('LinkFailed', earlier.length
        ? 'Your Google account could not be changed. The account linked before is still linked.'
        : 'The Google account could not be linked. Nothing was changed. Try again.');
    }
  }
  // A change: the earlier account goes only once the new one is in. If it cannot be removed, the new
  // one is taken out again, so the person is never left with no link and never knowingly with two.
  try {
    for (const sub of earlier) await deps.idp.unlink(realm.pool, sub);
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', svc: 'account-link', op: 'replace', error: e?.name }));
    if (!alreadyLinked) {
      await deps.idp.unlink(realm.pool, google.sub).catch(() => {});
      await deps.store.releaseGoogle(realm, google.sub, actor.sub);
    }
    throw new ServiceError('LinkFailed', 'Your Google account could not be changed. The account linked before is still linked.');
  }

  const changed = earlier.length > 0;
  const unchanged = alreadyLinked && !changed && record?.google_sub === google.sub;
  await deps.store.saveLinked(realm, actor.sub, { googleSub: google.sub, googleEmail: google.email, at: unchanged ? record.linked_at : at, by: actor.sub });
  for (const sub of earlier) await deps.store.releaseGoogle(realm, sub, actor.sub);
  if (unchanged) return { changed: false, google_email: google.email };

  await deps.store.audit(realm, changed ? 'GOOGLE_LINK_CHANGED' : 'GOOGLE_LINKED', actor, actor.sub,
    { google_email: google.email, ...(changed ? { previous_google_email: record?.google_email ?? null } : {}) });
  if (changed) await endSessions(realm, actor.sub, 'GOOGLE_CHANGED', deps);
  await deps.mail(googleLinked({ to: actor.email, firstName: actor.firstName, googleEmail: google.email, changed, portal: realm.portal }));
  return { changed, google_email: google.email };
}

async function endSessions(realm, sub, reason, deps) {
  // The record first: it makes the API refuse the person's older sessions at once, whatever happens next.
  await deps.store.markSessionsEnded(realm, sub, Math.floor(deps.now() / 1000), reason);
  try {
    await deps.idp.endSessions(realm.pool, sub);
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', svc: 'account-link', op: 'end-sessions', error: e?.name }));
  }
}

/**
 * Removes the Google link from `target` ({ sub, email, firstName }). The person themselves, or an
 * administrator of their school (the caller has checked which). Afterwards the same Google address
 * is not linked again automatically: the person must link it deliberately.
 */
export async function removeLink(realm, actor, target, overrides) {
  const deps = withDefaults(overrides);
  assertRecentSignIn(actor, deps.now());
  const [record, identities] = await Promise.all([deps.store.signIn(realm, target.sub), deps.idp.identities(realm.pool, target.sub)]);
  if (!identities.google.length && !record?.google_sub) throw validation('No Google account is linked to this account.');
  const shown = describeLink(record, identities).google_email;
  try {
    for (const g of identities.google) await deps.idp.unlink(realm.pool, g.sub);
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', svc: 'account-link', op: 'unlink', error: e?.name }));
    throw new ServiceError('LinkFailed', 'The Google account could not be removed and is still linked. Try again.');
  }
  const byAdmin = target.sub !== actor.sub;
  await deps.store.saveRemoved(realm, target.sub, { at: new Date(deps.now()).toISOString(), by: actor.sub });
  for (const sub of new Set([...identities.google.map((g) => g.sub), record?.google_sub].filter(Boolean))) await deps.store.releaseGoogle(realm, sub, target.sub);
  await endSessions(realm, target.sub, 'GOOGLE_REMOVED', deps);
  await deps.store.audit(realm, 'GOOGLE_LINK_REMOVED', actor, target.sub, { google_email: shown, by_admin: byAdmin });
  await deps.mail(googleUnlinked({ to: target.email, firstName: target.firstName, googleEmail: shown, removedBy: byAdmin ? actor.name : null, portal: realm.portal }));
  return { removed: true, self: !byAdmin };
}

// ------------------------------------------------------------------ school policy

export async function savePolicy(realm, actor, { google_linking: next, _version }, overrides) {
  const deps = withDefaults(overrides);
  if (!(next in RANK)) throw validation('Choose who may link a personal Google account', 'google_linking');
  const current = await deps.store.policy(realm.schoolId);
  // Letting more people add a way to sign in is the sensitive direction.
  if (RANK[next] > RANK[current.google_linking]) assertRecentSignIn(actor, deps.now());
  let saved;
  try {
    saved = await deps.store.savePolicy(realm.schoolId, next, Number(_version) || 0, actor);
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw conflict('Someone else changed this setting. Reload and try again.');
    throw e;
  }
  if (next !== current.google_linking) await deps.store.audit(realm, 'GOOGLE_LINK_POLICY_CHANGED', actor, null, { before: current.google_linking, after: next });
  return saved;
}

/** Everyone at the school with their link status. people: teacher records. */
export async function listLinks(realm, people, overrides) {
  const deps = withDefaults(overrides);
  const records = await deps.store.signIns(realm);
  const out = [];
  for (let i = 0; i < people.length; i += 10) {
    out.push(...await Promise.all(people.slice(i, i + 10).map(async (p) => ({
      person: p,
      ...describeLink(records.get(p.teacher_id), await deps.idp.identities(realm.pool, p.teacher_id).catch(() => null)),
    }))));
  }
  return out;
}
