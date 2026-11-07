import { CHECKPOINT_ORDER } from '@gradebook/domain/decision';
import { parseTargetColumn } from '@gradebook/domain/targets';

export const CHART_TERMS = [
  { value: 1, label: 'Term 1', mid: 'T1M', end: 'T1F' },
  { value: 2, label: 'Term 2', mid: 'T2M', end: 'T2F' },
  { value: 3, label: 'Term 3', mid: 'T3M', end: 'T3F' },
];

/** Old offline caches contain summaries, not historical SHAP/target snapshots. */
export function profileAssessments(profile) {
  const sort = (entries) => entries.slice().sort((a, b) =>
    CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) - CHECKPOINT_ORDER.indexOf(b.prediction.prediction_point));
  if (Array.isArray(profile.assessment_history)) return sort(profile.assessment_history);
  const summaries = new Map((profile.risk_trend || []).map((p) => [p.prediction_point, p]));
  for (const p of [profile.previous, profile.latest]) if (p) summaries.set(p.prediction_point, p);
  return sort([...summaries.values()].map((prediction) => {
    const latest = prediction.prediction_point === profile.latest?.prediction_point;
    const results = (profile.performance_trend || []).find((r) => r.point === prediction.prediction_point)
      ?? (profile.results?.point === prediction.prediction_point ? profile.results : null);
    return {
      prediction, results,
      explained: latest && Boolean(profile.explained),
      factors: latest ? profile.factors || [] : [],
      targets: latest ? profile.targets : null,
      historyIncomplete: !latest,
      interventions: (profile.interventions || []).filter((i) =>
        i.linked?.prediction_point === prediction.prediction_point &&
        Number(i.linked?.academic_year) === Number(profile.academic_year)),
    };
  }));
}

export function subjectTargets(option, subjects) {
  const targets = new Map();
  for (const change of option?.changes || []) {
    if (!change.column || change.kind === 'attendance' || change.to == null) continue;
    const { point, group, kind } = parseTargetColumn(change.column);
    const value = Number(change.to);
    if (kind === 'score' && subjects.includes(group) && Number.isFinite(value)) targets.set(`${point}:${group}`, value);
  }
  return targets;
}

/** Next-term targets must be visible before that term has any published marks. */
export function chartTerms(performanceTrend, targets) {
  return CHART_TERMS.filter(({ mid, end }) =>
    performanceTrend.some((r) => r.point === mid || r.point === end) ||
    [...targets.keys()].some((key) => key.startsWith(`${mid}:`) || key.startsWith(`${end}:`)));
}
