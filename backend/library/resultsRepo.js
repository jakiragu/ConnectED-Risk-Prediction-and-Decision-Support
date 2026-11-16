import {
  BatchGetCommand,
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';
import { termOpen } from './assessmentRepo.js';
import { CHECKPOINT, previousOf } from './results.js';
import { digestOf, rowsOf } from './resultDigest.js';

const nowIso = () => new Date().toISOString();

export const STATUS = { CALCULATED: 'CALCULATED', PUBLISHED: 'PUBLISHED' };
export const EVENT_STATUS = { PENDING: 'PENDING', SENT: 'SENT' };
export const REPORTS = { PENDING: 'PENDING', RUNNING: 'RUNNING', COMPLETE: 'COMPLETE', FAILED: 'FAILED' };

/** Transaction limit is 100 items: set + gate + predecessor + grade rule + papers. */
export const MAX_PUBLISH_PAPERS = 96;

const setKey = (schoolId, { termId, classId, checkpoint }) => ({
  PK: pk(schoolId),
  SK: sk.resultSet(termId, classId, checkpoint),
});
export const scopeOfSet = (set) => ({ termId: set.term_id, classId: set.class_id, checkpoint: set.checkpoint });

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

async function batchWrite(requests) {
  for (let i = 0; i < requests.length; i += 25) {
    let pending = requests.slice(i, i + 25);
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the result rows');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
}

export async function getSet(schoolId, scope) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: setKey(schoolId, scope), ConsistentRead: true }));
  return Item || null;
}

export const listSetsForClass = (schoolId, { termId, classId }) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.resultSetClassPrefix(termId, classId) },
    ConsistentRead: true,
  });

/** consistent: false costs half; a set just changed may then show its previous state for about a second. */
export const listSetsForTerm = (schoolId, termId, { consistent = true } = {}) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.resultSetTermPrefix(termId) },
    ConsistentRead: consistent,
  });

export const listRows = (schoolId, set, { consistent = true } = {}) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: {
      ':p': pk(schoolId),
      ':s': sk.termResultPrefix(set.term_id, set.class_id, set.checkpoint, set.calculation_id),
    },
    ConsistentRead: consistent,
  });

// ------------------------------------------------------------- result digests

const digestKey = (schoolId, set) => ({
  PK: pk(schoolId),
  SK: sk.resultDigest(set.term_id, set.class_id, set.checkpoint, set.calculation_id),
});

/** Writes the digest of a published set (resultDigest.js). Idempotent: the same set always gives the same digest. */
export async function putDigest(schoolId, set, rows) {
  const digest = digestOf(set, rows);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...digestKey(schoolId, set), entity: 'ResultDigest', school_id: schoolId, created_at: nowIso(), ...digest },
  }));
  return digest;
}

/** Stored digests of these sets, as a Map from digest SK. Missing ones are simply absent. */
async function readDigests(schoolId, sets) {
  const out = new Map();
  const keys = [...new Map(sets.map((s) => [digestKey(schoolId, s).SK, digestKey(schoolId, s)])).values()];
  for (let i = 0; i < keys.length; i += 100) {
    let pending = keys.slice(i, i + 100);
    for (let attempt = 0; pending.length; attempt += 1) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the result digests');
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 1000)));
      // Eventually consistent is safe: a digest never changes once written, and one not seen yet is rebuilt.
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: pending } } }));
      for (const item of res.Responses?.[TABLE] || []) out.set(item.SK, item);
      pending = res.UnprocessedKeys?.[TABLE]?.Keys || [];
    }
  }
  return out;
}

/**
 * A digest written before this existed is made from the full rows once, then stored. The rows were
 * written before the set was calculated, let alone published, so a cheaper eventually consistent
 * read already has them all; if it somehow does not, the count gives it away and they are re-read.
 */
