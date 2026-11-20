import { forbidden, unauthorized } from './errors.js';
import { isPlatformIdentity } from './platformAuth.js';

export const ROLE = {
  ADMIN: 'Admin',
  TEACHER: 'Teacher',
};
export const ROLES = Object.values(ROLE);

/** @returns {{sub:string, schoolId:string, groups:string[], email:string}} the token's view only */
export function identityOf(event) {
  const id = event?.identity;
  if (!id?.sub) throw unauthorized('No authenticated identity on request');
  // An Angaza account never acts inside a school, even if a token were somehow given a school claim.
  if (isPlatformIdentity(event)) throw unauthorized('Angaza accounts cannot open a school’s gradebook. Use the Angaza console.');
  const claims = id.claims || {};
  const schoolId = claims['custom:school_id'];
  if (!schoolId) throw unauthorized('Token carries no school scope');
  return {
    sub: id.sub,
    schoolId,
    groups: id.groups || claims['cognito:groups'] || [],
    email: claims.email,
    name: claims.name || claims.email,
    ...sessionTimes(claims),
  };
}

/** When the person last proved who they are (auth_time) and when this token was issued, in seconds. */
export const sessionTimes = (claims = {}) => ({ authTime: Number(claims.auth_time) || 0, issuedAt: Number(claims.iat) || 0 });

export const hasRole = (actor, ...roles) => roles.some((r) => actor.groups.includes(r));
export const isAdmin = (actor) => hasRole(actor, ROLE.ADMIN);

export function assertTenant(actor, schoolId) {
  if (actor.schoolId !== schoolId) {
    throw forbidden('Request is outside your school');
  }
}

export function assertAdmin(actor) {
  if (!isAdmin(actor)) throw forbidden('Only an administrator can do this');
}

const access = (actor) => actor.access || { assignments: [], classTeacherOf: null };

export const isClassTeacherOf = (actor, classId) => access(actor).classTeacherOf === classId;

/** Classes a teacher works in: any subject assignment, or class teacher. */
export const readableClassIds = (actor) =>
  new Set([...access(actor).assignments.map((a) => a.class_id), access(actor).classTeacherOf, ...(access(actor).historicalClassTeacherOf || [])].filter(Boolean));

export const canReadClass = (actor, classId) => isAdmin(actor) || readableClassIds(actor).has(classId);

export function assertClassRead(actor, classId) {
  if (!canReadClass(actor, classId)) throw forbidden('You are not assigned to this class');
}

/** null = every subject (Admin, or the class teacher); otherwise the teacher's subjects in that class. */
export function visibleSubjects(actor, classId) {
  if (isAdmin(actor) || isClassTeacherOf(actor, classId) || (access(actor).historicalClassTeacherOf || []).includes(classId)) return null;
  return new Set(access(actor).assignments.filter((a) => a.class_id === classId).map((a) => a.subject));
}

export const canSeeSubject = (actor, classId, subject) => {
  const subjects = visibleSubjects(actor, classId);
  return subjects === null || subjects.has(subject);
};

export const subjectsITeach = (actor, classId) =>
  access(actor).assignments.filter((a) => a.class_id === classId).map((a) => a.subject);

export const canWriteSubject = (actor, classId, subject) =>
  isAdmin(actor) ||isClassTeacherOf(actor, classId) || access(actor).assignments.some((a) => a.class_id === classId && a.subject === subject);

export function assertSubjectWrite(actor, classId, subject) {
  if (!canWriteSubject(actor, classId, subject)) {
    throw forbidden(`You are not assigned to teach ${subject} in this class`);
  }
}

export function assertClassTeacherOrAdmin(actor, classId) {
  if (!isAdmin(actor) && !isClassTeacherOf(actor, classId)) {
    throw forbidden('Only the class teacher or an administrator can do this');
  }
}

export function assertCanLock(actor) {
  if (!isAdmin(actor)) throw forbidden('Only an administrator can lock an assessment');
}

/** CSG 6.3 "academic head" and proposal FR-05 "administrator" are the same role here. */
export function assertCanPublish(actor) {
  if (!isAdmin(actor)) throw forbidden('Only an administrator can calculate or publish results');
}

export const canReviewResults = (actor) => isAdmin(actor);

export function assertGradebookRole(actor) {
  if (!hasRole(actor, ROLE.ADMIN, ROLE.TEACHER)) throw forbidden('Your role has no gradebook access');
}