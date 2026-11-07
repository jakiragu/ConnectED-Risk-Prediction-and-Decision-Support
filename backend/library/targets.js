import { SUBJECT_TO_MODEL } from './features.js';

/**
 * Counterfactual targets as people read them. Pure, shared by the risk service
 * and the screens.
 *
 * Targets are for the NEXT checkpoint. The student's current results are
 * carried forward as a hypothetical baseline, and a target says how much higher
 * a result would need to be there for the next checkpoint's model (at T3M: the
 * pass mark on the projected Term 3 Final average) to stop flagging them:
 *   FOUND     DiCE found targets that clear it, within the permitted changes
 *   FALLBACK  DiCE could not; targets come from comparable students' progress
 *             and may not clear it (the projection says)
 *   MAINTAIN  carrying the current results forward already clears it
 *   NONE      nothing can be raised (no results, or all at the maximum)
 *   ERROR     the targets could not be worked out
 * They show what the model or rule needs to see, not a promise; choosing what
 * to do stays with the teacher.
 */
export const TARGETS = { FOUND: 'FOUND', FALLBACK: 'FALLBACK', MAINTAIN: 'MAINTAIN', NONE: 'NONE', ERROR: 'ERROR' };

const MODEL_TO_SUBJECT = Object.fromEntries(Object.entries(SUBJECT_TO_MODEL).map(([s, m]) => [m, s]));
export const CHECKPOINT_LABEL = {
  T1M: 'Term 1 Mid-term', T1F: 'Term 1 End-term', T2M: 'Term 2 Mid-term', T2F: 'Term 2 End-term',
  T3M: 'Term 3 Mid-term', T3F: 'Term 3 End-term',
};

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function parseTargetColumn(column) {
  if (column.startsWith('Attendance_')) {
    const point = column.slice('Attendance_'.length);
    return { point, group: 'Attendance', kind: 'attendance', label: `Attendance from the start of the year to ${CHECKPOINT_LABEL[point] ?? point}` };
  }
  const [point, ...rest] = column.split('_');
  const model = rest.join('_');
  const group = MODEL_TO_SUBJECT[model] ?? model;
  return { point, group, kind: 'score', label: `${group}, ${CHECKPOINT_LABEL[point] ?? point} exam` };
}

export function changeView(ch) {
  const c = parseTargetColumn(ch.feature);
  return {
    column: ch.feature,
    label: c.label,
    group: c.group,
    kind: c.kind,
    from: round1(ch.from),
    to: round1(ch.to),
    gain: round1(ch.to - ch.from),
    basis: ch.basis ?? null,
    peer_window: ch.peer?.window ?? null,
    peer_count: ch.peer?.peers ?? null,
    peer_change: ch.peer?.change ?? null,
  };
}

/** "Kiswahili: at least 40 (now 20)" / "Attendance: at least 49.0% (now 42.9%)" */
export function targetText(change) {
  return change.kind === 'attendance'
    ? `Attendance: at least ${change.to.toFixed(1)}% (now ${change.from.toFixed(1)}%)`
    : `${change.group}: at least ${Math.round(change.to)} (now ${Math.round(change.from)})`;
}

/** @param {object|null} cf  the counterfactuals stored on a prediction */
export function targetsOf(cf, choice = null) {
  if (!cf) return null;
  const ev = cf.evaluation || {};
  return {
    selected_option: choice?.option_index ?? 0,
    selection_version: choice?.version ?? 0,
    selection_saved: Boolean(choice),
    status: cf.status,
    reason: cf.reason ?? null,
    method: cf.method ?? null,
    target_point: cf.target_point ?? null,
    target_label: cf.target_point ? CHECKPOINT_LABEL[cf.target_point] ?? cf.target_point : null,
    evaluation_kind: ev.kind ?? null,
    model_point: ev.model_point ?? null,
    threshold: ev.threshold ?? null,
    pass_mark: ev.pass_mark ?? null,
    missing_score_policy: ev.missing_score_policy ?? null,
    baseline_score: ev.baseline_score ?? null,
    baseline_at_risk: ev.baseline_at_risk ?? null,
    dice_reason: cf.dice?.reason ?? null,
    stats_available: cf.stats_available ?? null,
    caps: Object.entries(cf.caps || {}).map(([column, c]) => ({
      column,
      label: parseTargetColumn(column).label,
      max_increase: c.max_increase,
      max_value: c.max_value,
      source: c.source,
    })),
    options: (cf.options || []).map((o, option_index) => ({
      option_index,
      method: o.method,
      score: o.score ?? null,
      at_risk: Boolean(o.at_risk),
      changes: o.changes.map(changeView),
    })),
  };
}

/** The first option's changes (FOUND or FALLBACK), for lists. */
export const bestTarget = (cf, choice = null) =>
  (cf?.status === TARGETS.FOUND || cf?.status === TARGETS.FALLBACK) && cf.options?.length ? cf.options[choice?.option_index ?? 0]?.changes.map(changeView) ?? [] : [];

/** Stable option ids survive subject-level filtering. */
export const selectedChanges = (targets) =>
  targets?.options?.find((o, i) => (o.option_index ?? i) === (targets.selected_option ?? 0))?.changes ?? [];
