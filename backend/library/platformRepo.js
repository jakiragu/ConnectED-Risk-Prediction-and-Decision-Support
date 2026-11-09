import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

const getItem = async (schoolId, SK, consistent = false) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK }, ConsistentRead: consistent }))).Item || null;

async function queryPrefix(schoolId, prefix, extra = {}) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      ...extra,
      ExpressionAttributeValues: { ':p': pk(schoolId), ':s': prefix, ...(extra.ExpressionAttributeValues || {}) },
      ExclusiveStartKey,
    }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export const teacher = (schoolId, teacherId) => getItem(schoolId, sk.teacher(teacherId), true);
export const school = (schoolId) => getItem(schoolId, sk.school());
/** Read on every request to see whether Angaza has suspended the school; consistent so a change applies at once. */
export const schoolForAccess = (schoolId) => getItem(schoolId, sk.school(), true);
export const term = (schoolId, termId) => getItem(schoolId, sk.term(termId));
export const klass = (schoolId, classId) => getItem(schoolId, sk.klass(classId), true);
export const student = (schoolId, studentId) => getItem(schoolId, sk.student(studentId), true);
/**
 * Several students by id, in as few round trips as DynamoDB allows (100 keys a
 * request), as a Map from student_id. Replaces one GetItem per student.
 */
export async function studentsByIds(schoolId, ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((id) => ({ PK: pk(schoolId), SK: sk.student(id) }));
    for (let attempt = 0; keys.length; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 1000)));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys, ConsistentRead: true } } }));
      for (const item of res.Responses?.[TABLE] || []) out.set(item.student_id, item);
      keys = res.UnprocessedKeys?.[TABLE]?.Keys || [];
    }
  }
  return out;
}

export const admissionClaim = (schoolId, admissionNo) => getItem(schoolId, sk.admissionNo(admissionNo), true);
export const gradeRule = (schoolId, termId) => getItem(schoolId, sk.gradeRule(termId), true);

export const listTeachers = async (schoolId) =>
  (await queryPrefix(schoolId, sk.teacherPrefix())).sort((a, b) =>
    `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));

/** teacher_id -> "First Last", for naming who logged or changed a record from its current teacher record. */
export const teacherNames = async (schoolId) =>
  new Map((await listTeachers(schoolId)).map((t) => [t.teacher_id, [t.first_name, t.last_name].filter(Boolean).join(' ') || null]));

export const teacherByEmail = async (schoolId, email) =>
  (await queryPrefix(schoolId, sk.teacherPrefix(), {
    FilterExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email },
  }))[0] || null;

export const listClasses = async (schoolId) =>
  (await queryPrefix(schoolId, sk.classPrefix())).sort((a, b) => a.name.localeCompare(b.name));

export const listTerms = async (schoolId) =>
  (await queryPrefix(schoolId, sk.termPrefix())).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

const byAdmission = (a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true });

/** Students of a class. Active only unless asked; the roster used for marks and results is active only. */
export const listStudents = async (schoolId, classId, { includeInactive = false } = {}) =>
  (await queryPrefix(schoolId, sk.studentPrefix(), {
    FilterExpression: includeInactive
      ? 'class_id = :c'
      : 'class_id = :c AND (attribute_not_exists(#st) OR #st = :active)',
    ExpressionAttributeNames: includeInactive ? undefined : { '#st': 'status' },
    ExpressionAttributeValues: includeInactive ? { ':c': classId } : { ':c': classId, ':active': 'ACTIVE' },
  })).sort(byAdmission);

export const roster = (schoolId, classId) => listStudents(schoolId, classId);

/**
 * Every active student in the school, in one read. Students are not indexed by
 * class, so listStudents reads the whole school's students and filters them;
 * a page covering many classes reads them once with this instead of once per class.
 */
export const listActiveStudents = async (schoolId) =>
  (await queryPrefix(schoolId, sk.studentPrefix(), {
    FilterExpression: 'attribute_not_exists(#st) OR #st = :active',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':active': 'ACTIVE' },
  })).sort(byAdmission);

/** Active students grouped by class: class_id -> roster, ordered as listStudents orders them. */
export async function activeStudentsByClass(schoolId) {
  const out = new Map();
  for (const s of await listActiveStudents(schoolId)) {
    if (!out.has(s.class_id)) out.set(s.class_id, []);
    out.get(s.class_id).push(s);
  }
  return out;
}

/**
 * Sets a term's checkpoint weights and whether it holds an Opener. Both share
 * checkpoint_weights_version, so an End of term calculation notices either
 * changing (resultsRepo.publish checks that version).
 */
export async function setCheckpointWeights(schoolId, termId, weights, expectedVersion, actor, { openerEnabled } = {}) {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.gradeRule(termId) },
      UpdateExpression:
        'SET checkpoint_weights = :w, opener_enabled = :oe, #cv = if_not_exists(#cv, :zero) + :one, ' +
        'checkpoint_weights_updated_at = :ts, checkpoint_weights_updated_by = :by',
      ConditionExpression:
        expectedVersion === 0
          ? 'attribute_exists(PK) AND (attribute_not_exists(#cv) OR #cv = :zero)'
          : 'attribute_exists(PK) AND #cv = :exp',
      ExpressionAttributeNames: { '#cv': 'checkpoint_weights_version' },
      ExpressionAttributeValues: {
        ':w': weights, ':oe': Boolean(openerEnabled), ':zero': 0, ':one': 1, ':ts': new Date().toISOString(), ':by': actor.sub,
        ...(expectedVersion === 0 ? {} : { ':exp': expectedVersion }),
      },
      ReturnValues: 'ALL_NEW',
    })
  );
  return res.Attributes;
}