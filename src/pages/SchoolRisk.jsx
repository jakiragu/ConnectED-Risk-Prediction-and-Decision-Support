import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { GET_RISK_IMPORTANCE } from '../api/riskOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import LineChart from '../components/LineChart.jsx';
import { EmptyState, Info, Notice } from '../components/ui.jsx';
import { ChartCard } from '../components/charts.jsx';
import { Meter, ShareBars, Skeleton, StatTile } from '../components/insights.jsx';
import { here } from '../navigation.js';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';

const POINTS = ['T1M', 'T1F', 'T2M', 'T2F', 'T3M'];
const SHORT = { T1M: 'T1 Mid', T1F: 'T1 End', T2M: 'T2 Mid', T2F: 'T2 End', T3M: 'T3 Mid' };
const LONG = { T1M: 'Term 1 Mid-term', T1F: 'Term 1 End-term', T2M: 'Term 2 Mid-term', T2F: 'Term 2 End-term', T3M: 'Term 3 Mid-term' };
const pct = (r) => (r == null ? '—' : `${Math.round(r * 1000) / 10}%`);
const students = (n) => `${n} student${n === 1 ? '' : 's'}`;

/** The latest checkpoint with predictions, and the one before it. */
function lastTwo(series) {
  const done = series.filter((s) => s.students);
  return { now: done[done.length - 1] ?? null, before: done[done.length - 2] ?? null };
}

/** "3 more than at Term 1 End-term" / "2 fewer than …" / "the same number as …" */
function change(now, before) {
  if (!now || !before) return null;
  const d = now.at_risk - before.at_risk;
  if (d === 0) return { text: `the same number as at ${LONG[before.point]}`, d };
  return { text: `${Math.abs(d)} ${d > 0 ? 'more' : 'fewer'} than at ${LONG[before.point]}`, d };
}

/** A class's change in flagged students, in the class page's change style (a rise is worse). */
function Trend({ d }) {
  if (d == null) return <span className="hint">—</span>;
  if (d === 0) return <span className="change flat">no change</span>;
  return <span className={`change ${d > 0 ? 'down' : 'up'}`} aria-label={`${d > 0 ? 'up' : 'down'} ${Math.abs(d)}`}>{d > 0 ? `▲ ${d}` : `▼ ${-d}`}</span>;
}

/**
 * School risk for administrators (US-06). It answers three questions:
 *   How many students are flagged, and is that rising?   headline and trend
 *   Where should support go first?                       classes ranked by their flagged share
 *   What does the model weigh most here?                 average influence (global SHAP)
 * A student is counted in the class their prediction was made in. Flags are
 * signals for planning support, not judgements about students.
 */
