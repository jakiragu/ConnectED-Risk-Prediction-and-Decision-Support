import {
  assertTenant,
  assertAdmin,
  assertClassRead,
  assertClassTeacherOrAdmin,
  isAdmin,
  isClassTeacherOf,
  ROLE,
  ROLES,
} from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { SUBJECTS } from '../../library/assessment.js';
import { validation, notFound, conflict } from '../../library/errors.js';
import { ulid } from '../../library/ids.js';
import * as identity from '../../library/identity.js';
import { credentialsEmail } from '../../library/accountEmails.js';
import { sendEmail } from '../../library/mailer.js';
import * as platform from '../../library/platformRepo.js';
import * as school from '../../library/schoolRepo.js';
import * as classSetupStore from '../../library/classSetupRepo.js';
import { normaliseSetup, setupFromClasses, classFieldProblem, canonicalClassFields } from '../../library/classSetup.js';
import { STUDENT_STATUS } from '../../library/promotion.js';
import { ADMISSION, GUARDIAN_NAME_MAX, normalisePhone } from '../../library/student.js';
import {
  applyPromotion, getPromotionRun, listPastStudents, listPromotionRuns, planPromotion, revertPromotion,
} from './promotion.js';

export async function handler(event) {
  const actor = await resolveActor(event);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id ?? args.school_id);

  switch (event.info.fieldName) {
    case 'me':
      return me(actor);
    case 'listTeachers':
      return listTeachers(actor, args);
    case 'createTeacher':
      return createTeacher(actor, input);
    case 'updateTeacher':
      return updateTeacher(actor, input);
    case 'updateMyProfile':
      return updateMyProfile(actor, input);
    case 'setTeacherAssignments':
      return setTeacherAssignments(actor, input);
    case 'setClassTeacher':
      return setClassTeacher(actor, input);
    case 'deactivateTeacher':
      return setTeacherStatus(actor, input, 'INACTIVE');
    case 'reactivateTeacher':
      return setTeacherStatus(actor, input, 'ACTIVE');
    case 'resetTeacherPassword':
      return resetTeacherPassword(actor, input);
    case 'listSchoolClasses':
      return listSchoolClasses(actor, args);
    case 'getClassSetup':
      return getClassSetup(actor, args);
    case 'saveClassSetup':
      return saveClassSetup(actor, input);
    case 'createClass':
      return createClass(actor, input);
    case 'updateClass':
      return updateClass(actor, input);
    case 'deleteClass':
      return deleteClass(actor, input);
    case 'listStudents':
      return listStudents(actor, args);
    case 'createStudent':
      return createStudent(actor, input);
    case 'updateStudent':
      return updateStudent(actor, input);
    case 'transferStudent':
      return transferStudent(actor, input);
    case 'setStudentStatus':
      return setStudentStatus(actor, input);
    case 'planPromotion':
      return planPromotion(actor, args);
    case 'getPromotionRun':
      return getPromotionRun(actor, args);
    case 'listPromotionRuns':
      return listPromotionRuns(actor, args);
    case 'listPastStudents':
      return listPastStudents(actor, args);
    case 'applyPromotion':
      return applyPromotion(actor, input);
    case 'revertPromotion':
      return revertPromotion(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

const STALE = 'Someone else changed this record. Reload and try again.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLASS_STATUS = ['CURRENT', 'PAST'];

const clean = (s) => (typeof s === 'string' ? s.trim() : s);
const requireText = (value, field, label, max = 60) => {
  const v = clean(value);
  if (!v) throw validation(`Enter the ${label}`, field);
  if (v.length > max) throw validation(`The ${label} is too long`, field);
  return v;
};
const fullName = (t) => [t.first_name, t.last_name].filter(Boolean).join(' ');
const staleOr = (e) => {
  if (e.name === school.STALE || e.name === 'ConditionalCheckFailedException') throw conflict(STALE);
  throw e;
};

// ------------------------------------------------------------------- views

const teacherView = (t) => ({
  teacher_id: t.teacher_id,
  school_id: t.school_id,
  school_name: t.school_name ?? null,
  email: t.email,
  first_name: t.first_name,
  last_name: t.last_name,
  role: t.role || t.groups?.[0] || ROLE.TEACHER,
  status: t.status || 'ACTIVE',
  assignments: t.assignments || [],
  class_teacher_of: t.class_teacher_of || null,
  created_at: t.created_at ?? null,
  updated_at: t.updated_at ?? null,
  _version: t._version ?? 1,
});

const classView = (c, extra = {}) => ({
  class_id: c.class_id,
  school_id: c.school_id,
  name: c.name,
  grade: c.grade,
  stream: c.stream,
  year: c.year ?? null,
  status: c.status || 'CURRENT',
  class_teacher_id: c.class_teacher_id || null,
  promoted_from_class_id: c.promoted_from_class_id ?? null,
  promoted_to_class_id: c.promoted_to_class_id ?? null,
  _version: c._version ?? 1,
  ...extra,
});

/**
 * Guardian contacts are personal data about someone other than the student, so
 * only the people who manage the class (an administrator, its class teacher)
 * see them. Subject teachers get the record without them.
 */
const seesContacts = (actor, s) => Boolean(actor) && (isAdmin(actor) || isClassTeacherOf(actor, s.class_id));

const studentView = (s, actor) => ({
  ...(seesContacts(actor, s)
    ? { guardian_name: s.guardian_name ?? null, guardian_phone: s.guardian_phone ?? null, results_sms: s.results_sms !== false }
    : { guardian_name: null, guardian_phone: null, results_sms: null }),
  student_id: s.student_id,
  school_id: s.school_id,
  first_name: s.first_name,
  last_name: s.last_name,
  admission_no: s.admission_no,
  class_id: s.class_id,
  status: s.status || 'ACTIVE',
  graduation_year: s.graduation_year ?? null,
  left_year: s.left_year ?? null,
  departure_kind: s.departure_kind ?? null, deactivation_reason: s.deactivation_reason ?? null, deactivation_date: s.deactivation_date ?? null,
  _version: s._version ?? 1,
});

async function loadTeacher(schoolId, teacherId) {
  const t = await platform.teacher(schoolId, teacherId);
  if (!t) throw notFound('Teacher not found');
  return t;
}

async function loadClass(schoolId, classId) {
  const c = await platform.klass(schoolId, classId);
  if (!c) throw notFound('Class not found');
  return c;
}

async function loadStudent(schoolId, studentId) {
  const s = await platform.student(schoolId, studentId);
  if (!s) throw notFound('Student not found');
  return s;
}

// --------------------------------------------------------------- teachers

async function me(actor) {
  const [teacher, schoolProfile] = await Promise.all([
    loadTeacher(actor.schoolId, actor.sub),
    platform.school(actor.schoolId),
  ]);

  return {
    ...teacherView(teacher),
    school_name: schoolProfile?.name ?? null,
  };
}

async function listTeachers(actor, { school_id }) {
  assertAdmin(actor);
  return (await platform.listTeachers(school_id)).map(teacherView);
}

function readRole(role) {
  if (!ROLES.includes(role)) throw validation(`Role must be ${ROLES.join(' or ')}`, 'role');
  return role;
}

/**
 * Creates the sign-in account first, then the Teacher record keyed by the
 * account's sub. If a previous attempt stopped half way, the retry finds the
 * account and finishes the record. The temporary password is returned once.
 */
async function createTeacher(actor, input) {
  assertAdmin(actor);
  const email = requireText(input.email, 'email', 'email address', 120).toLowerCase();
  if (!EMAIL.test(email)) throw validation('Enter a valid email address', 'email');
  const first = requireText(input.first_name, 'first_name', 'first name');
  const last = requireText(input.last_name, 'last_name', 'last name');
  const role = readRole(input.role || ROLE.TEACHER);

  if (await platform.teacherByEmail(input.school_id, email)) {
    throw validation('A teacher with this email already exists at this school', 'email');
  }
  const account = await identity.createAccount({ email, name: `${first} ${last}`, schoolId: input.school_id });
  if (!account.created && account.schoolId !== input.school_id) {
    throw conflict('This email is already registered at another school');
  }
  await identity.setRole(account.sub, role);
  const temporaryPassword = account.temporaryPassword ?? (await identity.resetPassword(account.sub));

  const { item, created } = await school.putTeacher(input.school_id, {
    teacher_id: account.sub, email, first_name: first, last_name: last, role, created_by: actor.sub,
  });
  const row = created ? item : await loadTeacher(input.school_id, account.sub);
  // The account exists now whatever happens to the email; a failed email is reported, not thrown.
  const delivery = await sendCredentials(actor, row, { created: true, temporaryPassword });
  return { teacher: teacherView(row), temporary_password: temporaryPassword, email: delivery };
}

/** Emails sign-in details to a teacher or administrator of the actor's school. */
async function sendCredentials(actor, teacher, { created = false, stateBefore = null, temporaryPassword }) {
  const schoolProfile = await platform.school(teacher.school_id || actor.schoolId).catch(() => null);
  return sendEmail(credentialsEmail({
    created, stateBefore, temporaryPassword,
    to: teacher.email, firstName: teacher.first_name, role: teacher.role,
    schoolName: schoolProfile?.name, actorName: actor.name, portal: 'school',
  }));
}

async function updateTeacher(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  const patch = {
    first_name: input.first_name != null ? requireText(input.first_name, 'first_name', 'first name') : undefined,
    last_name: input.last_name != null ? requireText(input.last_name, 'last_name', 'last name') : undefined,
    role: input.role != null ? readRole(input.role) : undefined,
  };
  if (patch.role && patch.role !== existing.role) {
    if (existing.teacher_id === actor.sub) throw validation('You cannot change your own role', 'role');
    if (patch.role === ROLE.ADMIN && existing.class_teacher_of) {
      throw validation('Choose another class teacher for their class before making them an administrator', 'role');
    }
  }
  const updated = await school.updateTeacher(input.school_id, input.teacher_id, patch, input._version).catch(staleOr);
  // The record is authoritative; bring the account in line (idempotent, so a retry repairs a partial failure).
  await identity.setRole(updated.teacher_id, updated.role);
  if (fullName(updated) !== fullName(existing)) await identity.setName(updated.teacher_id, fullName(updated));
  return teacherView(updated);
}

async function updateMyProfile(actor, input) {
  const existing = await loadTeacher(input.school_id, actor.sub);

  const patch = {
    first_name: input.first_name != null
      ? requireText(input.first_name, 'first_name', 'first name')
      : undefined,
    last_name: input.last_name != null
      ? requireText(input.last_name, 'last_name', 'last name')
      : undefined,
  };

  const updated = await school.updateTeacher(
    input.school_id,
    actor.sub,
    patch,
    input._version
  ).catch(staleOr);

  if (fullName(updated) !== fullName(existing)) {
    await identity.setName(updated.teacher_id, fullName(updated));
  }

  return teacherView(updated);
}

async function setTeacherAssignments(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.status !== 'ACTIVE') throw validation('Reactivate this teacher before assigning classes', 'assignments');
  if ((existing.role || ROLE.TEACHER) !== ROLE.TEACHER) {
    throw validation('Administrators can work in every class; assignments are for teachers', 'assignments');
  }
  const classes = new Map((await platform.listClasses(input.school_id)).map((c) => [c.class_id, c]));
  const seen = new Set();
  const assignments = [];
  for (const a of input.assignments || []) {
    const c = classes.get(a.class_id);
    if (!c) throw validation('One of the classes no longer exists', 'assignments');
    if (!SUBJECTS.includes(a.subject)) throw validation(`${a.subject} is not a subject this school teaches`, 'assignments');
    const key = `${a.class_id}|${a.subject}`;
    if (seen.has(key)) continue;
    if (c.status !== 'CURRENT' && !(existing.assignments || []).some((x) => x.class_id === a.class_id && x.subject === a.subject)) {
      throw validation(`${c.name} is archived, so it cannot get new assignments`, 'assignments');
    }
    seen.add(key);
    assignments.push({ class_id: a.class_id, subject: a.subject });
  }
  assignments.sort((x, y) => classes.get(x.class_id).name.localeCompare(classes.get(y.class_id).name) || x.subject.localeCompare(y.subject));
  const updated = await school.updateTeacher(input.school_id, input.teacher_id, { assignments }, input._version).catch(staleOr);
  return teacherView(updated);
}

async function setClassTeacher(actor, input) {
  assertAdmin(actor);
  const klass = await loadClass(input.school_id, input.class_id);
  const teacherId = input.teacher_id || null;
  let next = null;
  if (teacherId) {
    if (klass.status !== 'CURRENT') throw validation(`${klass.name} is archived`, 'teacher_id');
    next = await loadTeacher(input.school_id, teacherId);
  }
  try {
    await school.setClassTeacher(input.school_id, klass, teacherId, input._version);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    const at = e.classTeacherIndex;
    if (school.reasonAt(e, at.klass)) throw conflict(STALE);
    if (at.previous !== undefined && school.reasonAt(e, at.previous)) throw conflict(STALE);
    if (at.next !== undefined && school.reasonAt(e, at.next)) {
      if (next.status !== 'ACTIVE') throw validation(`${fullName(next)} is deactivated`, 'teacher_id');
      if ((next.role || ROLE.TEACHER) !== ROLE.TEACHER) throw validation('Administrators cannot be class teachers', 'teacher_id');
      const other = next.class_teacher_of ? await platform.klass(input.school_id, next.class_teacher_of) : null;
      throw validation(`${fullName(next)} is already the class teacher of ${other?.name || 'another class'}`, 'teacher_id');
    }
    throw e;
  }
  return classView(await loadClass(input.school_id, input.class_id));
}

async function setTeacherStatus(actor, input, status) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.teacher_id === actor.sub) throw validation('You cannot deactivate your own account', 'teacher_id');
  if (status === 'INACTIVE' && existing.class_teacher_of) {
    const klass = await platform.klass(input.school_id, existing.class_teacher_of);
    throw validation(`Choose another class teacher for ${klass?.name || 'their class'} first`, 'teacher_id');
  }
  const updated = existing.status === status
    ? existing
    : await school.updateTeacher(input.school_id, input.teacher_id, { status }, input._version).catch(staleOr);
  // The record already blocks or allows access on every request; the account follows it.
  if (status === 'INACTIVE') await identity.disable(updated.teacher_id);
  else await identity.enable(updated.teacher_id);
  return teacherView(updated);
}

