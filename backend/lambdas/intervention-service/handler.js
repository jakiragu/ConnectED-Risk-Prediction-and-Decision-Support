import { assertGradebookRole, assertTenant } from '../../library/authz.js';
import { resolveActor } from '../../library/actor.js';
import { FACTORS, INTERVENTION_STATUS, canSeeFactor, methodKey, validateIntervention } from '../../library/decisionSupport.js';
import { forbidden, notFound, validation } from '../../library/errors.js';
import * as interventions from '../../library/interventionRepo.js';
import { interventionView, latestOf, linkFor, studentContext, studentYear, visibleInterventions } from '../../library/riskProfile.js';

/**
 * Interventions teachers record against a student's risk record (FR-12), and
 * the methods remembered from them as suggestions.
 *
 * Who: administrators and the student's class teacher for any factor; a
 * subject teacher in the student's class for the subjects they teach there.
 * An intervention is linked to the prediction it responds to (the student's
 * latest this year: point, run, model version, estimate and the target set for
 * its factor at that time), so it stays traceable when later predictions arrive.
 *
 * The teacher decides on the intervention; the system only records it and,
 * later, what followed it. Retrying a create with the same intervention_id
 * (the offline queue does) returns the intervention already made.
 */
export async function handler(event) {
  const actor = await resolveActor(event);
  assertGradebookRole(actor);
  const args = event.arguments || {};
  const input = args.input || args;
  assertTenant(actor, input.school_id);

  switch (event.info.fieldName) {
    case 'listStudentInterventions':
      return listStudentInterventions(actor, args);
    case 'listInterventionMethods':
      return listInterventionMethods(actor, args);
    case 'saveIntervention':
      return saveIntervention(actor, input);
    case 'deleteIntervention':
      return deleteIntervention(actor, input);
    default:
      throw notFound(`No handler for ${event.info.fieldName}`);
  }
}

async function contextOrThrow(actor, schoolId, studentId) {
  const ctx = await studentContext(actor, schoolId, studentId);
  if (!ctx) throw notFound('Student not found');
  if (!ctx.scope) throw forbidden('You do not teach this student');
  return ctx;
}

/** Graduated students and students who left keep their interventions as a record; nothing new is logged. */
function assertActiveStudent(ctx) {
  if ((ctx.student.status || 'ACTIVE') !== 'ACTIVE') {
    throw validation('This student has graduated or left the school, so their interventions can no longer be changed', 'student_id');
  }
}

async function listStudentInterventions(actor, { school_id, student_id }) {
  const ctx = await contextOrThrow(actor, school_id, student_id);
  const year = await studentYear(school_id, student_id, ctx.academicYear, ctx.terms);
  return visibleInterventions(school_id, student_id, ctx.scope, year);
}

async function listInterventionMethods(actor, { school_id, factor }) {
  if (factor && !FACTORS.includes(factor)) throw validation('Unknown subject', 'factor');
  const items = await interventions.listMethods(school_id, factor || null);
  return items
    .map((m) => ({
      factor: m.factor,
      method: m.method,
      added_by_name: m.added_by_name ?? null,
      teachers_used: m.teacher_ids?.size ?? 0,
      uses: m.uses ?? 0,
      last_used_at: m.last_used_at ?? null,
    }))
    .sort((a, b) => b.teachers_used - a.teachers_used || b.uses - a.uses || a.method.localeCompare(b.method));
}

function assertFactor(ctx, factor) {
  if (!canSeeFactor(ctx.scope, factor)) {
    throw forbidden(factor === 'Attendance'
      ? 'Only the class teacher or an administrator can record attendance interventions'
      : `You do not teach ${factor} in this student's class`);
  }
}

async function saveIntervention(actor, input) {
  if (!input.intervention_id || !/^[0-9A-Za-z_-]{10,40}$/.test(input.intervention_id)) {
    throw validation('intervention_id must be the id the client generated', 'intervention_id');
  }
  const checked = validateIntervention(input);
  if (!checked.ok) throw validation(checked.reason, checked.field);
  const ctx = await contextOrThrow(actor, input.school_id, input.student_id);
  assertActiveStudent(ctx);
  assertFactor(ctx, checked.value.factor);
  const year = await studentYear(input.school_id, input.student_id, ctx.academicYear, ctx.terms);

  const existing = await interventions.get(input.school_id, input.student_id, input.intervention_id);
  if (input._version == null) {
    if (existing) return replayedCreate(existing, checked.value, actor, year);
    if (!ctx.student.class_id) throw validation('This student is not in a class', 'student_id');
    const { latest } = latestOf(year);
    const { created, item } = await interventions.create(input.school_id, {
      intervention_id: input.intervention_id,
      student_id: input.student_id,
      class_id: ctx.student.class_id,
      ...checked.value,
      linked: linkFor(latest, checked.value.factor),
    }, actor);
    if (!created) return replayedCreate(item, checked.value, actor, year);
    await remember(input.school_id, item.factor, item.method, actor);
    return interventionView(item, year);
  }

  if (!existing || existing.deleted_at) throw notFound('This intervention was deleted');
  assertFactor(ctx, existing.factor); // a subject teacher cannot take over another subject's intervention
  const patch = { ...checked.value };
  if (patch.status === INTERVENTION_STATUS.ONGOING) patch.stopped_on = null;
  if (patch.factor !== existing.factor && existing.linked) {
    // Same prediction it responded to; the target becomes the one set for the new factor at that time.
    const prediction = year.predictions.find((p) => p.prediction_point === existing.linked.prediction_point);
    const savedChange = existing.linked.target_changes?.find((c) => c.group === patch.factor);
    patch.linked = { ...existing.linked, target: existing.linked.target_changes
      ? (savedChange ? { ...savedChange, method: existing.linked.target?.method ?? null } : null)
      : prediction ? linkFor(prediction, patch.factor).target : null };
  }
  const updated = await interventions.update(input.school_id, existing, patch, input._version, actor);
  if (methodKey(patch.method) !== methodKey(existing.method) || patch.factor !== existing.factor) {
    await remember(input.school_id, patch.factor, patch.method, actor);
  }
  return interventionView(updated, year);
}

/** Suggestions are secondary: failing to remember a method never fails the save that already happened. */
async function remember(schoolId, factor, method, actor) {
  try {
    await interventions.rememberMethod(schoolId, { factor, method, key: methodKey(method) }, actor);
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', svc: 'intervention-service', msg: 'could not remember method', err: e.message }));
  }
}

/** A create sent again (lost response, offline retry): the same author and content is the same intervention. */
function replayedCreate(existing, value, actor, year) {
  const same = existing.created_by === actor.sub && existing.factor === value.factor && methodKey(existing.method) === methodKey(value.method);
  if (!same || existing.deleted_at) throw validation('An intervention with this id already exists', 'intervention_id');
  return interventionView(existing, year);
}

async function deleteIntervention(actor, { school_id, student_id, intervention_id, _version }) {
  const ctx = await contextOrThrow(actor, school_id, student_id);
  assertActiveStudent(ctx);
  const existing = await interventions.get(school_id, student_id, intervention_id);
  if (!existing) throw notFound('Intervention not found');
  assertFactor(ctx, existing.factor);
  if (existing.deleted_at) return { ...interventionView(existing, null), deleted: true };
  const item = await interventions.softDelete(school_id, existing, _version, actor);
  return { ...interventionView(item, null), deleted: true };
}
