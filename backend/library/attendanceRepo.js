import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi2 } from './keys.js';
import { termOpen } from './assessmentRepo.js';

const nowIso = () => new Date().toISOString();

async function queryAll(params) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** Every entry of one term's period (all classes). consistent: false costs half; an entry saved a moment ago may be missed. */
export const listPeriod = (schoolId, termId, period, { consistent = true } = {}) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.attendancePeriodPrefix(termId, period) },
    ConsistentRead: consistent,
  });

/** A student's entries for one school year, in calendar order. */
export const listStudentYear = (schoolId, studentId, academicYear) =>
  queryAll({
    TableName: TABLE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :p AND begins_with(GSI2SK, :s)',
    ExpressionAttributeValues: { ':p': gsi2.pk(schoolId, studentId), ':s': gsi2.attendanceYearPrefix(academicYear) },
  });

export async function getEntry(schoolId, termId, period, studentId) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.attendance(termId, period, studentId) }, ConsistentRead: true,
  }));
  return Item || null;
}

/**
 * Writes one entry, guarded by the version the teacher saw (null = new entry)
 * and by the class's term being open, in one transaction:
 *   [0] the entry   [1] the class's term is not locked (End of term not published)
 * @returns {{ok:true, item} | {ok:false, reason:'STALE'|'TERM_LOCKED'}}
 */
export async function putEntry(schoolId, { term, period, classId, studentId, daysAttended, daysExcused, schoolDays }, expectedVersion, actor) {
  const item = {
    PK: pk(schoolId),
    SK: sk.attendance(term.term_id, period, studentId),
    GSI2PK: gsi2.pk(schoolId, studentId),
    GSI2SK: gsi2.attendance(term.academic_year, term.term_number, period),
    entity: 'Attendance',
    school_id: schoolId,
    student_id: studentId,
    class_id: classId,
    term_id: term.term_id,
    academic_year: term.academic_year,
    term_number: term.term_number,
    period,
    days_attended: daysAttended,
    days_excused: daysExcused,
    school_days_when_entered: schoolDays,
    recorded_by: actor.sub,
    recorded_by_name: actor.name,
    recorded_at: nowIso(),
    _version: (expectedVersion ?? 0) + 1,
    _lastChangedAt: Date.now(),
  };
  const guard = expectedVersion == null
    ? { ConditionExpression: 'attribute_not_exists(PK)' }
    : { ConditionExpression: '#v = :exp', ExpressionAttributeNames: { '#v': '_version' }, ExpressionAttributeValues: { ':exp': expectedVersion } };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: item, ...guard } },
        termOpen(schoolId, term.term_id, classId),
      ],
    }));
    return { ok: true, item };
  } catch (e) {
    if (e.name !== 'TransactionCanceledException') throw e;
    const [entry, gate] = e.CancellationReasons || [];
    if (gate?.Code === 'ConditionalCheckFailed') return { ok: false, reason: 'TERM_LOCKED' };
    if (entry?.Code === 'ConditionalCheckFailed') return { ok: false, reason: 'STALE' };
    throw e;
  }
}