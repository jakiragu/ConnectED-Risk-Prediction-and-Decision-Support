import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MISSING_POLICY_LABEL } from '@gradebook/domain/grading';
import { gql } from '../api/graphql.js';
import { LIST_SCHOOL_CLASSES, LIST_RESULT_SETS } from '../api/operations.js';
import { LIST_TERMS_FULL } from '../api/calendarOperations.js';
import { GET_CLASS_PROFILE } from '../api/classOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { EmptyState, Notice, Offline } from '../components/ui.jsx';
import { Select } from '../components/Field.jsx';
import LineChart from '../components/LineChart.jsx';
import { AreaChart, ChartCard, ScaleBar, SERIES_COLORS } from '../components/charts.jsx';
import { classLabel, sortClasses } from '../classLabels.js';

const CHECKPOINT_ORDER = ['OPENER', 'MIDTERM', 'ENDTERM'];
const fmt = (x, dp = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Number(x).toFixed(dp));
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
/** An estimate is never shown as certain: 0.997 reads ">99%", not "100%". */
const riskPct = (x) => (x === null || x === undefined ? '—' : x >= 0.995 ? '>99%' : x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
const name = (s) => `${s.first_name} ${s.last_name}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const FREQUENCY = { DAILY: 'daily', WEEKLY: 'weekly', FORTNIGHTLY: 'every two weeks', MONTHLY: 'monthly', ONCE: 'once' };

function Change({ value, unit = '' }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value === 0) return <span className="change flat">no change</span>;
  const up = value > 0;
  return (
    <span className={`change ${up ? 'up' : 'down'}`} title="Since the previous exam">
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : '−'}{fmt(Math.abs(value))}{unit}
    </span>
  );
}

/** A 0–100 bar with the pass mark marked, for subject averages and risk factor shares. */
function Meter({ value, max = 100, mark = null, tone = '' }) {
  const width = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  return (
    <span className={`meter ${tone}`} aria-hidden="true">
      <span className="fill" style={{ width: `${width}%` }} />
      {Number.isFinite(mark) && <span className="mark" style={{ left: `${mark}%` }} />}
    </span>
  );
}

function RulesPanel({ rules, checkpoint }) {
  const label = (c) => rules.labels.find((l) => l.checkpoint === c)?.label ?? c;
  const w = rules.checkpoint_weights;
  return (
    <details className="card rules-panel">
      <summary><h2>How results are calculated</h2></summary>
      <div className="rules-grid">
        <div>
          <h3>The term result</h3>
          {w ? (
            <p>
              {[rules.opener_enabled && w.opener ? `${label('OPENER')} ${w.opener}%` : null, `${label('MIDTERM')} ${w.midterm}%`, `${label('ENDTERM')} ${w.endterm}%`]
                .filter(Boolean).join(' + ')} of each subject’s exam results.
            </p>
          ) : <p className="hint">An administrator has not set this term’s weights yet.</p>}
          {checkpoint !== 'ENDTERM' && <p className="hint">At the {label(checkpoint)} the result shown is that exam’s average across subjects.</p>}
        </div>
        <div>
          <h3>Missing marks</h3>
          <p>{MISSING_POLICY_LABEL[rules.missing_score_policy] ?? '—'}.</p>
          <h3>Pass mark</h3>
          <p>{fmt(rules.pass_mark, 0)}%. Risk estimates use their own fixed definition (a year-end average below 50%).</p>
        </div>
        <div className="rules-scale">
          <h3>Grades</h3>
          <ScaleBar bands={rules.bands} passMark={rules.pass_mark} />
        </div>
      </div>
      <p className="hint">These rules are set by an administrator for the whole school.</p>
    </details>
  );
}

function sortRows(rows, key, dir) {
  const value = (r) => (key === 'name' ? `${r.last_name} ${r.first_name}`.toLowerCase() : r[key]);
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
  });
}

/** The range where most students fall, for a chart's one-line summary. */
const peak = (ranges, counts) => {
  const top = Math.max(...counts);
  return top > 0 ? ranges[counts.indexOf(top)] : null;
};

/**
 * The class page: how a class is doing, from its published results.
 * Administrators pick any class; class teachers see their whole class; subject
 * teachers see only the subjects they teach in it. The server applies the
 * scope, so the page only ever receives what the viewer may see.
 */
export default function ClassProfile() {
  const { classId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const myClasses = useLive(() => db().classes.toArray(), [], []);
  const [schoolClasses, setSchoolClasses] = useState([]);
  const [terms, setTerms] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const termId = params.get('term') || '';
  const checkpoint = params.get('exam') || '';

  useEffect(() => { repository.loadClasses(actor.schoolId).catch(() => { }); }, [actor.schoolId]);
  useEffect(() => {
    if (!online) return;
    gql(LIST_TERMS_FULL, { school_id: actor.schoolId })
      .then(({ listTerms }) => setTerms([...listTerms].sort((a, b) => (b.academic_year - a.academic_year) || (b.term_number - a.term_number))))
      .catch((e) => setError(e.message));
    if (isAdmin) gql(LIST_SCHOOL_CLASSES, { school_id: actor.schoolId }).then((d) => setSchoolClasses(d.listSchoolClasses)).catch(() => { });
  }, [online, isAdmin, actor.schoolId]);

  const classes = useMemo(() => {
    const list = isAdmin ? schoolClasses : myClasses;
    return sortClasses(list);
  }, [isAdmin, schoolClasses, myClasses]);

  const thisClass = classes.find((c) => c.class_id === classId);

  // Default: the current term, at the latest exam with published results for this class.
  useEffect(() => {
    if (!online || !terms.length || (termId && checkpoint)) return;
    // An archived class opens at the latest term of its own year, not today's term (it has no results then).
    const own = thisClass?.year ? terms.filter((t) => Number(t.academic_year) === Number(thisClass.year)) : [];
    const term = terms.find((t) => t.term_id === termId)
      ?? (thisClass?.status !== 'CURRENT' ? own[0] : undefined)
      ?? terms.find((t) => t.status === 'CURRENT')
      ?? terms[0];
    gql(LIST_RESULT_SETS, { school_id: actor.schoolId, class_id: classId, term_id: term.term_id })
      .then(({ listResultSets }) => {
        const published = (listResultSets || []).filter((s) => s.status === 'PUBLISHED').map((s) => s.checkpoint);
        const latest = [...CHECKPOINT_ORDER].reverse().find((c) => published.includes(c)) ?? 'MIDTERM';
        setParams({ term: term.term_id, exam: checkpoint || latest }, { replace: true });
      })
      .catch(() => setParams({ term: term.term_id, exam: checkpoint || 'MIDTERM' }, { replace: true }));
  }, [online, terms, termId, checkpoint, classId, actor.schoolId, setParams, thisClass]);

  useEffect(() => {
    if (!online || !termId || !checkpoint) return undefined;
    let live = true;
    setLoading(true);
    setError(null);
    gql(GET_CLASS_PROFILE, { school_id: actor.schoolId, class_id: classId, term_id: termId, checkpoint })
      .then(({ getClassProfile }) => { if (live) setData(getClassProfile); })
      .catch((e) => { if (live) { setError(e.message); setData(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [online, actor.schoolId, classId, termId, checkpoint]);

  if (!online) return <Offline what="The class page" />;

  const p = data?.profile;
  const full = data?.scope === 'FULL';
  const labels = data?.rules?.labels ?? CHECKPOINT_ORDER.map((c) => ({ checkpoint: c, label: { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End-term' }[c] }));
  const exams = labels.filter((l) => l.checkpoint !== 'OPENER' || data?.rules?.opener_enabled);
  const canManage = isAdmin || thisClass?.is_class_teacher;
  const setQuery = (patch) => setParams({ term: termId, exam: checkpoint, ...patch });
  const scopeName = data?.subjects?.join(' & ');

  // --------------------------------------------------------------- chart data
  const trend = data?.trend ?? [];
  const lastTwo = trend.filter((t) => t.mean !== null).slice(-2);
  const trendSummary = lastTwo.length === 2
    ? `${fmt(lastTwo[1].mean)} at the ${lastTwo[1].label}, ${lastTwo[1].mean >= lastTwo[0].mean ? 'up' : 'down'} ${fmt(Math.abs(lastTwo[1].mean - lastTwo[0].mean))} from the ${lastTwo[0].label}.`
    : lastTwo.length === 1 ? `${fmt(lastTwo[0].mean)} at the ${lastTwo[0].label}, the only published exam so far.` : null;
  const perf = data?.performance_distribution;
  const perfSummary = perf?.series.length
    ? perf.series.map((s) => `${s.label}: most in ${peak(perf.ranges, s.counts) ?? '—'}`).join(' · ')
    : null;
  const risk = data?.risk_distribution;
  const riskSummary = risk?.series.length
    ? risk.series.map((s) => `${s.label}: ${s.flagged} of ${s.predicted} flagged`).join(' · ')
    : null;
  const thresholdIndex = risk?.threshold != null ? Math.round(risk.threshold * 10) : null;

  // ------------------------------------------------------------- student table
  const shownStudents = p ? sortRows(p.students, sort.key, sort.dir) : [];
  const sortBy = (key) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'name' ? 'asc' : 'desc'), }));
  const th = (key, text, className = '') => (
    <th scope="col" className={className} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort" onClick={() => sortBy(key)}>
        {text}{sort.key === key && <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
      </button>
    </th>
  );
  const flaggedIds = p?.risk?.students.map((s) => s.student_id) ?? [];

  return (
    <>
      <div className="page-head class-head">
        <div className="grow">
          <h1>{data?.class_name ?? thisClass?.name ?? 'Class'}</h1>
          {data && (
            <p className="class-meta">
              {data.class_year && <span>{data.class_year}</span>}
              <span>{plural(data.student_count, 'student')}</span>
              <span>Class teacher: {data.class_teacher_name ?? 'not assigned'}</span>
              {data.viewer_is_class_teacher && <span className="pill accent">You are the class teacher</span>}
              {!data.viewer_is_class_teacher && data.my_subjects.length > 0 && <span className="pill neutral">You teach {data.my_subjects.join(', ')}</span>}
            </p>
          )}
        </div>
        {classes.length > 1 && (
          <Select aria-label="Choose a class" value={classId} onChange={(id) => navigate(`/classes/${id}?term=${termId}&exam=${checkpoint}`)}
            options={classes.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))} />
        )}
      </div>

      <nav className="tabs" aria-label="Class pages">
        <Link to={`/classes/${classId}`} aria-current="page">Overview</Link>
        {canManage && <Link to={`/classes/${classId}/students`}>Manage students</Link>}
        <Link to={`/assessments?class=${classId}`}>Assessments</Link>
      </nav>

      <div className="toolbar class-controls">
        <Select aria-label="Term" value={termId} onChange={(v) => setQuery({ term: v })}
          options={terms.map((t) => ({ value: t.term_id, label: `${t.name}${t.status === 'CURRENT' ? ' (current)' : ''}` }))} />
        <div className="segmented" role="group" aria-label="Exam">
          {exams.map((l) => (
            <button key={l.checkpoint} type="button" className={`seg${l.checkpoint === checkpoint ? ' active' : ''}`}
              aria-pressed={l.checkpoint === checkpoint} onClick={() => setQuery({ exam: l.checkpoint })}>
              {l.label}
            </button>
          ))}
        </div>
        {data && (data.published
          ? <span className="pill good">Published {data.published_at ? new Date(data.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}</span>
          : <span className="pill neutral">Not published yet</span>)}
        {loading && <span className="hint" role="status">Loading…</span>}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p className="hint" role="status">Loading the class…</p>}

      {data && data.scope === 'SUBJECT' && (
        <Notice>
          You are seeing <b>{scopeName || 'no subjects'}</b>, the {data.subjects.length === 1 ? 'subject' : 'subjects'} you teach in this class.
          The class teacher and administrators see the whole class.
        </Notice>
      )}

      {data && (
        <section className="card class-overview" aria-label="Class overview">
          {/* 1. The chosen exam at a glance */}
          <div className="ov-col">
            <h2>{data.term_name} {data.checkpoint_label}</h2>
            {p ? (
              <>
                <div className="ov-headline">
                  <div>
                    <b className="big">{fmt(p.summary.mean)}</b>
                    <span className="hint">{full ? 'class average' : `${scopeName} average`}</span>
                  </div>
                  {p.summary.mean_grade && (
                    <div className="grade-badge" title="The grade of the class average">
                      <b>{p.summary.mean_grade}</b><span>mean grade</span>
                    </div>
                  )}
                </div>
                <p className="ov-compare">
                  <Change value={p.summary.mean_change} />
                  {p.summary.school_mean !== null && <span className="hint">School average {fmt(p.summary.school_mean)}</span>}
                </p>
                <dl className="ov-facts">
                  <dt>Pass rate</dt>
                  <dd>{pct(p.summary.pass_rate)} <span className="hint">at or above {fmt(p.summary.pass_mark, 0)}</span></dd>
                  {p.risk && (<>
                    <dt>Flagged at risk</dt>
                    <dd className={p.risk.flagged ? 'risk' : ''}>{p.risk.flagged} of {p.risk.predicted}{!full && <span className="hint"> whole class</span>}</dd>
                  </>)}
                  {full && (<>
                    <dt>Attendance</dt>
                    <dd>{p.summary.attendance_rate === null ? <span className="hint">not recorded</span> : `${fmt(p.summary.attendance_rate, 0)}%`}</dd>
                  </>)}
                  <dt>Incomplete</dt>
                  <dd>{p.summary.incomplete ? plural(p.summary.incomplete, 'student') : 'none'}</dd>
                </dl>
                {full && (
                  <Link className="btn secondary small" to={`/report-cards?class=${classId}&term=${termId}&cp=${checkpoint}`}>Report cards</Link>
                )}
              </>
            ) : (
              <EmptyState title="Not published yet">
                The overview uses published results only.{' '}
                <Link to={`/assessments?class=${classId}&term=${termId}`}>See marking progress</Link>
              </EmptyState>
            )}
          </div>

          {/* 2. Subject averages, weakest first */}
          <div className="ov-col">
            <h2>{full ? 'Subject averages' : 'Your subject'}</h2>
            {p?.subject_results.length ? (
              <ul className="subject-list">
                {p.subject_results.map((s, i) => (
                  <li key={s.subject} className={i === 0 && p.subject_results.length > 2 ? 'weakest' : ''}>
                    <span className="s-name">{s.subject}</span>
                    <Meter value={s.mean} mark={p.summary.pass_mark} tone={s.mean !== null && s.mean < p.summary.pass_mark ? 'low' : ''} />
                    <span className="s-value">{fmt(s.mean)}</span>
                    <span className="s-change"><Change value={s.change} /></span>
                  </li>
                ))}
              </ul>
            ) : <p className="hint">Appears once this exam’s results are published.</p>}
            {p?.subject_results.length > 2 && <p className="hint">Weakest first. The tick marks the pass mark.</p>}
          </div>

          {/* 3. What drives risk here, and what is being done about it */}
          <div className="ov-col">
            {data.risk_distribution && (
              <>
                <h2>Top risk factors</h2>
                {data.top_factors.length ? (
                  <ol className="factor-list">
                    {data.top_factors.map((f) => (
                      <li key={f.factor}>
                        <span className="s-name">{f.factor}</span>
                        <Meter value={f.share} max={data.top_factors[0].share} tone="risk" />
                        <span className="s-value">{Math.round(f.share * 100)}%</span>
                      </li>
                    ))}
                  </ol>
                ) : <p className="hint">No estimates for this exam yet.</p>}
                <p className="hint">Share of what moved this class’s estimates; it shows what the model weighs, not what causes risk.</p>
              </>
            )}
            <h2 className="ov-sub">Intervention methods in use</h2>
            {data.intervention_methods.length ? (
              <ul className="method-list">
                {data.intervention_methods.slice(0, 5).map((m) => (
                  <li key={`${m.method}|${m.factor}`}>
                    <b>{m.method}</b>
                    <span className="hint">{m.factor}{m.frequency ? `, ${FREQUENCY[m.frequency] ?? m.frequency.toLowerCase()}` : ''} · {plural(m.students, 'student')}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="hint">No ongoing interventions in this class.</p>}
            {flaggedIds.length > 0 && (
              <Link className="btn small" to={`/interventions/new?students=${flaggedIds.join(',')}`} state={{ from: `${location.pathname}${location.search}` }}>
                Log an intervention for the {plural(flaggedIds.length, 'flagged student')}
              </Link>
            )}
          </div>
        </section>
      )}

      {data && (trend.length > 0 || perf?.series.length > 0 || risk?.series.length > 0) && (
        <section className="class-graphs" aria-label="Class graphs">
          <h2>Class graphs</h2>
          <div className="graph-grid">
            <ChartCard title="Performance trend" subtitle={trendSummary ?? 'Exam averages through the school year.'}>
              {trend.length ? (
                <LineChart title="Performance trend" labels={trend.map((t) => t.label)} yLabel="Average performance (%)"
                  series={[{ name: 'This class', values: trend.map((t) => t.mean), emphasis: true }, { name: 'School', values: trend.map((t) => t.school_mean) }]}
                  line={data.rules.pass_mark != null ? { value: data.rules.pass_mark, label: `pass mark ${fmt(data.rules.pass_mark, 0)}` } : undefined} valueLabels height={260} />
              ) : <p className="hint">No published exams this year yet.</p>}
            </ChartCard>

            <ChartCard title={`Performance distribution, ${data.term_name}`} subtitle={perfSummary ?? 'Students in each mark range, per exam.'}
              legend={perf?.series.map((s, k) => ({ label: s.label, color: SERIES_COLORS[k % SERIES_COLORS.length] }))}
            >
              {perf?.series.length ? (
                <AreaChart title="Performance distribution" ranges={perf.ranges} series={perf.series} xLabel="Exam average (marks)" />
              ) : <p className="hint">No published exams in {data.term_name} yet.</p>}
            </ChartCard>

            {risk && (
              <ChartCard title={`Risk score distribution, ${data.term_name}`} subtitle={riskSummary ?? 'Students in each band of estimated risk.'}
                legend={[...risk.series.map((s, k) => ({ label: s.label, color: SERIES_COLORS[k % SERIES_COLORS.length] })),
                ...(thresholdIndex !== null ? [{ label: `Flagged from ${Math.round(risk.threshold * 100)}%`, kind: 'dash risk' }] : [])]}
              >
                {risk.series.length ? (
                  <AreaChart title="Risk score distribution" ranges={risk.ranges} series={risk.series} xLabel="Estimated risk"
                    marker={thresholdIndex !== null ? { index: thresholdIndex, label: 'flagged →' } : null} />
                ) : <p className="hint">No risk estimates in {data.term_name} yet.</p>}
              </ChartCard>
            )}

            {p && data.previous_label && (
              <ChartCard title="Biggest changes" subtitle={`Since the ${data.previous_label}. A sudden drop is often a stronger signal than a steady low mark.`}>
                <div className="movement">
                  {[['Rose most', p.movement.risers, 'up'], ['Fell most', p.movement.fallers, 'down']].map(([title, list, tone]) => (
                    <div key={title}>
                      <h4>{title}</h4>
                      {list.length === 0 ? <p className="hint">Nobody.</p> : (
                        <ol className="move-list">
                          {list.map((m) => (
                            <li key={m.student_id}>
                              <Link to={`/students/${m.student_id}/risk`}>{name(m)}</Link>
                              <span className="hint"> {fmt(m.before)} → {fmt(m.now)}</span>
                              <span className={`change ${tone}`}> {m.change > 0 ? '+' : '−'}{fmt(Math.abs(m.change))}</span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ))}
                </div>
              </ChartCard>
            )}
          </div>
        </section>
      )}

      {p?.risk && p.risk.students.length > 0 && (
        <div className="card">
          <div className="panel-head">
            <h2>Flagged students</h2>
            <Link to={`/risk?class=${classId}&point=${data.risk_point}`}>Open in Risk prediction</Link>
          </div>
          <p className="takeaway">
            {full
              ? `${plural(p.risk.flagged, 'student')} flagged at the ${data.checkpoint_label}. ${p.risk.without_intervention ? `${p.risk.without_intervention} ${p.risk.without_intervention === 1 ? 'has' : 'have'} no intervention logged yet.` : 'Every flagged student has an intervention logged.'}`
              : `${plural(p.risk.students.length, 'flagged student')} where ${scopeName} raised the estimate.`}
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Student</th><th scope="col">Estimated risk</th><th scope="col">Raised mostly by</th><th scope="col">Support</th></tr></thead>
              <tbody>
                {p.risk.students.map((s) => (
                  <tr key={s.student_id}>
                    <td><Link to={`/students/${s.student_id}/risk`}>{name(s)}</Link> <span className="hint">{s.admission_no}</span></td>
                    <td className="risk">{riskPct(s.probability)}</td>
                    <td>{s.raised_by.join(', ') || '—'}</td>
                    <td>
                      {s.interventions
                        ? `${s.interventions} ongoing`
                        : <Link className="pill risk" to={`/students/${s.student_id}/interventions`}>None yet: log one</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Estimates point to students who may need attention; which support to give is your decision.</p>
        </div>
      )}

      {p && (
        <div className="card">
          <div className="panel-head"><h2>Students</h2><span className="hint">Select a heading to sort.</span></div>
          <div className="table-wrap">
            <table className="class-roster">
              <thead>
                <tr>
                  {th('name', 'Student')}
                  {th('result', full ? 'Result' : 'Result (your subjects)', 'num')}
                  {th('grade', 'Grade')}
                  {data.previous_label && th('change', 'Change', 'num')}
                  {full && th('attendance', 'Attendance', 'num')}
                  {p.risk && th('probability', 'Estimated risk', 'num')}
                  {p.risk && th('interventions', 'Interventions', 'num')}
                </tr>
              </thead>
              <tbody>
                {shownStudents.map((s) => (
                  <tr key={s.student_id}>
                    <td>
                      <Link to={`/students/${s.student_id}/risk`}>{name(s)}</Link> <span className="hint">{s.admission_no}</span>
                      {s.incomplete && <span className="pill neutral" title="A paper is missing, absent or not assessed">incomplete</span>}
                    </td>
                    <td className="num">{fmt(s.result)}</td>
                    <td>{s.grade ?? '—'}</td>
                    {data.previous_label && <td className="num"><Change value={s.change} /></td>}
                    {full && <td className="num">{s.attendance === null ? '—' : `${fmt(s.attendance, 0)}%`}</td>}
                    {p.risk && <td className={`num${s.at_risk ? ' risk' : ''}`}>{s.probability === null ? '—' : riskPct(s.probability)}</td>}
                    {p.risk && <td className="num">{s.interventions || '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && <RulesPanel rules={data.rules} checkpoint={data.checkpoint} />}
    </>
  );
}