async function resetTeacherPassword(actor, input) {
  assertAdmin(actor);
  const existing = await loadTeacher(input.school_id, input.teacher_id);
  if (existing.status !== 'ACTIVE') throw validation('Reactivate this teacher first', 'teacher_id');
  // Read before the reset, which puts every account back to WAITING: it decides between
  // "here is your invitation again" and "your password was reset".
  const stateBefore = await identity.accountState(existing.teacher_id);
  const temporaryPassword = await identity.resetPassword(existing.teacher_id);
  const delivery = await sendCredentials(actor, existing, { stateBefore, temporaryPassword });
  return { teacher: teacherView(existing), temporary_password: temporaryPassword, email: delivery };
}

// ----------------------------------------------------------------- classes

async function listSchoolClasses(actor, { school_id }) {
  assertAdmin(actor);
  const [classes, teachers] = await Promise.all([platform.listClasses(school_id), platform.listTeachers(school_id)]);
  const names = new Map(teachers.map((t) => [t.teacher_id, fullName(t)]));
  return Promise.all(classes.map(async (c) => classView(c, {
    // An archived class counts everyone it still holds (graduates, leavers); a current one its active roster.
    student_count: (await platform.listStudents(school_id, c.class_id, { includeInactive: (c.status || 'CURRENT') !== 'CURRENT' })).length,
    // An archived class keeps who its class teacher was (former_class_teacher_id).
    class_teacher_name: (c.class_teacher_id || c.former_class_teacher_id)
      ? names.get(c.class_teacher_id || c.former_class_teacher_id) ?? null
      : null,
  })));
}

function readClassFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.grade != null) out.grade = requireText(input.grade, 'grade', 'form', 30);
  if (!partial || input.stream != null) out.stream = requireText(input.stream, 'stream', 'stream', 30);
  if (!partial || input.year != null) {
    const year = Number(input.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw validation('Enter a year such as 2026', 'year');
    out.year = year;
  }
  if (input.name != null) out.name = requireText(input.name, 'name', 'class name');
  if (input.status != null) {
    if (!CLASS_STATUS.includes(input.status)) throw validation('Status must be CURRENT or PAST', 'status');
    out.status = input.status;
  }
  return out;
}

/** Names are unique within a school year: Form 4 East 2026 and Form 4 East 2027 are different classes. */
async function assertNameFree(schoolId, name, year, classId = null) {
  const taken = (await platform.listClasses(schoolId)).some(
    (c) => c.class_id !== classId && Number(c.year) === Number(year) && c.name.toLowerCase() === name.toLowerCase()
  );
  if (taken) throw validation(`There is already a class called ${name} in ${year}`, 'name');
}


// --------------------------------------------------------------- class setup

/**
 * The forms and streams classes can be created with. Before a school saves its
 * own lists they are taken from its existing classes and not enforced.
 */
async function getClassSetup(actor, { school_id }) {
  const saved = await classSetupStore.get(school_id);
  if (saved) {
    return { school_id, forms: saved.forms, streams: saved.streams, progression_paths: saved.progression_paths ?? null, is_default: false, updated_at: saved.updated_at ?? null, _version: saved._version };
  }
  const derived = setupFromClasses(await platform.listClasses(school_id));
  return { school_id, ...derived, is_default: true, updated_at: null, _version: 0 };
}

