import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { parseColumn } from '@gradebook/domain/explanations';
import { gql } from '../api/graphql.js';
import { GET_FEATURE_READINESS, GET_STUDENT_FEATURES, LIST_TERMS_FULL } from '../api/calendarOperations.js';
import {
  GET_RISK_EXPLANATION, GET_RISK_IMPORTANCE, GET_RISK_MODEL, GET_RISK_RUN, LIST_RISK_PREDICTIONS, RUN_RISK_PREDICTIONS,
} from '../api/riskOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import RiskExplanation from '../components/RiskExplanation.jsx';
import { EmptyState, Info, Notice, Offline, RiskBar, useToast, ActionIcon } from '../components/ui.jsx';
import { ChartCard } from '../components/charts.jsx';
import { ShareBars, Skeleton, StatTile } from '../components/insights.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { byClassOrder, classLabel } from '../classLabels.js';

const POINTS = [
  { value: 'T1M', label: 'Term 1 Mid-term', term_number: 1, checkpoint: 'MIDTERM' },
  { value: 'T1F', label: 'Term 1 End-term', term_number: 1, checkpoint: 'ENDTERM' },
  { value: 'T2M', label: 'Term 2 Mid-term', term_number: 2, checkpoint: 'MIDTERM' },
  { value: 'T2F', label: 'Term 2 End-term', term_number: 2, checkpoint: 'ENDTERM' },
  { value: 'T3M', label: 'Term 3 Mid-term', term_number: 3, checkpoint: 'MIDTERM' },
];
const SHORT = { T1M: 'T1 Mid', T1F: 'T1 End', T2M: 'T2 Mid', T2F: 'T2 End', T3M: 'T3 Mid' };
const ALL = 'all';

/** "Kiswahili 42 → 55", "Attendance 85.7% → 91%" */
const targetLine = (c) => (c.kind === 'attendance'
  ? `Attendance ${c.from.toFixed(1)}% → ${c.to.toFixed(1)}%`
  : `${c.group} ${Math.round(c.from)} → ${Math.round(c.to)}`);

