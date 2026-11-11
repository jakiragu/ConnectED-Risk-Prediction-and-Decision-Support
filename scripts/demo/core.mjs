// Raw DynamoDB AttributeValues preserve number strings, binary data and sets.
export const value = (item, key) => item?.[key]?.S;
export const key = item => JSON.stringify([value(item, 'PK'), value(item, 'SK')]);
export const protectedItem = item => value(item, 'SK') === 'SCHOOL#PROFILE';
export function canonical(v, parent = '') {
  if (Array.isArray(v)) {
    const a = v.map(x => canonical(x));
    return ['SS', 'NS', 'BS'].includes(parent) ? a.sort() : a;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k], k)]));
  return v;
}
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function validate(items, school) {
  const keys = new Set();
  for (const item of items) {
    if (value(item, 'PK') !== `SCHOOL#${school}` || !value(item, 'SK')) throw Error('Snapshot contains an invalid or out-of-school key');
    if (keys.has(key(item))) throw Error('Duplicate snapshot key');
    keys.add(key(item));
    if (['QUEUED', 'RUNNING'].includes(value(item, 'status')) && value(item, 'entity') === 'RiskRun') throw Error('Risk work is still running; wait before snapshot/reset');
    if (value(item, 'report_cards_status') === 'RUNNING' || value(item, 'report_cards_status') === 'QUEUED') throw Error('Reports are still running');
  }
  if (!items.some(i => protectedItem(i))) throw Error('School profile missing; create the demo school through Angaza first');
}
export function diff(current, desired) {
  const before = new Map(current.map(i => [key(i), i]));
  const after = new Map(desired.map(i => [key(i), i]));
  // Cognito lifecycle and the Angaza school registry are outside this reset.
  const puts = desired.filter(i => !protectedItem(i) && !equal(i, before.get(key(i))));
  const deletes = current.filter(i => !protectedItem(i) && value(i, 'entity') !== 'Teacher' && !after.has(key(i)));
  return { puts, deletes, unchanged: desired.length - puts.length };
}
export function remap(items, sourceSchool, targetSchool, mappings) {
  const subs = new Map(mappings.map(({ source, target }) => [source, target]));
  const replace = str => {
    if (str === sourceSchool) return targetSchool;
    if (subs.has(str)) return subs.get(str);
    // IDs in composite keys are complete #-separated components, never substrings.
    return str.split('#').map(x => x === sourceSchool ? targetSchool : (subs.get(x) ?? x)).join('#');
  };
  const walk = obj => {
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, k === 'S' ? replace(v) : k === 'SS' ? v.map(replace) : walk(v)]));
    return obj;
  };
  return items.map(walk);
}
