import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './client.js';
import { TABLE, GOOGLE_PK, PLATFORM_PK, platformSk, pk, sk } from './keys.js';
import { ulid } from './ids.js';
import { sameSchoolKey } from './locations.js';

/**
 * Records behind the Angaza console. A school appears twice, on purpose:
 *
 *   PLATFORM / SCHOOL#<id>      the registration the console lists (no scan needed)
 *   SCHOOL#<id> / SCHOOL#PROFILE  the school's own profile, which every school request reads
 *
 * Both are always written in one transaction, so they cannot drift apart. The
 * profile carries the status that actually blocks a suspended school's users
 * (actor.js), because that check must stay inside the school's own partition.
 */

export const DUPLICATE = 'DuplicateSchool';
export const STALE = 'Stale';
const fail = (name) => Object.assign(new Error(name), { name });
const failedAt = (e, index) =>
  e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

const nowIso = () => new Date().toISOString();

const get = async (PK, SK) =>
  (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK }, ConsistentRead: true }))).Item || null;

async function queryAll(params) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function countAll(params) {
  let total = 0;
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE, Select: 'COUNT', ...params, ExclusiveStartKey }));
    total += res.Count || 0;
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}

const auditItem = (schoolId, action, actor, details = {}) => ({
  PK: PLATFORM_PK,
  SK: platformSk.audit(schoolId, ulid()),
  entity: 'PlatformAudit',
  school_id: schoolId,
  action,
  by_sub: actor.sub,
  by_name: actor.name,
  at: nowIso(),
  details,
});

// --------------------------------------------------------------------- staff

export const staff = (sub) => get(PLATFORM_PK, platformSk.staff(sub));

export const putStaff = (item) =>
  ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: PLATFORM_PK, SK: platformSk.staff(item.staff_id), entity: 'PlatformStaff', status: 'ACTIVE', created_at: nowIso(), ...item },
  }));

// ------------------------------------------------------------------- schools

export const registration = (schoolId) => get(PLATFORM_PK, platformSk.school(schoolId));

export const listRegistrations = () =>
  queryAll({
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': PLATFORM_PK, ':s': platformSk.schoolPrefix() },
  });

/** The registration and name claim for a school, as items. Used by createSchool and by seeding. */
export function registrationItems(schoolId, place, { by = null, byName = null, at = nowIso(), status = 'ACTIVE' } = {}) {
  return {
    registration: {
      PK: PLATFORM_PK,
      SK: platformSk.school(schoolId),
      entity: 'SchoolRegistration',
      school_id: schoolId,
      ...place,
      status,
      created_at: at,
      created_by: by,
      created_by_name: byName,
      updated_at: at,
      _version: 1,
    },
    claim: { PK: PLATFORM_PK, SK: platformSk.schoolName(sameSchoolKey(place)), entity: 'SchoolNameClaim', school_id: schoolId },
  };
}

/**
 * Registers a new school: its registration, its name claim (the same name in the
 * same county twice is refused), its own profile, and an audit row, together.
 */
export async function createSchool(schoolId, place, actor) {
  const at = nowIso();
  const { registration: reg, claim } = registrationItems(schoolId, place, { by: actor.sub, byName: actor.name, at });
  const profile = {
    PK: pk(schoolId),
    SK: sk.school(),
    entity: 'School',
    school_id: schoolId,
    ...place,
    status: 'ACTIVE',
    created_at: at,
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: reg, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: claim, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: profile, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: TABLE, Item: auditItem(schoolId, 'SCHOOL_CREATED', actor, { place }) } },
      ],
    }));
  } catch (e) {
    if (failedAt(e, 1)) throw fail(DUPLICATE);
    throw e;
  }
  return reg;
}