/** The class's latest prediction run, as a status pill. */
function runText(run) {
  if (!run) return { text: 'Predictions not made yet', tone: 'neutral' };
  if (run.status === 'COMPLETE') {
    const on = new Date(run.finished_at || run.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return { text: `Predictions made ${on}`, tone: 'good' };
  }
  if (run.status === 'FAILED') return { text: 'Last run failed', tone: 'risk' };
  return { text: 'Predictions running…', tone: 'neutral' };
}

/** The model's inputs at a point, as a table: subjects and attendance down, checkpoints across. */
function DataUsed({ features }) {
  const cells = new Map();
  const groups = [];
  const points = [];
  for (const v of features.values) {
    const c = parseColumn(v.name);
    if (!groups.includes(c.group)) groups.push(c.group);
    if (!points.includes(c.point)) points.push(c.point);
    cells.set(`${c.group}|${c.point}`, v.value);
  }
  return (
    <div className="table-wrap">
      <table className="data-grid">
        <thead><tr><th>Result</th>{points.map((p) => <th key={p} className="num">{SHORT[p] ?? p}</th>)}</tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g}>
              <td>{g}</td>
              {points.map((p) => {
                const v = cells.get(`${g}|${p}`);
                return <td key={p} className={`num${v == null ? ' missing' : ''}`}>{v == null ? '—' : g === 'Attendance' ? `${v.toFixed(1)}%` : Math.round(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Risk prediction: the model's estimate for each student at a checkpoint, what
 * moved it, and the target for the next checkpoint. Estimates are made when a
 * checkpoint's results are published; administrators can run them again. They
 * are decision-support signals for the teacher, not judgements about students.
 * Administrators see every class (and all classes together); a class teacher
 * sees their own class.
 */
export default function RiskPrediction() {
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const mine = useMemo(
    () => classes.filter((c) => isAdmin || c.is_class_teacher).sort(byClassOrder),
    [classes, isAdmin]
  );
  const canAll = isAdmin && mine.length > 1;
  const classParam = params.get('class') || (canAll ? ALL : mine[0]?.class_id) || '';
  const all = classParam === ALL;
  const point = POINTS.find((p) => p.value === params.get('point')) || POINTS[0];
  const go = (next) => setParams(Object.fromEntries(Object.entries({ class: classParam, point: point.value, ...next }).filter(([, v]) => v)));
  const shown = useMemo(() => (all ? mine : mine.filter((c) => c.class_id === classParam)), [all, mine, classParam]);
  const detailSectionRef = useRef(null);
  const loadRequest = useRef(0);

  const [rows, setRows] = useState(null);
  const [year, setYear] = useState(null);
  const [run, setRun] = useState(null);
  const [terms, setTerms] = useState([]);
  const [model, setModel] = useState(null);
  const [importance, setImportance] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [toast, showToast] = useToast();

  useEffect(() => { repository.loadClasses(actor.schoolId).catch(() => {}); }, [actor.schoolId]);
  useEffect(() => {
    if (online) gql(LIST_TERMS_FULL, { school_id: actor.schoolId }).then((d) => setTerms(d.listTerms)).catch(() => {});
  }, [online, actor.schoolId]);
  useEffect(() => {
    if (online && isAdmin) gql(GET_RISK_MODEL, { school_id: actor.schoolId }).then((d) => setModel(d.getRiskModel)).catch(() => {});
  }, [online, isAdmin, actor.schoolId]);

  const term = useMemo(
    () => terms.find((t) => Number(t.academic_year) === Number(year) && Number(t.term_number) === point.term_number) || null,
    [terms, year, point]
  );

  // Every class shown: who is in it, what the model had, and what it estimated.
  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    if (!shown.length) return;
    const per = await Promise.all(shown.map(async (c) => {
      const scope = { school_id: actor.schoolId, class_id: c.class_id, prediction_point: point.value };
      const [{ getFeatureReadiness: r }, { listRiskPredictions: p }] = await Promise.all([
        gql(GET_FEATURE_READINESS, scope), gql(LIST_RISK_PREDICTIONS, scope),
      ]);
      const byStudent = new Map(p.map((x) => [x.student_id, x]));
      return { year: r.academic_year, rows: r.students.map((s) => ({ ...s, class_name: c.name, class_id: c.class_id, p: byStudent.get(s.student_id) })) };
    }));
    if (requestId !== loadRequest.current) return;
    setYear(per[0]?.year ?? null);
    setRows(per.flatMap((x) => x.rows).sort((a, b) => (b.p?.probability ?? -1) - (a.p?.probability ?? -1)));
  }, [actor.schoolId, shown, point]);

  // The importance chart is fetched alongside the table, not after it, and never holds the table up.
  const importanceRequest = useRef(0);
  const loadImportance = useCallback(async () => {
    const requestId = ++importanceRequest.current;
    if (!shown.length) return;
    const { getRiskImportance } = await gql(GET_RISK_IMPORTANCE, {
      school_id: actor.schoolId, prediction_point: point.value, ...(all ? {} : { class_id: classParam }),
    }).catch(() => ({ getRiskImportance: null }));
    if (requestId === importanceRequest.current) setImportance(getRiskImportance);
  }, [actor.schoolId, shown.length, point, all, classParam]);

  const loadRun = useCallback(async () => {
    if (all || !classParam || !term) { setRun(null); return null; }
    const { getRiskRun } = await gql(GET_RISK_RUN, { school_id: actor.schoolId, class_id: classParam, term_id: term.term_id, checkpoint: point.checkpoint });
    setRun(getRiskRun);
    return getRiskRun;
  }, [actor.schoolId, all, classParam, term, point]);

  useEffect(() => {
    setRows(null); setDetail(null); setError(null);
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);
  useEffect(() => {
    setImportance(null);
    if (online) loadImportance();
  }, [loadImportance, online]);
  useEffect(() => { if (online) loadRun().catch(() => {}); }, [loadRun, online]);

  // While a run is queued or running, check every two seconds, then reload.
  useEffect(() => {
    if (!run || !['QUEUED', 'RUNNING'].includes(run.status)) return undefined;
    const t = setTimeout(async () => {
      const r = await loadRun().catch(() => null);
      if (r && !['QUEUED', 'RUNNING'].includes(r.status)) { load().catch(() => {}); loadImportance(); showToast('Predictions updated'); }
    }, 2000);
    return () => clearTimeout(t);
  }, [run, loadRun, load, loadImportance, showToast]);

  useEffect(() => {
    if (!detail) return;

    detailSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, [detail?.row?.student_id, detail?.explanation]);

  async function rerun() {
    setError(null);
    try {
      const { runRiskPredictions } = await gql(RUN_RISK_PREDICTIONS, {
        input: { school_id: actor.schoolId, class_id: classParam, term_id: term.term_id, checkpoint: point.checkpoint },
      });
      setRun(runRiskPredictions);
    } catch (e) { setError(e.message); }
  }

  async function openDetail(row) {
    setDetail({ row, explanation: null, features: null });
    try {
      const vars = { school_id: actor.schoolId, student_id: row.student_id, prediction_point: point.value, academic_year: year };
      const [{ getRiskExplanation }, { getStudentFeatures }] = await Promise.all([gql(GET_RISK_EXPLANATION, vars), gql(GET_STUDENT_FEATURES, vars)]);
      setDetail({ row, explanation: getRiskExplanation, features: getStudentFeatures });
    } catch (e) { setError(e.message); }
  }

  if (!online) return <Offline what="Risk prediction" />;
  if (!mine.length) return <EmptyState title="No class to show">Risk prediction is available to class teachers and administrators.</EmptyState>;

  const predicted = (rows || []).filter((r) => r.p);
  const flagged = predicted.filter((r) => r.p.at_risk).length;
  const missing = (rows || []).filter((r) => r.missing_scores + r.missing_attendance > 0).length;
  const status = runText(run);
  const busy = run && ['QUEUED', 'RUNNING'].includes(run.status);

  return (
    <>
      <div className="page-head">
        <h1>Risk prediction</h1>
        <Info label="How estimates are made">
          After a Mid-term or End-term is published, the model estimates each student&apos;s risk of finishing the year below the
          pass mark, from their exam results and attendance so far. A student is flagged when the estimate reaches the model&apos;s
          threshold. It is a signal to look into, not a judgement about the student.
        </Info>
      </div>

      <div className="toolbar">
        <Select aria-label="Class" value={all ? '' : classParam} onChange={(v) => go({ class: v || ALL })}
          allLabel={canAll ? 'All classes' : undefined} options={mine.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))} />
        <Select aria-label="Checkpoint" value={point.value} onChange={(v) => go({ point: v })}
          options={POINTS.map((p) => ({ value: p.value, label: p.label }))} />
        <span className="grow" />
        {!all && rows && <span className={`pill ${status.tone}`}>{status.text}</span>}
        {isAdmin && !all && term && (
          <button type="button" className="btn secondary" disabled={busy} onClick={rerun}>{busy ? 'Running…' : 'Run predictions again'}</button>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {run?.status === 'FAILED' && <Notice tone="warn">The last prediction run failed: {run.error}</Notice>}

      {!rows && !error && <Skeleton tiles={3} lines={8} label="Loading predictions" />}

      {rows && (
        <div className="stats">
          <StatTile value={rows.length} label="students" />
          <StatTile value={flagged} of={predicted.length} label={`flagged at ${SHORT[point.value]}`} tone="risk" />
          <StatTile value={missing} label="with missing results" />
        </div>
      )}

      {rows && predicted.length === 0 && (
        <EmptyState title="No estimates yet">
          They are made automatically when {point.label} results{all ? '' : ` for ${shown[0]?.name}`} are published.
        </EmptyState>
      )}

      {rows && predicted.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Student</th>{all && <th>Class</th>}<th>Estimated risk</th><th>Main influences</th><th>Next target</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.p;
                const first = p?.best_target?.[0];
                return (
                  <tr key={r.student_id} className={detail?.row.student_id === r.student_id ? 'selected' : ''}>
                    <td>
                      {r.first_name} {r.last_name} <span className="hint">{r.admission_no}</span>
                      {r.missing_scores + r.missing_attendance > 0 && (
                        <div><span className="chip muted" title="Missing results are estimated from the student’s own earlier or other results">{r.missing_scores + r.missing_attendance} missing</span></div>
                      )}
                    </td>
                    {all && <td>{r.class_name}</td>}
                    <td><RiskBar probability={p?.probability} threshold={p?.threshold} atRisk={p?.at_risk} /></td>
                    <td>
                      {p?.explained ? (
                        <span className="chips">
                          {p.top_factors.slice(0, 2).map((f) => (
                            <span key={f.group} className={`chip ${f.direction === 'RAISES' ? 'raises' : 'lowers'}`}>
                              {f.group} {f.direction === 'RAISES' ? '↑' : '↓'}
                            </span>
                          ))}
                        </span>
                      ) : <span className="hint">—</span>}
                    </td>
                    <td>
                      {!p?.at_risk ? <span className="hint">—</span>
                        : first ? <span className="chip target">{targetLine(first)}{p.best_target.length > 1 ? ` +${p.best_target.length - 1}` : ''}</span>
                        : p.targets_status === 'MAINTAIN' ? <span className="hint">Keep current results</span>
                        : <span className="hint">None</span>}
                    </td>
                    <td className="actions">
                      {p && (
                        <button type="button" className="btn link has-tip" data-tip="Explain" aria-label={`Explain the estimate for ${r.first_name} ${r.last_name}`}
                          onClick={() => openDetail(r)}
                        >
                          <ActionIcon name="eye" />
                        </button>
                      )}

                      <Link to={`/students/${r.student_id}/risk`} state={{ from: `${location.pathname}${location.search}` }}
                        className="btn link has-tip" data-tip="Risk profile" aria-label={`Open the risk profile of ${r.first_name} ${r.last_name}`}
                      >
                        <ActionIcon name="users" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div ref={detailSectionRef} id="risk-details">
          {detail.explanation ? (
            <>
              <RiskExplanation explanation={detail.explanation} name={`${detail.row.first_name} ${detail.row.last_name}`} onClose={() => setDetail(null)} />
              {detail.features && (
                <details className="more card">
                  <summary>Data the model used</summary>
                  <DataUsed features={detail.features} />
                </details>
              )}
            </>
          ) : <div className="hint">Loading…</div>}
        </div>
      )}

      {importance && (importance.observed?.groups?.length > 0 || importance.model?.groups?.length > 0) && (
        <section className="insight-section" aria-labelledby="drivers-title">
          <div className="row">
            <h2 id="drivers-title" className="grow">What drives the estimates at {SHORT[point.value]}</h2>
            <Info label="About these charts">
              The average size of each factor&apos;s influence (mean absolute SHAP), in either direction. It shows what the model
              pays attention to, not what causes risk.
            </Info>
          </div>
          <div className="graph-grid">
            <ChartCard title={all ? 'Across the school' : `In ${shown[0]?.name}`}
              subtitle={`Share of what moved the estimates${importance.observed?.students ? ` of ${importance.observed.students} students` : ''}`}>
              <ShareBars items={importance.observed?.groups} label="Influence in this group" />
            </ChartCard>
            {importance.model?.groups?.length > 0 && (
              <ChartCard title="In the model’s evaluation" subtitle="The same measure on the students the model was tested on">
                <ShareBars items={importance.model.groups} label="Influence in the model's evaluation" />
              </ChartCard>
            )}
          </div>
        </section>
      )}

      {isAdmin && model && (
        <div className="hint">
          {model.available ? `Model in use: ${model.model_version}.` : `No model is available: ${model.message}`}
        </div>
      )}
      {toast}
    </>
  );
}
