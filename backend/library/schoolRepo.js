import { PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi1 } from './keys.js';

const nowIso = () => new Date().toISOString();

/** Errors the school service maps to messages. */
export const STALE = 'Stale';
const fail = (name) => Object.assign(new Error(name), { name });
export const reasonAt = (e, index) =>
  e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

function setClause(patch, names, values) {
  const sets = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    sets.push(`#${key} = :${key}`);
  }
  return sets;
}

/** Guarded update: the row exists and is at the version the caller saw. */
async function versioned(schoolId, SK, patch, expectedVersion, { extraCondition = '', extraNames = {}, extraValues = {}, remove = [] } = {}) {
  const names = { '#v': '_version', ...extraNames };
  const values = { ':exp': expectedVersion, ':one': 1, ':ts': nowIso(), ...extraValues };
  const sets = [...setClause(patch, names, values), 'updated_at = :ts', '#v = #v + :one'];
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK },
      UpdateExpression: `SET ${sets.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
      ConditionExpression: `attribute_exists(PK) AND #v = :exp${extraCondition ? ` AND ${extraCondition}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw fail(STALE);
    throw e;
  }
}

// ------------------------------------------------------------------ teachers

/** Idempotent: a retry of an interrupted create finds its own row. */
export async function putTeacher(schoolId, teacher) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.teacher(teacher.teacher_id),
    entity: 'Teacher',
    school_id: schoolId,
    assignments: [],
    class_teacher_of: null,
    status: 'ACTIVE',
    created_at: ts,
    updated_at: ts,
    _version: 1,
    ...teacher,
  };
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
    return { item, created: true };
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return { item: null, created: false };
  }
}

export const updateTeacher = (schoolId, teacherId, patch, expectedVersion) =>
  versioned(schoolId, sk.teacher(teacherId), patch, expectedVersion);

/**
 * Replaces a deactivated person's record with one that holds only their name, marked DELETED
 * (accountDeletion.js). A whole-record replacement, so no personal detail can be left behind by
 * a field this function does not know about. Refused (STALE) unless the record is still deactivated.
 */
export async function tombstoneTeacher(schoolId, person, { at, by }) {
  const item = {
    PK: pk(schoolId),
    SK: sk.teacher(person.teacher_id),
    entity: 'Teacher',
    school_id: schoolId,
    teacher_id: person.teacher_id,
    first_name: person.first_name,
    last_name: person.last_name,
    status: 'DELETED',
    assignments: [],
    class_teacher_of: null,
    created_at: person.created_at ?? null,
    deleted_at: at,
    deleted_by: by,
    updated_at: at,
    _version: (person._version ?? 1) + 1,
  };
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: '#st = :inactive',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':inactive': 'INACTIVE' },
    }));
    return item;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    throw fail(STALE);
  }
}


export async function setClassTeacher(schoolId, klass, teacherId, expectedVersion) {
  const ts = nowIso();
  const previous = klass.class_teacher_id || null;
  const items = [{
    Update: {
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.klass(klass.class_id) },
      UpdateExpression: teacherId
        ? 'SET class_teacher_id = :t, updated_at = :ts, #v = #v + :one'
        : 'SET updated_at = :ts, #v = #v + :one REMOVE class_teacher_id',
      ConditionExpression: 'attribute_exists(PK) AND #v = :exp',
      ExpressionAttributeNames: { '#v': '_version' },
      ExpressionAttributeValues: { ':exp': expectedVersion, ':ts': ts, ':one': 1, ...(teacherId ? { ':t': teacherId } : {}) },
    },
  }];
  const index = { klass: 0 };
  if (previous && previous !== teacherId) {
    index.previous = items.length;
    items.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.teacher(previous) },
        UpdateExpression: 'SET class_teacher_of = :null, updated_at = :ts, #v = #v + :one',
        ConditionExpression: 'attribute_exists(PK) AND class_teacher_of = :c',
        ExpressionAttributeNames: { '#v': '_version' },
        ExpressionAttributeValues: { ':null': null, ':c': klass.class_id, ':ts': ts, ':one': 1 },
      },
    });
  }
  if (teacherId && teacherId !== previous) {
    index.next = items.length;
    items.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.teacher(teacherId) },
        UpdateExpression: 'SET class_teacher_of = :c, updated_at = :ts, #v = #v + :one',
        ConditionExpression:
          'attribute_exists(PK) AND #st = :active AND #role = :teacher AND ' +
          '(attribute_not_exists(class_teacher_of) OR class_teacher_of = :null OR class_teacher_of = :c)',
        ExpressionAttributeNames: { '#v': '_version', '#st': 'status', '#role': 'role' },
        ExpressionAttributeValues: { ':c': klass.class_id, ':ts': ts, ':one': 1, ':active': 'ACTIVE', ':teacher': 'Teacher', ':null': null },
      },
    });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    e.classTeacherIndex = index;
    throw e;
  }
}

// ------------------------------------------------------------------- classes

