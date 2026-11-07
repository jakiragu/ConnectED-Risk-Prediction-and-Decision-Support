import { createHash } from 'node:crypto';
import { targetsOf } from './targets.js';

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export const targetToken = (p) => createHash('sha256').update(JSON.stringify(canonical([
  p.school_id ?? null, p.student_id, p.academic_year, p.prediction_point, p.run_id ?? null, p.predicted_at ?? null,
  p.model_version, p.counterfactuals,
]))).digest('hex');

export function predictionTargets(p) {
  if (!p) return null;
  const targets = targetsOf(p.counterfactuals, p.target_choice);
  return targets && { ...targets, prediction_token: targetToken(p) };
}
