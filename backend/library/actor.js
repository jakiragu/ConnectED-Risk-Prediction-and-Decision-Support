import { identityOf } from './authz.js';
import { schoolSuspended, sessionEnded, unauthorized } from './errors.js';
import { SESSION_ENDED } from './sessions.js';
import * as platform from './platformRepo.js';

export async function resolveActor(event) {
  const id = identityOf(event);
  const [teacher, school] = await Promise.all([
    platform.teacher(id.schoolId, id.sub),
    platform.schoolForAccess(id.schoolId),
  ]);
  // Checked on every request, so a suspension takes effect at once and a reactivation as quickly.
  if (school?.status === 'SUSPENDED') {
    throw schoolSuspended('ConnectED is paused for your school by Angaza. Your records are kept. Contact Angaza to restore access.');
  }
  // Angaza is deleting the school (schoolDeletion.js): nobody is served from the moment it starts.
  if (school?.status === 'DELETING') throw unauthorized('This school has been removed from ConnectED by Angaza.');
  if (!teacher) throw unauthorized('This account is not registered at this school');
  if (teacher.status !== 'ACTIVE') throw unauthorized('This account has been deactivated');
  // Sessions ended on purpose (a Google link was removed or changed): anything issued before that is refused.
  if (teacher.sessions_ended_at && id.issuedAt && id.issuedAt < teacher.sessions_ended_at) {
    throw sessionEnded(SESSION_ENDED[teacher.sessions_ended_reason] || SESSION_ENDED.DEFAULT);
  }
  const role = teacher.role || teacher.groups?.[0];
  return {
    ...id,
    groups: role ? [role] : [],
    role,
    name: [teacher.first_name, teacher.last_name].filter(Boolean).join(' ') || id.email,
    firstName: teacher.first_name || null,
    // The account's own address, from the school's record: where security notices go.
    email: teacher.email || id.email,
    access: {
      assignments: teacher.assignments || [],
      historicalClassTeacherOf: teacher.historical_class_teacher_of || [],
      classTeacherOf: teacher.class_teacher_of || null,
    },
  };
}