export async function createClass(schoolId, klass) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.klass(klass.class_id),
    entity: 'Class',
    school_id: schoolId,
    status: 'CURRENT',
    created_at: ts,
    updated_at: ts,
    _version: 1,
    ...klass,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
  return item;
}

export const updateClass = (schoolId, classId, patch, expectedVersion) =>
  versioned(schoolId, sk.klass(classId), patch, expectedVersion);

/** Only an empty class with no class teacher; the caller checks students, papers and assignments first. */
export async function deleteClass(schoolId, classId, expectedVersion) {
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [{
        Delete: {
          TableName: TABLE,
          Key: { PK: pk(schoolId), SK: sk.klass(classId) },
          ConditionExpression: 'attribute_exists(PK) AND #v = :exp AND attribute_not_exists(class_teacher_id)',
          ExpressionAttributeNames: { '#v': '_version' },
          ExpressionAttributeValues: { ':exp': expectedVersion },
        },
      }],
    }));
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw fail(STALE);
    throw e;
  }
}

/** Any assessment of the class, in any term, live or deleted. */
export async function classHasAssessments(schoolId, classId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :s)',
    ExpressionAttributeValues: { ':p': gsi1.pk(schoolId, classId), ':s': 'TERM#' },
    Limit: 1,
  }));
  return (res.Items || []).length > 0;
}

// ------------------------------------------------------------------ students

const openClass = (schoolId, classId) => ({
  ConditionCheck: {
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.klass(classId) },
    ConditionExpression: 'attribute_exists(PK) AND #st = :current',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':current': 'CURRENT' },
  },
});

const claim = (schoolId, admissionNo, studentId) => ({
  Put: {
    TableName: TABLE,
    Item: { PK: pk(schoolId), SK: sk.admissionNo(admissionNo), entity: 'AdmissionNo', admission_no: admissionNo, student_id: studentId },
    ConditionExpression: 'attribute_not_exists(PK) OR student_id = :id',
    ExpressionAttributeValues: { ':id': studentId },
  },
});

const release = (schoolId, admissionNo, studentId) => ({
  Delete: {
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.admissionNo(admissionNo) },
    ConditionExpression: 'attribute_not_exists(PK) OR student_id = :id',
    ExpressionAttributeValues: { ':id': studentId },
  },
});

/**
 * Transaction items: [0] student, [1] admission number, [2] class is open.
 * Idempotent for a retry with the same student id.
 */
export async function createStudent(schoolId, student, actor) {
  const ts = nowIso();
  const item = {
    PK: pk(schoolId),
    SK: sk.student(student.student_id),
    entity: 'Student',
    school_id: schoolId,
    status: 'ACTIVE',
    created_at: ts,
    created_by: actor.sub,
    updated_at: ts,
    updated_by: actor.sub,
    _version: 1,
    ...student,
  };
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      claim(schoolId, student.admission_no, student.student_id),
      openClass(schoolId, student.class_id),
    ],
  }));
  return item;
}

/**
 * Names and admission number. A changed admission number moves its claim in the
 * same transaction. Items: [0] student, then [1] release old, [2] claim new.
 */
export async function updateStudent(schoolId, existing, patch, expectedVersion, actor) {
  const names = { '#v': '_version' };
  const values = { ':exp': expectedVersion, ':one': 1, ':ts': nowIso(), ':by': actor.sub };
  const sets = [...setClause(patch, names, values), 'updated_at = :ts', 'updated_by = :by', '#v = #v + :one'];
  const items = [{
    Update: {
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.student(existing.student_id) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK) AND #v = :exp',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  }];
  const moved = patch.admission_no !== undefined && patch.admission_no !== existing.admission_no;
  if (moved) {
    items.push(release(schoolId, existing.admission_no, existing.student_id));
    items.push(claim(schoolId, patch.admission_no, existing.student_id));
  }
  await ddb.send(new TransactWriteCommand({ TransactItems: items }));
}

/** Items: [0] student still in `fromClassId` at the version seen, [1] destination class is open. */
export async function transferStudent(schoolId, existing, toClassId, expectedVersion, actor) {
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk(schoolId), SK: sk.student(existing.student_id) },
          UpdateExpression: 'SET class_id = :to, updated_at = :ts, updated_by = :by, #v = #v + :one',
          ConditionExpression: 'attribute_exists(PK) AND #v = :exp AND class_id = :from',
          ExpressionAttributeNames: { '#v': '_version' },
          ExpressionAttributeValues: {
            ':to': toClassId, ':from': existing.class_id, ':exp': expectedVersion, ':ts': nowIso(), ':by': actor.sub, ':one': 1,
          },
        },
      },
      openClass(schoolId, toClassId),
    ],
  }));
}

export const setStudentStatus = (schoolId, studentId, status, expectedVersion, actor, metadata = {}) =>
  versioned(schoolId, sk.student(studentId), { status, ...metadata, updated_by: actor.sub }, expectedVersion);