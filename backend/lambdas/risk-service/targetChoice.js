import { assertTenant, assertClassTeacherOrAdmin } from '../../library/authz.js';
import { conflict, notFound, validation } from '../../library/errors.js';
import { studentContext, studentYear, latestOf } from '../../library/riskProfile.js';
import { predictionTargets, targetToken } from '../../library/targetChoice.js';
import { saveTargetChoice } from '../../library/riskRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function selectStudentTarget(actor, input) {
  assertTenant(actor, input.school_id);
  const ctx = await studentContext(actor, input.school_id, input.student_id);
  if (!ctx) throw notFound('Student not found');
  assertClassTeacherOrAdmin(actor, ctx.student.class_id);
  const klass = ctx.student.class_id ? await platform.klass(input.school_id, ctx.student.class_id) : null;
  if ((ctx.student.status || 'ACTIVE') !== 'ACTIVE' || !klass || klass.status === 'PAST') throw validation('Only active students in current classes can change targets');
  const year = await studentYear(input.school_id, input.student_id, ctx.academicYear, ctx.terms);
  const { latest, current } = latestOf(year);
  if (!latest || !current || targetToken(latest) !== input.prediction_token) throw conflict('The prediction changed or is not current. Refresh this student before choosing a target.');
  const options = latest.counterfactuals?.options || [];
  if (!['FOUND', 'FALLBACK'].includes(latest.counterfactuals?.status) || !Number.isInteger(input.option_index) || input.option_index < 0 || input.option_index >= options.length) throw validation('Choose an available counterfactual option');
  if (!Number.isInteger(input.expected_version) || input.expected_version < 0) throw validation('A valid selection version is required');
  const updated = await saveTargetChoice(input.school_id, latest, input.option_index, actor, input.expected_version);
  return predictionTargets(updated);
}
