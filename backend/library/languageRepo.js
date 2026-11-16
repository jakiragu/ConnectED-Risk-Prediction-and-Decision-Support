import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, pk, sk } from './keys.js';
import { DEFAULT_LANGUAGES } from './language.js';

/**
 * The school's language for report cards and for results SMS. One small item
 * per school, kept apart from the School record that Angaza maintains. A
 * school that never saved gets English for both (_version 0).
 */
export async function get(schoolId) {
  const res = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: pk(schoolId), SK: sk.languageSettings() },
    ConsistentRead: true,
  }));
  return res.Item || { school_id: schoolId, ...DEFAULT_LANGUAGES, _version: 0, is_default: true };
}

/** expectedVersion is the _version the administrator was editing; stale => ConditionalCheckFailed. */
export async function save(schoolId, settings, expectedVersion, actor) {
  const item = {
    PK: pk(schoolId),
    SK: sk.languageSettings(),
    entity: 'LanguageSettings',
    school_id: schoolId,
    report_card_language: settings.report_card_language,
    sms_language: settings.sms_language,
    _version: expectedVersion + 1,
    updated_at: new Date().toISOString(),
    updated_by: actor.sub,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: expectedVersion === 0 ? 'attribute_not_exists(PK)' : '#v = :exp',
    ...(expectedVersion === 0
      ? {}
      : { ExpressionAttributeNames: { '#v': '_version' }, ExpressionAttributeValues: { ':exp': expectedVersion } }),
  }));
  return item;
}