async function saveClassSetup(actor, input) {
  assertAdmin(actor);
  const previous = await classSetupStore.get(input.school_id);
  const { setup, problems } = normaliseSetup({ ...input, progression_paths: input.progression_paths ?? previous?.progression_paths });
  if (problems.length) throw validation(problems[0], 'class_setup');
  try {
    const saved = await classSetupStore.save(input.school_id, setup, input._version ?? 0, actor);
    return { school_id: input.school_id, forms: saved.forms, streams: saved.streams, progression_paths: saved.progression_paths ?? null, is_default: false, updated_at: saved.updated_at, _version: saved._version };
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw conflict('Someone else changed the forms and streams. Reload and try again.');
  }
}

/**
 * Rejects a form or stream that is not in the school's saved lists, and
 * returns the fields in the lists' own spelling.
 */
async function checkClassFields(schoolId, fields, changed = fields) {
  if (fields.grade == null && fields.stream == null) return fields;
  const setup = await classSetupStore.get(schoolId);
  const problem = classFieldProblem(setup, changed);
  if (problem) throw validation(problem.reason, problem.field);
  return canonicalClassFields(setup, fields);
}

async function createClass(actor, input) {
  assertAdmin(actor);
  const fields = await checkClassFields(input.school_id, readClassFields(input));
  const name = fields.name || `${fields.grade} ${fields.stream}`;
  await assertNameFree(input.school_id, name, fields.year);
  const item = await school.createClass(input.school_id, {
    class_id: `cls_${ulid().toLowerCase()}`, ...fields, name, status: 'CURRENT', created_by: actor.sub,
  });
  return classView(item, { student_count: 0, class_teacher_name: null });
}

