import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';

/**
 * One record per student, term and checkpoint: whether their guardian was sent
 * that published result by SMS. It lives beside the report cards, in the same
 * table and partition, so nothing about the table changes.
 *
 * A record counts only for the calculation it was sent for: if results are
 * recalculated and published again, the earlier SMS no longer describes them.
 */
export const SMS_STATUS = { SENDING: 'SENDING', SENT: 'SENT', FAILED: 'FAILED' };

/** A claim older than this was left by a request that died mid-send; it can be taken over. */
const STALE_MS = 2 * 60 * 1000;

/** The class's records for this published set, by student. Records of other classes or calculations are left out. */
export async function forSet(schoolId, set) {
  const out = new Map();
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
      FilterExpression: 'class_id = :c AND calculation_id = :k',
      ExpressionAttributeValues: {
        ':p': pk(schoolId), ':s': sk.resultSmsPrefix(set.term_id, set.checkpoint), ':c': set.class_id, ':k': set.calculation_id,
      },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    for (const item of res.Items || []) out.set(item.student_id, item);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const base = (schoolId, set, studentId) => ({
  PK: pk(schoolId),
  SK: sk.resultSms(set.term_id, set.checkpoint, studentId),
  entity: 'ResultSms',
  school_id: schoolId,
  class_id: set.class_id,
  term_id: set.term_id,
  checkpoint: set.checkpoint,
  calculation_id: set.calculation_id,
  student_id: studentId,
});

/**
 * Takes the right to send this student's SMS, so two clicks (or two people)
 * never send it twice. Succeeds when there is no record for this result yet,
 * the last attempt failed, an earlier claim went stale, or `resend` is asked
 * for a message already sent. Returns false when someone else holds it or it
 * was already sent.
 */
export async function claim(schoolId, set, studentId, actor, { resend = false } = {}) {
  const now = new Date();
  const allowed = [
    'attribute_not_exists(SK)',
    'calculation_id <> :k',
    'class_id <> :c',
    '#st = :failed',
    '(#st = :sending AND claimed_at < :stale)',
    ...(resend ? ['#st = :sent'] : []),
  ];
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { ...base(schoolId, set, studentId), status: SMS_STATUS.SENDING, claimed_at: now.toISOString(), requested_by: actor.sub },
      ConditionExpression: allowed.join(' OR '),
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':k': set.calculation_id, ':c': set.class_id, ':failed': SMS_STATUS.FAILED, ':sending': SMS_STATUS.SENDING,
        ':stale': new Date(now.getTime() - STALE_MS).toISOString(),
        ...(resend ? { ':sent': SMS_STATUS.SENT } : {}),
      },
    }));
    return true;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/** Records what the provider said. The number itself is not kept here, only its last digits. */
export async function finish(schoolId, set, studentId, actor, outcome) {
  const at = new Date().toISOString();
  const item = {
    ...base(schoolId, set, studentId),
    status: outcome.sent ? SMS_STATUS.SENT : SMS_STATUS.FAILED,
    requested_by: actor.sub,
    to_hint: outcome.to_hint ?? null,
    segments: outcome.segments ?? null,
    provider_id: outcome.provider_id ?? null,
    cost: outcome.cost ?? null,
    problem: outcome.sent ? null : (outcome.problem ?? 'The message was not sent.'),
    ...(outcome.sent ? { sent_at: at } : { failed_at: at }),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}