export default function SchoolRisk() {
  const { actor } = useAuth();
  const { online } = useSync();
  const location = useLocation();
  const [view, setView] = useState({ data: null });
  const [point, setPoint] = useState(null);
  const [importance, setImportance] = useState(null);
  const [forms, setForms] = useState(new Set());

  useEffect(() => {
    repository.loadSchoolOverview(actor.schoolId).then((v) => {
      setView(v);
      setPoint((p) => p ?? lastTwo(v.data?.points || []).now?.point ?? 'T1M');
    });
  }, [actor.schoolId, online]);

  useEffect(() => {
    if (!point) return;
    setImportance(null);
    gql(GET_RISK_IMPORTANCE, { school_id: actor.schoolId, prediction_point: point })
      .then((d) => setImportance(d.getRiskImportance))
      .catch(() => setImportance({ unavailable: true }));
  }, [actor.schoolId, point, online]);

  const o = view.data;
  const school = o ? lastTwo(o.points) : { now: null, before: null };
  const moved = change(school.now, school.before);

  // Classes at their latest checkpoint, highest flagged share first, with the change since the one before.
  const ranked = useMemo(() => (o?.classes || [])
    .map((c) => {
      const { now, before } = lastTwo(c.series);
      return { ...c, now, d: now && before ? now.at_risk - before.at_risk : null };
    })
    .filter((c) => c.now)
    .sort((a, b) => b.now.rate - a.now.rate || b.now.at_risk - a.now.at_risk), [o]);

  if (!o) {
    return view.savedAt === undefined
      ? <Skeleton tiles={4} lines={7} label="Loading the school overview" />
      : <EmptyState title="Not available">The overview could not be loaded, and there is no copy saved on this device yet.</EmptyState>;
  }
  if (!school.now) {
    return (
      <>
        <div className="page-head"><h1>School risk, {o.academic_year ?? '—'}</h1></div>
        <EmptyState title="No estimates yet">Estimates are made when Mid-term and End-term results are published.</EmptyState>
      </>
    );
  }

  const above = ranked.filter((c) => c.now.rate > school.now.rate).length;
  const plotted = [...o.points.map((p) => p.rate ?? 0), ...o.forms.filter((f) => forms.has(f.key)).flatMap((f) => f.series.map((s) => s.rate ?? 0))];
  const yMax = Math.min(100, Math.max(10, Math.ceil((Math.max(...plotted) * 100 * 1.25) / 10) * 10));
  const toggle = (key) => setForms((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <>
      <div className="page-head">
        <h1>School risk, {o.academic_year}</h1>
        <Info label="What flagged means">
          After each Mid-term and End-term, the model estimates every student&apos;s risk of finishing the year below the pass
          mark. A student is flagged when that estimate reaches the model&apos;s threshold. Flags show where to look; they are
          not judgements about students.
        </Info>
      </div>
      {view.fromDevice && <Notice tone="warn">Offline: this is the copy saved on this device at {new Date(view.savedAt).toLocaleString()}.</Notice>}

      <div className="card headline">
        <b>{school.now.at_risk} of {school.now.students} students ({pct(school.now.rate)})</b> are flagged at {LONG[school.now.point]}
        {moved ? <>, <span className={moved.d > 0 ? 'risk' : moved.d < 0 ? 'good' : ''}>{moved.text}</span>.</> : '.'}
        {' '}{o.interventions_ongoing} intervention{o.interventions_ongoing === 1 ? ' is' : 's are'} under way
        {o.students_with_interventions != null ? ` for ${students(o.students_with_interventions)}` : ''}.
      </div>

      <div className="stats">
        <StatTile value={school.now.at_risk} of={school.now.students} label={`flagged at ${SHORT[school.now.point]}`} tone="risk" />
        <StatTile delta={moved?.d ?? null} label={school.before ? `flagged since ${SHORT[school.before.point]}` : 'change since the last checkpoint'} />
        <StatTile value={above} of={ranked.length} label="classes above the school rate" />
        <StatTile value={o.interventions_ongoing} label="interventions under way"
          sub={o.students_with_interventions != null ? `for ${students(o.students_with_interventions)}` : null} />
      </div>

      <ChartCard
        title="Share of students flagged, by checkpoint"
        subtitle="Lower is better. Select a form to compare it with the whole school."
        actions={o.forms.length > 1 && (
          <div className="chips" role="group" aria-label="Compare a form">
            {o.forms.map((f) => (
              <button key={f.key} type="button" className={`chip toggle${forms.has(f.key) ? ' on' : ''}`} aria-pressed={forms.has(f.key)} onClick={() => toggle(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
      >
        <LineChart
          title="Share of students flagged at each checkpoint"
          labels={POINTS.map((p) => SHORT[p])}
          yLabel="% of students flagged"
          yMax={yMax}
          valueLabels
          format={(v) => `${Math.round(v * 10) / 10}%`}
          series={[
            { name: 'Whole school', emphasis: true, values: o.points.map((p) => (p.students ? p.rate * 100 : null)), detail: o.points.map((p) => (p.students ? `${p.at_risk} of ${p.students}` : null)) },
            ...o.forms.filter((f) => forms.has(f.key)).map((f) => ({
              name: f.label, values: f.series.map((s) => (s.students ? s.rate * 100 : null)), detail: f.series.map((s) => (s.students ? `${s.at_risk} of ${s.students}` : null)),
            })),
          ]}
        />
      </ChartCard>

      <section className="card stack">
        <div className="row">
          <h2 className="grow">Where to look first</h2>
          <Info label="How classes are ordered">Classes are ordered by the share of their students flagged at the latest checkpoint. The change is the number of flagged students since the checkpoint before. The mark on each bar is the school rate.</Info>
        </div>
        <div className="table-wrap">
          <table className="ranking">
            <thead>
              <tr><th>Class</th><th>Flagged at {SHORT[school.now.point]}</th><th>Share of the class</th><th>Change</th><th>Interventions under way</th><th /></tr>
            </thead>
            <tbody>
              {ranked.map((c) => (
                <tr key={c.key}>
                  <td><b className="class-name">{c.label}</b>{c.now.rate > school.now.rate && <span className="pill risk above">Above school rate</span>}</td>
                  <td>{students(c.now.at_risk)} <span className="hint">of {c.now.students}</span></td>
                  <td>
                    <span className="share-cell">
                      <Meter value={c.now.rate} max={yMax / 100} mark={(school.now.rate * 100 * 100) / yMax} tone="risk" />
                      <b>{pct(c.now.rate)}</b>
                    </span>
                  </td>
                  <td><Trend d={c.d} /></td>
                  <td>{c.interventions_ongoing ?? 0}</td>
                  <td className="actions"><Link to={`/risk?class=${c.key}`} state={{ from: here(location) }}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="more">
          <summary>Every checkpoint, by form and class</summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Form or class</th>{POINTS.map((p) => <th key={p} className="num">{SHORT[p]}</th>)}</tr></thead>
              <tbody>
                {[...o.forms, ...o.classes].map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    {r.series.map((s) => <td key={s.point} className="num">{s.students ? `${pct(s.rate)} (${s.at_risk}/${s.students})` : '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <ChartCard
        title="What the model weighs most"
        subtitle={importance?.observed?.groups?.length
          ? `Each factor’s share of what moved estimates across ${students(importance.observed.students)} at ${LONG[point]}. It shows what the model pays attention to, not what causes risk.`
          : 'Each factor’s share of what moved the estimates. It shows what the model pays attention to, not what causes risk.'}
        actions={<Select aria-label="Checkpoint" value={point ?? ''} onChange={setPoint} options={POINTS.map((p) => ({ value: p, label: LONG[p] }))} />}
      >
        {!importance && <Skeleton bare lines={5} label="Loading the model's factors" />}
        {importance?.unavailable && <p className="hint">Needs a connection.</p>}
        {importance && !importance.unavailable && (
          importance.observed?.groups?.length ? (
            <>
              <ShareBars items={importance.observed.groups} label="Influence across the school" />
              {importance.model?.groups?.length > 0 && (
                <details className="more">
                  <summary>Compared with the model&apos;s own evaluation</summary>
                  <ShareBars items={importance.model.groups} label="Influence in the model's evaluation" />
                </details>
              )}
            </>
          ) : <p className="hint">No estimates at {LONG[point]} yet.</p>
        )}
      </ChartCard>
    </>
  );
}