/** The school's own profile, updated from the registration so the two never disagree. */
const profileUpdate = (schoolId, fields) => {
  const names = { '#e': 'entity', '#sid': 'school_id' };
  const values = { ':e': 'School', ':sid': schoolId };
  const sets = ['#e = if_not_exists(#e, :e)', '#sid = :sid'];
  const removes = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    if (value === null) removes.push(`#${key}`);
    else {
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
  }
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: pk(schoolId), SK: sk.school() },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
};

/** A versioned update of the registration; null fields are removed. `only`: the status it must still have. */
const registrationUpdate = (schoolId, fields, expectedVersion, only = null) => {
  const names = { '#v': '_version' };
  const values = { ':exp': expectedVersion, ':one': 1, ':ts': nowIso() };
  const sets = ['updated_at = :ts', '#v = #v + :one'];
  const removes = [];
  for (const [key, value] of Object.entries(fields)) {
    names[`#${key}`] = key;
    if (value === null) removes.push(`#${key}`);
    else {
      values[`:${key}`] = value;
      sets.push(`#${key} = :${key}`);
    }
  }
  if (only) {
    names['#status'] = 'status';
    values[':only'] = only;
  }
  return {
    Update: {
      TableName: TABLE,
      Key: { PK: PLATFORM_PK, SK: platformSk.school(schoolId) },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ConditionExpression: `attribute_exists(PK) AND #v = :exp${only ? ' AND #status = :only' : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
};

/** Changes a school's name or place. Moves the name claim when the name or place changes. */
export async function updateSchool(current, place, expectedVersion, actor) {
  const schoolId = current.school_id;
  const oldKey = sameSchoolKey(current);
  const newKey = sameSchoolKey(place);
  const items = [
    registrationUpdate(schoolId, place, expectedVersion),
    profileUpdate(schoolId, place),
    { Put: { TableName: TABLE, Item: auditItem(schoolId, 'SCHOOL_UPDATED', actor, { before: pick(current), after: place }) } },
  ];
  if (oldKey !== newKey) {
    items.push(
      { Put: { TableName: TABLE, Item: { PK: PLATFORM_PK, SK: platformSk.schoolName(newKey), entity: 'SchoolNameClaim', school_id: schoolId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Delete: { TableName: TABLE, Key: { PK: PLATFORM_PK, SK: platformSk.schoolName(oldKey) } } },
    );
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (failedAt(e, 0)) throw fail(STALE);
    if (failedAt(e, 3)) throw fail(DUPLICATE);
    throw e;
  }
  return registration(schoolId);
}

const pick = (r) => ({ name: r.name, country: r.country, region: r.region, town: r.town ?? null });

/**
 * Suspends or reactivates a school. The profile's status is what blocks the
 * school's users; the registration keeps who did it and why, for the console.
 */
export async function setStatus(current, status, reason, expectedVersion, actor) {
  const schoolId = current.school_id;
  const suspending = status === 'SUSPENDED';
  const at = nowIso();
  const fields = suspending
    ? { status, suspended_reason: reason, suspended_at: at, suspended_by: actor.sub, suspended_by_name: actor.name, reactivated_at: null, reactivated_by_name: null }
    : { status, suspended_reason: null, suspended_at: null, suspended_by: null, suspended_by_name: null, reactivated_at: at, reactivated_by_name: actor.name };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        registrationUpdate(schoolId, fields, expectedVersion),
        profileUpdate(schoolId, { status }),
        { Put: { TableName: TABLE, Item: auditItem(schoolId, suspending ? 'SCHOOL_SUSPENDED' : 'SCHOOL_REACTIVATED', actor, suspending ? { reason } : {}) } },
      ],
    }));
  } catch (e) {
    if (failedAt(e, 0)) throw fail(STALE);
    throw e;
  }
  return registration(schoolId);
}

/** One audit row, for changes outside a transaction (sign-in accounts live in Cognito). */
export const audit = (schoolId, action, actor, details) =>
  ddb.send(new PutCommand({ TableName: TABLE, Item: auditItem(schoolId, action, actor, details) }));

// ------------------------------------------------- inside a school (totals only)

const inSchool = (schoolId, prefix, filter = {}) => ({
  KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
  ...filter,
  ExpressionAttributeValues: { ':p': pk(schoolId), ':s': prefix, ...(filter.ExpressionAttributeValues || {}) },
});

/** The school's administrator records. Names and emails only: the console shows who to contact. */
export const admins = (schoolId) =>
  queryAll(inSchool(schoolId, sk.teacherPrefix(), {
    FilterExpression: '#r = :admin',
    ExpressionAttributeNames: { '#r': 'role', '#st': 'status' },
    ExpressionAttributeValues: { ':admin': 'Admin' },
    ProjectionExpression: 'teacher_id, first_name, last_name, email, #st, #r, school_id, created_at',
  }));

export const activeAdminCount = (schoolId) =>
  countAll(inSchool(schoolId, sk.teacherPrefix(), {
    FilterExpression: '#r = :admin AND (attribute_not_exists(#st) OR #st = :active)',
    ExpressionAttributeNames: { '#r': 'role', '#st': 'status' },
    ExpressionAttributeValues: { ':admin': 'Admin', ':active': 'ACTIVE' },
  }));

/**
 * How far a school has got, as totals. Angaza sees counts, never records: no
 * student names, marks or risk estimates leave the school through the console.
 */
export async function usage(schoolId) {
  const active = { ExpressionAttributeNames: { '#st': 'status' } };
  const [classes, teachers, students] = await Promise.all([
    countAll(inSchool(schoolId, sk.classPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :current',
      ExpressionAttributeValues: { ':current': 'CURRENT' },
    })),
    countAll(inSchool(schoolId, sk.teacherPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :active',
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
    })),
    countAll(inSchool(schoolId, sk.studentPrefix(), {
      ...active,
      FilterExpression: 'attribute_not_exists(#st) OR #st = :active',
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
    })),
  ]);
  return { classes, teachers, students };
}


// ------------------------------------------------------------ deleting a school
//
// Used by schoolDeletion.js, which holds the rules and the order. A school being deleted has
// status DELETING on both its registration and its profile; when everything is gone the
// registration is replaced by a one-line entry with status DELETED and nothing of the school's.

/** Marks a school as being deleted, if it still has the status the caller saw. From this moment nobody at the school is served. */
export async function beginDeletion(current, expectedVersion, actor) {
  const schoolId = current.school_id;
  const fields = { status: 'DELETING', deletion_started_at: nowIso(), deletion_started_by: actor.sub, deletion_started_by_name: actor.name, deleted_records: 0 };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        registrationUpdate(schoolId, fields, expectedVersion, current.status || 'ACTIVE'),
        profileUpdate(schoolId, { status: 'DELETING' }),
        { Put: { TableName: TABLE, Item: auditItem(schoolId, 'SCHOOL_DELETION_STARTED', actor, { name: current.name }) } },
      ],
    }));
  } catch (e) {
    if (failedAt(e, 0)) throw fail(STALE);
    throw e;
  }
  return registration(schoolId);
}

/** Up to `limit` of the school's people who still have a record (teachers and administrators, deleted ones included). */
export async function staffPage(schoolId, limit) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    ...inSchool(schoolId, sk.teacherPrefix()),
    ConsistentRead: true,
    Limit: limit,
  }));
  return res.Items || [];
}

/** Up to `limit` keys of what the school still holds, leaving its profile (removed last, with the registration). */
export async function recordKeysPage(schoolId, limit) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :p',
    ExpressionAttributeValues: { ':p': pk(schoolId) },
    ProjectionExpression: 'PK, SK',
    ConsistentRead: true,
    Limit: limit,
  }));
  return (res.Items || []).filter((k) => k.SK !== sk.school());
}

/** The Google-account claims held by people of this school, in this sign-in pool. */
export const googleClaimKeys = async (pool, schoolId) =>
  (await queryAll({
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    FilterExpression: 'school_id = :id',
    ExpressionAttributeValues: { ':p': GOOGLE_PK, ':s': `${pool}#`, ':id': schoolId },
    ProjectionExpression: 'PK, SK',
  }));

