import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk, gsi2 } from './keys.js';
import { conflict } from './errors.js';

/**
 * Risk predictions and the runs that produced them.
 *   RISKRUN#<term>#<class>#<checkpoint>          the latest run for a published class checkpoint
 *   RISK#<year>#<point>#<student>                a student's latest prediction at a point
 *     GSI2: <student> / RISK#<year>#<point>      a student's predictions through the year
 * A prediction keeps the exact inputs the model received, the model version,
 * the threshold and its SHAP values (shap_base_value + shap_values), so it can
 * be explained now and acted on (DiCE) later.
 */
const nowIso = () => new Date().toISOString();

export const RUN = { QUEUED: 'QUEUED', RUNNING: 'RUNNING', COMPLETE: 'COMPLETE', FAILED: 'FAILED', SKIPPED: 'SKIPPED' };

export async function getRun(schoolId, termId, classId, checkpoint) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.riskRun(termId, classId, checkpoint) }, ConsistentRead: true,
  }));
  return Item || null;
}

export async function putRun(schoolId, run) {
  const item = {
    PK: pk(schoolId),
    SK: sk.riskRun(run.term_id, run.class_id, run.checkpoint),
    entity: 'RiskRun',
    school_id: schoolId,
    updated_at: nowIso(),
    ...run,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function finishRun(schoolId, run, patch) {
  const names = {};
  const values = { ':ts': nowIso(), ':run': run.run_id };
  const sets = ['updated_at = :ts', 'finished_at = :ts'];
  for (const [k, v] of Object.entries(patch)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.riskRun(run.term_id, run.class_id, run.checkpoint) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'run_id = :run', // a newer run owns the record now
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return res.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw e;
  }
}

export function predictionItem(schoolId, p) {
  return {
    PK: pk(schoolId),
    SK: sk.risk(p.academic_year, p.prediction_point, p.student_id),
    GSI2PK: gsi2.pk(schoolId, p.student_id),
    GSI2SK: gsi2.risk(p.academic_year, p.prediction_point),
    entity: 'RiskPrediction',
    school_id: schoolId,
    ...p,
  };
}

export async function putPredictions(schoolId, predictions) {
  const items = predictions.map((p) => predictionItem(schoolId, p));
  for (let i = 0; i < items.length; i += 25) {
    let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8) throw new Error('DynamoDB kept throttling the prediction rows');
      if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
      pending = res.UnprocessedItems?.[TABLE] || [];
    }
  }
}

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

export async function getPrediction(schoolId, academicYear, point, studentId) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.risk(academicYear, point, studentId) }, ConsistentRead: true,
  }));
  return Item || null;
}

/**
 * A prediction holds its model inputs, SHAP values and targets, so a whole
 * school's predictions are large. Callers that need only a few fields name them
 * and DynamoDB returns just those (#f0, #f1... avoid clashes with reserved words).
 */
const only = (fields) => (fields?.length
  ? {
      ProjectionExpression: fields.map((_, i) => `#f${i}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(fields.map((f, i) => [`#f${i}`, f])),
    }
  : {});

/** The fields each slim read needs. */
export const FIELDS = {
  // What a dashboard card shows: the summary and the chosen target (predictionTargets / targetToken).
  dashboard: ['school_id', 'student_id', 'class_id', 'academic_year', 'prediction_point', 'run_id', 'predicted_at',
    'model_version', 'probability', 'at_risk', 'threshold', 'counterfactuals', 'target_choice'],
  // Counting students and flags per class and form.
  overview: ['student_id', 'class_id', 'at_risk'],
  // Observed importance (mean |SHAP| per group).
  importance: ['class_id', 'shap_values'],
  // The missing-data counts the model received.
  readiness: ['student_id', 'class_id', 'missing_scores', 'missing_attendance'],
};

/** Every prediction at one point in a school year (all classes). `fields` limits what is read. */
export const listForPoint = (schoolId, academicYear, point, fields) =>
  queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.riskPointPrefix(academicYear, point) },
    ...only(fields),
  });

/** Predictions at one point for the students who were in a class when it ran. `fields` limits what is read. */
export function listForClass(schoolId, academicYear, point, classId, fields) {
  const projection = only(fields);
  return queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    FilterExpression: '#class = :c',
    ExpressionAttributeValues: { ':p': pk(schoolId), ':s': sk.riskPointPrefix(academicYear, point), ':c': classId },
    ...projection,
    ExpressionAttributeNames: { ...projection.ExpressionAttributeNames, '#class': 'class_id' },
  });
}

export const listForStudent = async (schoolId, studentId, academicYear) =>
  (await Promise.all(['T1M', 'T1F', 'T2M', 'T2F', 'T3M'].map((point) =>
    getPrediction(schoolId, academicYear, point, studentId)))).filter(Boolean);

export async function saveTargetChoice(schoolId, prediction, optionIndex, actor, expectedVersion) {
  const choice = { option_index: optionIndex, version: expectedVersion + 1, updated_by: actor.sub, updated_at: nowIso() };
  // Run identity guards replacement while the token validates the displayed options.
  const conditions = ['attribute_exists(PK)'];
  const values = { ':choice': choice };
  for (const key of ['run_id', 'predicted_at', 'model_version']) {
    if (prediction[key] == null) conditions.push(`attribute_not_exists(${key})`);
    else { conditions.push(`${key} = :${key}`); values[`:${key}`] = prediction[key]; }
  }
  if (expectedVersion === 0) conditions.push('attribute_not_exists(target_choice)');
  else { conditions.push('target_choice.#v = :version'); values[':version'] = expectedVersion; }
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: pk(schoolId), SK: sk.risk(prediction.academic_year, prediction.prediction_point, prediction.student_id) },
      UpdateExpression: 'SET target_choice = :choice', ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeValues: values,
      ...(expectedVersion ? { ExpressionAttributeNames: { '#v': 'version' } } : {}), ReturnValues: 'ALL_NEW',
    }));
    return result.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw conflict('The prediction or selected option changed. Refresh before saving again.');
    throw e;
  }
}
