import { randomInt } from 'node:crypto';
import { resolvePlatformActor } from '../../library/platformActor.js';
import { conflict, notFound, validation } from '../../library/errors.js';
import { countryOf, readSchoolPlace } from '../../library/locations.js';
import * as identity from '../../library/identity.js';
import { credentialsEmail, schoolStatus } from '../../library/accountEmails.js';
import { sendEach, sendEmail } from '../../library/mailer.js';
import * as platform from '../../library/platformRepo.js';
import * as school from '../../library/schoolRepo.js';
import * as store from '../../library/platformStore.js';

/**
 * The Angaza console. Angaza staff register schools, give each school its
 * first administrator, help an administrator who is locked out, and suspend
 * or reactivate a school. Everything else (classes, terms, teachers, marks)
 * belongs to the school's own administrators.
 *
 * Only Angaza accounts reach these operations (resolvePlatformActor), and they
 * return totals about a school, never its students' records.
 */
export async function handler(event) {
  const actor = await resolvePlatformActor(event);
  const args = event.arguments || {};
  const input = args.input || args;

  switch (event.info.fieldName) {
    case 'listSchools':
      return listSchools();
    case 'getSchool':
      return getSchool(args.school_id);
    case 'createSchool':
      return createSchool(actor, input);
    case 'updateSchool':
      return updateSchool(actor, input);
    case 'suspendSchool':
      return suspendSchool(actor, input);
    case 'reactivateSchool':
      return reactivateSchool(actor, input);
    case 'addSchoolAdmin':
      return addSchoolAdmin(actor, input);
    case 'resetSchoolAdminPassword':
      return resetSchoolAdminPassword(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const STALE = 'Someone else changed this school while you were working. The page now shows their changes; make yours again if they are still needed.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s) => (typeof s === 'string' ? s.trim() : '');
const fullName = (t) => [t.first_name, t.last_name].filter(Boolean).join(' ');

const requireText = (value, field, label, max = 60) => {
  const v = clean(value);
  if (!v) throw validation(`Enter the ${label}`, field);
  if (v.length > max) throw validation(`The ${label} is too long`, field);
  return v;
};

function readPlace(input) {
  const { value, problem } = readSchoolPlace(input);
  if (problem) throw validation(problem.message, problem.field);
  return value;
}

const storeError = (place) => (e) => {
  if (e.name === store.DUPLICATE) {
    throw validation(`A school called ${place.name} is already registered in ${place.region}, ${countryOf(place.country).name}. Open it from the list instead.`, 'name');
  }
  if (e.name === store.STALE) throw conflict(STALE);
  throw e;
};

async function loadRegistration(schoolId) {
  const reg = schoolId ? await store.registration(schoolId) : null;
  if (!reg) throw notFound('This school is not registered. It may have been entered with a different link.');
  return reg;
}

// --------------------------------------------------------------------- views

const schoolView = (r, extra = {}) => ({
  school_id: r.school_id,
  name: r.name,
  country: r.country,
  country_name: countryOf(r.country)?.name || r.country,
  region: r.region,
  region_label: countryOf(r.country)?.region_label || 'Region',
  town: r.town ?? null,
  time_zone: r.time_zone || countryOf(r.country)?.time_zone || 'UTC',
  status: r.status || 'ACTIVE',
  suspended_reason: r.suspended_reason ?? null,
  suspended_at: r.suspended_at ?? null,
  suspended_by_name: r.suspended_by_name ?? null,
  reactivated_at: r.reactivated_at ?? null,
  reactivated_by_name: r.reactivated_by_name ?? null,
  created_at: r.created_at ?? null,
  created_by_name: r.created_by_name ?? null,
  updated_at: r.updated_at ?? null,
  active_admin_count: null,
  _version: r._version ?? 1,
  ...extra,
});

const adminView = (t, signIn) => ({
  teacher_id: t.teacher_id,
  first_name: t.first_name,
  last_name: t.last_name,
  email: t.email,
  status: t.status || 'ACTIVE',
  sign_in: (t.status || 'ACTIVE') === 'ACTIVE' ? signIn : 'DISABLED',
});

// ------------------------------------------------------------------- reading

async function listSchools() {
  const regs = await store.listRegistrations();
  // One small count per school, in parallel: enough for a few hundred schools.
  const counts = await Promise.all(regs.map((r) => store.activeAdminCount(r.school_id)));
  return regs
    .map((r, i) => schoolView(r, { active_admin_count: counts[i] }))
    .sort((a, b) => a.country_name.localeCompare(b.country_name) || a.name.localeCompare(b.name));
}

async function getSchool(schoolId) {
  const reg = await loadRegistration(schoolId);
  const [admins, usage] = await Promise.all([store.admins(schoolId), store.usage(schoolId)]);
  const states = await Promise.all(admins.map((a) => identity.accountState(a.teacher_id)));
  const adminRows = admins
    .map((a, i) => adminView(a, states[i]))
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  return {
    school: schoolView(reg, { active_admin_count: adminRows.filter((a) => a.status === 'ACTIVE').length }),
    admins: adminRows,
    usage,
  };
}

// ------------------------------------------------------------------- schools

/** sch_kitale_girls_k3q8: readable in logs and links, unique by its random end. */
function newSchoolId(name) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'school';
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const tail = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `sch_${slug}_${tail}`;
}

async function createSchool(actor, input) {
  const place = readPlace(input);
  const reg = await store.createSchool(newSchoolId(place.name), place, actor).catch(storeError(place));
  return schoolView(reg, { active_admin_count: 0 });
}

async function updateSchool(actor, input) {
  const current = await loadRegistration(input.school_id);
  const place = readPlace(input);
  const unchanged = ['name', 'country', 'region', 'town'].every((k) => (current[k] ?? null) === (place[k] ?? null));
  if (unchanged) return schoolView(current);
  const reg = await store.updateSchool(current, place, input._version, actor).catch(storeError(place));
  return schoolView(reg);
}

async function suspendSchool(actor, input) {
  const current = await loadRegistration(input.school_id);
  const reason = requireText(input.reason, 'reason', 'reason for suspending', 500);
  if (reason.length < 5) throw validation('Say briefly why, so colleagues know when it can be lifted', 'reason');
  if (current.status === 'SUSPENDED') return schoolView(current);
  const reg = await store.setStatus(current, 'SUSPENDED', reason, input._version, actor).catch(storeError(current));
  await tellAdmins(reg, true);
  return schoolView(reg);
}

async function reactivateSchool(actor, input) {
  const current = await loadRegistration(input.school_id);
  if (current.status !== 'SUSPENDED') return schoolView(current);
  const reg = await store.setStatus(current, 'ACTIVE', null, input._version, actor).catch(storeError(current));
  await tellAdmins(reg, false);
  return schoolView(reg);
}

/**
 * Tells the school's active administrators that it was paused or resumed, so
 * they hear it from Angaza rather than from a refused sign-in. The reason stays
 * with Angaza. A failed email never undoes the change; it is logged by the mailer.
 */
async function tellAdmins(reg, suspended) {
  const admins = (await store.admins(reg.school_id).catch(() => [])).filter((a) => (a.status || 'ACTIVE') === 'ACTIVE' && a.email);
  await sendEach(admins.map((a) => schoolStatus({ to: a.email, firstName: a.first_name, schoolName: reg.name, suspended })));
}

// ------------------------------------------------------------ administrators

async function addSchoolAdmin(actor, input) {
  const reg = await loadRegistration(input.school_id);
  const email = requireText(input.email, 'email', 'email address', 120).toLowerCase();
  if (!EMAIL.test(email)) throw validation('Enter a valid email address, such as name@school.ac.ke', 'email');
  const first = requireText(input.first_name, 'first_name', 'first name');
  const last = requireText(input.last_name, 'last_name', 'last name');

  const existing = await platform.teacherByEmail(reg.school_id, email);
  if (existing) {
    throw validation(existing.role === 'Admin'
      ? `${fullName(existing)} is already an administrator here. Use Reset password if they cannot sign in.`
      : `${fullName(existing)} already has a teacher account here. A school administrator can make them an administrator on the Teachers page.`, 'email');
  }
  const account = await identity.createAccount({ email, name: `${first} ${last}`, schoolId: reg.school_id });
  if (!account.created && account.schoolId !== reg.school_id) {
    const other = account.schoolId ? await store.registration(account.schoolId) : null;
    throw conflict(`${email} already signs in to ${other?.name || 'another school'}. Each account belongs to one school; use a different email.`);
  }
  await identity.setRole(account.sub, 'Admin');
  const temporaryPassword = account.temporaryPassword ?? (await identity.resetPassword(account.sub));

  const { item, created } = await school.putTeacher(reg.school_id, {
    teacher_id: account.sub, email, first_name: first, last_name: last, role: 'Admin', created_by: actor.sub, created_by_angaza: true,
  });
  const row = created ? item : await platform.teacher(reg.school_id, account.sub);
  // The account exists now whatever happens to the email; a failed email is reported, not thrown.
  const delivery = await sendEmail(credentialsEmail({
    created: true, temporaryPassword, to: email, firstName: first, role: 'Admin', schoolName: reg.name, actorName: actor.name,
  }));
  await store.audit(reg.school_id, 'ADMIN_ADDED', actor, { teacher_id: account.sub, email, emailed: delivery.sent });
  return { admin: adminView(row, 'WAITING'), temporary_password: temporaryPassword, email: delivery };
}

async function resetSchoolAdminPassword(actor, input) {
  const reg = await loadRegistration(input.school_id);
  const row = await platform.teacher(input.school_id, input.teacher_id);
  if (!row || row.role !== 'Admin') {
    throw validation('Angaza resets administrators’ passwords only. Teachers ask their school administrator.', 'teacher_id');
  }
  if ((row.status || 'ACTIVE') !== 'ACTIVE') {
    throw validation(`${fullName(row)}’s account was deactivated by the school. Another administrator there can reactivate it.`, 'teacher_id');
  }
  // Read before the reset, which puts every account back to WAITING: it decides between
  // "here is your invitation again" and "your password was reset".
  const stateBefore = await identity.accountState(row.teacher_id);
  const temporaryPassword = await identity.resetPassword(row.teacher_id);
  const delivery = await sendEmail(credentialsEmail({
    stateBefore, temporaryPassword, to: row.email, firstName: row.first_name, role: 'Admin', schoolName: reg.name, actorName: actor.name,
  }));
  await store.audit(input.school_id, stateBefore === 'WAITING' ? 'ADMIN_INVITATION_RESENT' : 'ADMIN_PASSWORD_RESET', actor,
    { teacher_id: row.teacher_id, emailed: delivery.sent });
  return { admin: adminView(row, 'WAITING'), temporary_password: temporaryPassword, email: delivery };
}