async function buildDigest(schoolId, set) {
  let rows = await listRows(schoolId, set, { consistent: false });
  if (rows.length !== (set.student_ids || []).length) rows = await listRows(schoolId, set);
  try {
    return await putDigest(schoolId, set, rows);
  } catch (e) {
    console.log(JSON.stringify({ level: 'warn', msg: 'Result digest not stored; it is rebuilt on the next visit', set: set.SK, err: e.message }));
    return digestOf(set, rows);
  }
}

async function loadDigests(schoolId, sets) {
  const stored = await readDigests(schoolId, sets);
  const out = new Map();
  const missing = [];
  for (const set of sets) {
    const item = stored.get(digestKey(schoolId, set).SK);
    if (item) out.set(set, item);
    else missing.push(set);
  }
  // A few at a time, so catching up on many old sets does not hit the table all at once.
  for (let i = 0; i < missing.length; i += 4) {
    const built = await Promise.all(missing.slice(i, i + 4).map((set) => buildDigest(schoolId, set)));
    missing.slice(i, i + 4).forEach((set, j) => out.set(set, built[j]));
  }
  return out;
}

// Digests this running function has already read. A published set's digest never changes, so moving
// between exams on the class page re-reads none of them. Bounded; the oldest entries go first.
const digestCache = new Map();
const DIGEST_CACHE_LIMIT = 2000;

/**
 * The rows of published sets, for pages that chart and compare results (classProfile.js), as a Map
 * from set SK to rows rebuilt from each set's digest: no paper-by-paper detail. Not for report cards,
 * SMS or anything that shows marks; read those from listRows.
 */
export async function publishedRows(schoolId, sets) {
  for (const set of sets) {
    if (set.status !== STATUS.PUBLISHED || !set.calculation_id) throw new Error(`${set.SK} is not published`);
  }
  const cacheKey = (set) => `${schoolId}|${digestKey(schoolId, set).SK}`;
  const unique = [...new Map(sets.map((s) => [cacheKey(s), s])).values()];
  const pending = unique.filter((s) => !digestCache.has(cacheKey(s)));
  const digests = new Map(unique.map((s) => [cacheKey(s), digestCache.get(cacheKey(s))]));
  if (pending.length) {
    const loading = loadDigests(schoolId, pending);
    for (const set of pending) {
      const one = loading.then((m) => m.get(set));
      one.catch(() => { if (digestCache.get(cacheKey(set)) === one) digestCache.delete(cacheKey(set)); }); // not remembered
      digestCache.set(cacheKey(set), one);
      digests.set(cacheKey(set), one);
    }
    for (const key of digestCache.keys()) {
      if (digestCache.size <= DIGEST_CACHE_LIMIT) break;
      digestCache.delete(key);
    }
  }
  const out = new Map();
  for (const set of sets) out.set(set.SK, rowsOf(await digests.get(cacheKey(set))));
  return out;
}

export async function getRow(schoolId, set, studentId) {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.termResult(set.term_id, set.class_id, set.checkpoint, set.calculation_id, studentId) },
      ConsistentRead: true,
    })
  );
  return Item || null;
}

export async function saveCalculation(schoolId, scope, { calculationId, calc, existing, actor, extra = {} }) {
  const ts = nowIso();
  const rows = calc.rows.map((r) => ({
    PK: pk(schoolId),
    SK: sk.termResult(scope.termId, scope.classId, scope.checkpoint, calculationId, r.student_id),
    entity: 'TermResult',
    term_result_id: `${scope.termId}#${scope.classId}#${scope.checkpoint}#${r.student_id}`,
    school_id: schoolId,
    class_id: scope.classId,
    term_id: scope.termId,
    checkpoint: scope.checkpoint,
    calculation_id: calculationId,
    calculated_at: ts,
    ...r,
  }));
  await batchWrite(rows.map((Item) => ({ PutRequest: { Item } })));

  const item = {
    ...setKey(schoolId, scope),
    entity: 'ResultSet',
    school_id: schoolId,
    class_id: scope.classId,
    term_id: scope.termId,
    checkpoint: scope.checkpoint,
    kind: calc.kind,
    status: STATUS.CALCULATED,
    calculation_id: calculationId,
    subjects: calc.subjects,
    basis: calc.basis,
    issues: calc.issues,
    blocking: calc.blocking,
    student_ids: calc.rows.map((r) => r.student_id),
    calculated_at: ts,
    calculated_by: actor.sub,
    created_at: existing?.created_at || ts,
    updated_at: ts,
    _version: existing ? existing._version + 1 : 1,
    _lastChangedAt: Date.now(),
    ...extra,
  };
  const guard = existing
    ? {
        ConditionExpression: '#v = :exp AND #st = :calc',
        ExpressionAttributeNames: { '#v': '_version', '#st': 'status' },
        ExpressionAttributeValues: { ':exp': existing._version, ':calc': STATUS.CALCULATED },
      }
    : { ConditionExpression: 'attribute_not_exists(PK)' };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: item, ...guard } },
        termOpen(schoolId, scope.termId, scope.classId),
      ],
    })
  );
  return item;
}