async function updateClass(actor, input) {
  assertAdmin(actor);
  const existing = await loadClass(input.school_id, input.class_id);
  // Only a changed form or stream is checked, so an older class can still be edited in other ways.
  const read = readClassFields(input, { partial: true });
  const patch = await checkClassFields(input.school_id, read, {
    grade: read.grade != null && read.grade !== existing.grade ? read.grade : null,
    stream: read.stream != null && read.stream !== existing.stream ? read.stream : null,
  });
  if (patch.name || patch.year != null) {
    await assertNameFree(input.school_id, patch.name || existing.name, patch.year ?? existing.year, existing.class_id);
  }
  const updated = await school.updateClass(input.school_id, input.class_id, patch, input._version).catch(staleOr);
  return classView(updated);
}

/** Only a class nothing refers to; otherwise archive it (status PAST). */
async function deleteClass(actor, input) {
  assertAdmin(actor);
  const existing = await loadClass(input.school_id, input.class_id);
  const keep = 'Archive it instead (set it to Past).';
  if (existing.class_teacher_id) throw validation(`Remove the class teacher first, or ${keep.toLowerCase()}`, 'class_id');
  const students = await platform.listStudents(input.school_id, input.class_id, { includeInactive: true });
  if (students.length) throw validation(`${existing.name} has ${students.length} student record${students.length === 1 ? '' : 's'}. ${keep}`, 'class_id');
  if (await school.classHasAssessments(input.school_id, input.class_id)) {
    throw validation(`${existing.name} has assessments. ${keep}`, 'class_id');
  }
  const assigned = (await platform.listTeachers(input.school_id))
    .filter((t) => (t.assignments || []).some((a) => a.class_id === input.class_id));
  if (assigned.length) {
    throw validation(`Remove ${existing.name} from ${assigned.map(fullName).join(', ')}'s assignments first`, 'class_id');
  }
  await school.deleteClass(input.school_id, input.class_id, input._version).catch(staleOr);
  return input.class_id;
}