/**
 * Deletes records by key, 25 a request, retrying what DynamoDB hands back unprocessed (it does
 * that when the table is throttled). Returns how many were deleted; fewer than asked means the
 * table is busy and the caller should stop for now.
 */
export async function deleteKeys(keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 25) {
    let batch = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key: { PK: Key.PK, SK: Key.SK } } }));
    for (let attempt = 0; batch.length && attempt < 4; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } }));
      const left = res.UnprocessedItems?.[TABLE] || [];
      deleted += batch.length - left.length;
      batch = left;
    }
    if (batch.length) break;
  }
  return deleted;
}

/** Adds to the running total the console shows while a school is being deleted. */
export const addDeletionProgress = (schoolId, count) =>
  ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: PLATFORM_PK, SK: platformSk.school(schoolId) },
    UpdateExpression: 'ADD deleted_records :n',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':n': count },
  }));

/**
 * Angaza's own audit rows about the school stay (who registered, suspended and deleted it),
 * but an administrator's email address quoted in them does not.
 */
export async function scrubAudit(schoolId) {
  const rows = await queryAll({
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
    ExpressionAttributeValues: { ':p': PLATFORM_PK, ':s': `AUDIT#${schoolId}#` },
  });
  for (const row of rows) {
    if (!row.details || !('email' in row.details)) continue;
    const { email: _email, ...details } = row.details;
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET #d = :d',
      ExpressionAttributeNames: { '#d': 'details' },
      ExpressionAttributeValues: { ':d': details },
    }));
  }
}