/** Best effort: rows of a superseded calculation are unreachable anyway. */
export async function dropRows(schoolId, set) {
  if (!set?.calculation_id) return;
  const rows = await listRows(schoolId, set);
  await batchWrite(rows.map((r) => ({ DeleteRequest: { Key: { PK: r.PK, SK: r.SK } } })));
}

export async function publish(schoolId, set, actor) {
  const ts = nowIso();
  const now = Date.now();
  const scope = scopeOfSet(set);
  const final = set.checkpoint === CHECKPOINT.ENDTERM;
  // The order this result was calculated under: no Opener this term means Mid-term has no predecessor.
  const previous = previousOf(set.checkpoint, set.basis_opener_enabled ?? true);
  const index = {};
  const items = [];
  const push = (name, item) => {
    index[name] = items.length;
    items.push(item);
  };

  push('set', {
    Update: {
      TableName: TABLE,
      Key: setKey(schoolId, scope),
      UpdateExpression:
        'SET #st = :pub, published_at = :ts, published_by = :by, published_from_version = :exp, ' +
        'event_id = :eid, event_status = :pending, report_cards_status = :pending, report_attempt = :one, ' +
        'report_cards_expected = :n, updated_at = :ts, #lc = :lc, #v = #v + :one',
      ConditionExpression: '#st = :calc AND #v = :exp',
      ExpressionAttributeNames: { '#st': 'status', '#v': '_version', '#lc': '_lastChangedAt' },
      ExpressionAttributeValues: {
        ':pub': STATUS.PUBLISHED, ':calc': STATUS.CALCULATED, ':exp': set._version, ':ts': ts, ':by': actor.sub,
        ':eid': `${set.SK}#v${set._version + 1}`, ':pending': EVENT_STATUS.PENDING, ':lc': now, ':one': 1,
        ':n': (set.student_ids || []).length,
      },
    },
  });

  push('gate', final
    ? {
        Put: {
          TableName: TABLE,
          Item: {
            PK: pk(schoolId),
            SK: sk.termLock(set.term_id, set.class_id),
            entity: 'TermLock',
            school_id: schoolId,
            class_id: set.class_id,
            term_id: set.term_id,
            locked_at: ts,
            locked_by: actor.sub,
            result_set: set.SK,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      }
    : termOpen(schoolId, set.term_id, set.class_id));

  if (previous) {
    push('previous', {
      ConditionCheck: {
        TableName: TABLE,
        Key: setKey(schoolId, { ...scope, checkpoint: previous }),
        ConditionExpression: '#st = :pub',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':pub': STATUS.PUBLISHED },
      },
    });
  }
  if (final) {
    push('weights', {
      ConditionCheck: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.gradeRule(set.term_id) },
        ConditionExpression: '#cv = :seen',
        ExpressionAttributeNames: { '#cv': 'checkpoint_weights_version' },
        ExpressionAttributeValues: { ':seen': set.basis_weights_version },
      },
    });
  }

  index.papers = items.length;
  for (const b of set.basis) {
    items.push({
      Update: {
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: sk.assessment(b.assessment_id) },
        UpdateExpression:
          'SET #st = :locked, updated_at = :ts, updated_by = :by, #lc = :lc, #v = #v + :one ADD #pub :cp',
        ConditionExpression: 'attribute_exists(PK) AND #d = :f AND #lc = :seenLc AND #v = :seenV',
        ExpressionAttributeNames: {
          '#st': 'status', '#d': '_deleted', '#lc': '_lastChangedAt', '#v': '_version', '#pub': 'published_in',
        },
        ExpressionAttributeValues: {
          ':locked': 'LOCKED', ':ts': ts, ':by': actor.sub, ':lc': now, ':one': 1, ':f': false,
          ':seenLc': b._lastChangedAt, ':seenV': b._version, ':cp': new Set([set.checkpoint]),
        },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    e.publishIndex = index;
    throw e;
  }
  return getSet(schoolId, scope);
}

async function updateSet(schoolId, set, { set: assignments, condition, names = {}, values = {}, add }) {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(schoolId), SK: set.SK },
        UpdateExpression: `SET ${assignments.join(', ')}${add ? ` ADD ${add}` : ''}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );
    return res.Attributes;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return getSet(schoolId, scopeOfSet(set));
  }
}

export const markEventSent = (schoolId, set) =>
  updateSet(schoolId, set, {
    set: ['event_status = :sent', 'event_sent_at = :ts'],
    condition: 'event_status = :pending AND event_id = :eid',
    values: { ':sent': EVENT_STATUS.SENT, ':pending': EVENT_STATUS.PENDING, ':eid': set.event_id, ':ts': nowIso() },
  });

/** A failed report job gets a new attempt number, so its execution name is new. */
export const retryReports = (schoolId, set) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :pending', 'report_attempt = report_attempt + :one', 'report_error = :null'],
    condition: 'report_cards_status = :failed AND report_attempt = :attempt',
    values: {
      ':pending': REPORTS.PENDING, ':failed': REPORTS.FAILED, ':attempt': set.report_attempt, ':one': 1, ':null': null,
    },
  });

export const markReportsRunning = (schoolId, set, executionArn) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :running', 'report_execution = :arn', 'report_started_at = :ts'],
    condition: 'report_cards_status = :pending AND report_attempt = :attempt',
    values: {
      ':running': REPORTS.RUNNING, ':pending': REPORTS.PENDING, ':attempt': set.report_attempt,
      ':arn': executionArn, ':ts': nowIso(),
    },
  });

/** Idempotent per student: a retried card adds the same id to the set again. */
export const markReportCardDone = (schoolId, set, studentId) =>
  updateSet(schoolId, set, {
    set: ['report_cards_updated_at = :ts'],
    add: 'report_cards_done :sid',
    condition: 'calculation_id = :calc',
    values: { ':calc': set.calculation_id, ':sid': new Set([studentId]), ':ts': nowIso() },
  });

export const markReportsFinished = (schoolId, set, { ok, error = null }) =>
  updateSet(schoolId, set, {
    set: ['report_cards_status = :to', 'report_error = :err', 'report_finished_at = :ts'],
    condition: 'calculation_id = :calc AND report_cards_status IN (:pending, :running)',
    values: {
      ':to': ok ? REPORTS.COMPLETE : REPORTS.FAILED, ':err': error, ':ts': nowIso(), ':calc': set.calculation_id,
      ':pending': REPORTS.PENDING, ':running': REPORTS.RUNNING,
    },
  });

/** Same key and same content for the same calculation, so retries are idempotent. */
export async function putReportCard(schoolId, card) {
  const item = {
    PK: pk(schoolId),
    SK: sk.reportCard(card.term_id, card.checkpoint, card.student_id),
    entity: 'ReportCard',
    report_card_id: `${card.term_id}#${card.checkpoint}#${card.student_id}`,
    school_id: schoolId,
    ...card,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function getReportCard(schoolId, termId, checkpoint, studentId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.reportCard(termId, checkpoint, studentId) }, ConsistentRead: true })
  );
  return Item || null;
}