// ---------------------------------------------------------------- students

async function listStudents(actor, { school_id, class_id, include_inactive }) {
  await loadClass(school_id, class_id);
  assertClassRead(actor, class_id);
  return (await platform.listStudents(school_id, class_id, { includeInactive: Boolean(include_inactive) })).map((s) => studentView(s, actor));
}

function readStudentFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.first_name != null) out.first_name = requireText(input.first_name, 'first_name', 'first name');
  if (!partial || input.last_name != null) out.last_name = requireText(input.last_name, 'last_name', 'last name');
  if (!partial || input.admission_no != null) {
    const no = requireText(input.admission_no, 'admission_no', 'admission number', 20);
    if (!ADMISSION.test(no)) throw validation('Admission numbers use letters, digits, / and - only', 'admission_no');
    out.admission_no = no;
  }
  // Guardian contact: optional. An empty value clears it; leaving a field out of an update keeps it.
  if (!partial || input.guardian_name !== undefined) {
    const name = String(input.guardian_name ?? '').trim();
    if (name.length > GUARDIAN_NAME_MAX) throw validation('The guardian name is too long', 'guardian_name');
    out.guardian_name = name || null;
  }
  if (!partial || input.guardian_phone !== undefined) {
    try {
      out.guardian_phone = normalisePhone(input.guardian_phone);
    } catch (e) {
      throw validation(e.message, 'guardian_phone');
    }
  }
  if (!partial || input.results_sms != null) out.results_sms = input.results_sms !== false;
  return out;
}

async function admissionTaken(schoolId, admissionNo) {
  const holder = await platform.admissionClaim(schoolId, admissionNo);
  const student = holder ? await platform.student(schoolId, holder.student_id) : null;
  return validation(
    `Admission number ${admissionNo} already belongs to ${student ? `${student.first_name} ${student.last_name}` : 'another student'}`,
    'admission_no'
  );
}

async function createStudent(actor, input) {
  const klass = await loadClass(input.school_id, input.class_id);
  assertClassTeacherOrAdmin(actor, input.class_id);
  if (klass.status !== 'CURRENT') throw validation(`${klass.name} is archived`, 'class_id');
  const fields = readStudentFields(input);
  try {
    const item = await school.createStudent(input.school_id, {
      student_id: `stu_${ulid().toLowerCase()}`, class_id: input.class_id, ...fields,
    }, actor);
    return studentView(item, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 1)) throw await admissionTaken(input.school_id, fields.admission_no);
    if (school.reasonAt(e, 2)) throw validation(`${klass.name} is archived or was removed`, 'class_id');
    throw e;
  }
}