/**
 * The last step, in one transaction: the registration becomes a one-line entry (name, place,
 * who deleted it and when), the name is released for a new school, and the profile goes.
 */
export async function finishDeletion(reg) {
  const at = nowIso();
  const entry = {
    PK: PLATFORM_PK,
    SK: platformSk.school(reg.school_id),
    entity: 'SchoolRegistration',
    school_id: reg.school_id,
    name: reg.name,
    country: reg.country,
    region: reg.region,
    town: reg.town ?? null,
    time_zone: reg.time_zone ?? null,
    status: 'DELETED',
    created_at: reg.created_at ?? null,
    created_by_name: reg.created_by_name ?? null,
    deleted_at: at,
    deleted_by: reg.deletion_started_by ?? null,
    deleted_by_name: reg.deletion_started_by_name ?? null,
    deleted_records: reg.deleted_records ?? 0,
    updated_at: at,
    _version: (reg._version ?? 1) + 1,
  };
  const by = { sub: reg.deletion_started_by ?? null, name: reg.deletion_started_by_name ?? null };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: entry, ConditionExpression: '#st = :deleting', ExpressionAttributeNames: { '#st': 'status' }, ExpressionAttributeValues: { ':deleting': 'DELETING' } } },
        { Delete: { TableName: TABLE, Key: { PK: PLATFORM_PK, SK: platformSk.schoolName(sameSchoolKey(reg)) }, ConditionExpression: 'attribute_not_exists(PK) OR school_id = :id', ExpressionAttributeValues: { ':id': reg.school_id } } },
        { Delete: { TableName: TABLE, Key: { PK: pk(reg.school_id), SK: sk.school() } } },
        { Put: { TableName: TABLE, Item: auditItem(reg.school_id, 'SCHOOL_DELETED', by, { name: reg.name, records: entry.deleted_records }) } },
      ],
    }));
  } catch (e) {
    // Someone else's request finished it a moment ago: that is the outcome wanted.
    if (!failedAt(e, 0)) throw e;
  }
  return registration(reg.school_id);
}