async function updateStudent(actor, input) {
  const existing = await loadStudent(input.school_id, input.student_id);
  assertClassTeacherOrAdmin(actor, existing.class_id);
  const patch = readStudentFields(input, { partial: true });
  try {
    await school.updateStudent(input.school_id, existing, patch, input._version, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 0)) throw conflict(STALE);
    if (school.reasonAt(e, 2)) throw await admissionTaken(input.school_id, patch.admission_no);
    throw e;
  }
  return studentView(await loadStudent(input.school_id, input.student_id), actor);
}

/**
 * Admin only: a transfer touches two classes. Marks stay with the papers of
 * the old class; published results are unchanged; the student appears in the
 * new class's roster from now on.
 */
async function transferStudent(actor, input) {
  assertAdmin(actor);
  const existing = await loadStudent(input.school_id, input.student_id);
  if (existing.status === STUDENT_STATUS.GRADUATED) throw validation('This student has graduated, so they cannot be moved to another class', 'to_class_id');
  if (existing.class_id === input.to_class_id) throw validation('The student is already in that class', 'to_class_id');
  const destination = await loadClass(input.school_id, input.to_class_id);
  if (destination.status !== 'CURRENT') throw validation(`${destination.name} is archived`, 'to_class_id');
  try {
    await school.transferStudent(input.school_id, existing, input.to_class_id, input._version, actor);
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    if (school.reasonAt(e, 0)) throw conflict(STALE);
    if (school.reasonAt(e, 1)) throw validation(`${destination.name} is archived or was removed`, 'to_class_id');
    throw e;
  }
  return studentView(await loadStudent(input.school_id, input.student_id), actor);
}

/** Deactivate, never delete: marks, results and report cards refer to the student. */
async function setStudentStatus(actor, input) {
  const existing = await loadStudent(input.school_id, input.student_id);
  assertClassTeacherOrAdmin(actor, existing.class_id);
  if (!['ACTIVE', 'INACTIVE'].includes(input.status)) throw validation('Status must be ACTIVE or INACTIVE', 'status');
  if (existing.status === STUDENT_STATUS.GRADUATED) {
    throw validation('This student has graduated. Undo the promotion that graduated them to change this.', 'status');
  }
  if (input.status === 'ACTIVE' && existing.class_id) {
    const klass = await platform.klass(input.school_id, existing.class_id);
    if (klass && klass.status !== 'CURRENT') {
      throw validation(`${klass.name}${klass.year ? ` ${klass.year}` : ''} is archived. Move the student to a current class first.`, 'status');
    }
  }
  if (existing.status === input.status) return studentView(existing, actor);
  const metadata = {};
  if (input.status === 'INACTIVE') {
    if (!['LEFT', 'TEMPORARY'].includes(input.departure_kind)) throw validation('Choose permanently left or temporarily deactivated', 'departure_kind');
    if (!String(input.deactivation_reason || '').trim()) throw validation('Enter the reason for deactivation', 'deactivation_reason');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deactivation_date || '') || !Number.isFinite(Date.parse(input.deactivation_date)) || new Date(input.deactivation_date).toISOString().slice(0, 10) !== input.deactivation_date) throw validation('Enter a valid effective date', 'deactivation_date');
    Object.assign(metadata, { departure_kind: input.departure_kind, deactivation_reason: input.deactivation_reason.trim().slice(0, 500), deactivation_date: input.deactivation_date, left_year: Number(input.deactivation_date.slice(0, 4)) });
  }
  const updated = await school.setStudentStatus(input.school_id, input.student_id, input.status, input._version, actor, metadata).catch(staleOr);
  return studentView(updated, actor);
}