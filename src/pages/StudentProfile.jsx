import { useEffect, useRef, useState } from 'react';
import { gql } from '../api/graphql.js';
import { SELECT_STUDENT_TARGET } from '../api/decisionOperations.js';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { backTo } from '../navigation.js';
import { CHECKPOINT_ORDER, FREQUENCY_LABEL } from '@gradebook/domain/decision';
import { CHECKPOINT_LABEL } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { Select } from '../components/Field.jsx';
import LineChart from '../components/LineChart.jsx';
import { influenceItems, summarise, Targets } from '../components/RiskExplanation.jsx';
import { profileAssessments } from '../profileComparison.js';
import SubjectPerformanceChart from '../components/SubjectPerformanceChart.jsx';
import { InfluenceChart } from '../components/ui.jsx';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';

const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const mark = (v) => (v == null ? '—' : `${Math.round(v * 10) / 10}`);
const SHORT = { T1M: 'T1 Mid', T1F: 'T1 End', T2M: 'T2 Mid', T2F: 'T2 End', T3M: 'T3 Mid', T3F: 'T3 End' };

/** "Kiswahili: +4 (40 to 44)" for a change in a factor, with the unit it is measured in. */
const changeText = (factor, from, to) => {
  if (from == null || to == null) return '—';
  const unit = factor === 'Attendance' ? ' points' : '';
  const d = Math.round((to - from) * 10) / 10;
  return `${d >= 0 ? '+' : ''}${d}${unit} (${mark(from)} to ${mark(to)})`;
};

/** The checkpoint a target column is for: T2M_Kiswahili and Attendance_T2M are both Term 2 Mid-term. */
const targetCheckpoint = (column) => {
  const point = column.startsWith('Attendance_') ? column.slice('Attendance_'.length) : column.split('_')[0];
  return CHECKPOINT_LABEL[point] ?? point;
};

function Outcome({ i }) {
  const o = i.outcome;
  if (!i.linked) return <span className="hint">Not linked to a prediction</span>;
  if (!o?.to_point) return <span className="hint">Waiting for the next published results</span>;
  return (
    <span>
      {changeText(i.factor, o.from, o.to)} by {o.to_label}
      {o.target_gain != null && (
        <span className={o.reached_target ? 'good' : 'warn'}> · target +{o.target_gain} {o.reached_target ? 'reached' : 'not reached'}</span>
      )}
      {o.risk_to != null && <span className="hint"> · estimate {pct(o.risk_from)} to {pct(o.risk_to)}</span>}
    </span>
  );
}

function AssessmentPanel({
  heading,
  entry,
  options,
  value,
  onChange,
  targetIndex,
  onTargetIndexChange,
  allowTargetSelection = false,
  onSaveTarget,
  savingTarget = false,
  targetSaveDisabled = false,
  isCurrent,
  selectedOnly = false,
}) {
  const prediction = entry?.prediction;
  const results = entry?.results;
  const factors = entry?.factors ?? [];
  const interventions = entry?.interventions ?? [];

  return (
    <div className="card stack assessment-panel">
      <div className="assessment-panel-heading">
        <div>
          <h2>{heading}</h2>
          {prediction && <div className="hint">{prediction.label}</div>}
        </div>

        {onChange && <label className="assessment-picker">
          <span>Assessment checkpoint</span>
          <Select
            value={value ?? ''}
            onChange={onChange}
            options={options}
            placeholder="No assessment available"
            disabled={!options.length}
            aria-label={`${heading} checkpoint`}
          />
        </label>}
      </div>

      {!entry ? (
        <div className="hint">No assessment is available for comparison.</div>
      ) : (
        <>
          {/* 1. Estimated risk */}
          <div className="assessment-risk">
            <span>Estimated risk:</span>

            <b className={prediction.at_risk ? 'risk' : ''}>
              {pct(prediction.probability)}
            </b>

            <span className={`pill ${prediction.at_risk ? 'risk' : 'good'}`}>
              {prediction.at_risk ? 'At risk' : 'Not flagged'}
            </span>

            {isCurrent === false && (
              <span className="pill recording">Not current</span>
            )}
          </div>

          {/* 2. Results */}
          <h3>Subject results</h3>

          {results ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Result</th>
                    <th>Grade</th>
                  </tr>
                </thead>

                <tbody>
                  {results.subjects.map((s) => (
                    <tr key={s.subject}>
                      <td>{s.subject}</td>
                      <td>{mark(s.score)}</td>
                      <td>{s.grade ?? '—'}</td>
                    </tr>
                  ))}

                  {results.average != null && (
                    <tr>
                      <td><b>Average</b></td>
                      <td><b>{mark(results.average)}</b></td>
                      <td />
                    </tr>
                  )}

                  {results.subjects.length === 0 && (
                    <tr className="empty">
                      <td colSpan={3}>No subject results available.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="hint">
              No published results are associated with this checkpoint.
            </div>
          )}

          {/* 3. SHAP explanation */}
          <h3>What moved the estimate</h3>

          {entry.historyIncomplete ? (
            <div className="hint">Historical explanations were not saved in this offline copy. Reconnect to load them.</div>
          ) : !entry.explained ? (
            <div className="hint">
              This estimate was made before explanations were available.
            </div>
          ) : factors.length ? (
            <>
              {summarise(factors) && (
                <div>{summarise(factors)}</div>
              )}
              <InfluenceChart items={influenceItems(factors)} />
            </>
          ) : (
            <div className="hint">
              No visible factor contributions are available.
            </div>
          )}

          {/* 4. Model-generated targets */}
          <h3>Model-generated targets</h3>

          {entry.historyIncomplete ? (
            <div className="hint">Reconnect to load targets for this checkpoint.</div>
          ) : entry.targets ? (
            <>
              {entry.targets.partial && (
                <div className="hint">
                  Showing only the targets within your subject scope.
                </div>
              )}

              {entry.targets.partial &&
                !entry.targets.options.length &&
                ['FOUND', 'FALLBACK'].includes(entry.targets.status) ? (
                  <div className="hint">
                    The targets do not involve your subjects.
                  </div>
                ) : (
                  <Targets
                    targets={entry.targets}
                    selectedIndex={targetIndex}
                    onSelectedIndexChange={onTargetIndexChange}
                    allowSelection={allowTargetSelection}
                    selectedOnly={selectedOnly}
                    onSave={onSaveTarget}
                    saving={savingTarget}
                    saveDisabled={targetSaveDisabled}
                  />
                )}
            </>
          ) : (
            <div className="hint">
              {prediction.at_risk
                ? 'No model-generated targets were available for this prediction.'
                : 'Not flagged at risk, so no targets were generated.'}
            </div>
          )}

          {/* 5. Interventions */}
          <h3>Interventions linked to this assessment</h3>

          {interventions.length === 0 ? (
            <div className="hint">
              No interventions were logged against this prediction.
            </div>
          ) : (
            <ul className="plain">
              {interventions.map((i) => (
                <li key={i.intervention_id}>
                  <b>{i.method}</b>

                  <span className="hint">
                    {' '}({i.factor}, {FREQUENCY_LABEL[i.frequency]?.toLowerCase() ?? i.frequency})
                  </span>

                  <div className="hint">
                    Started: {i.started_on} ·{' '}
                    {i.status === 'ONGOING'
                      ? 'Ongoing'
                      : `Stopped ${i.stopped_on}`}
                  </div>

                  <div>
                    Target:{' '}
                    {i.linked?.target
                      ? `+${i.linked.target.gain} (${mark(i.linked.target.from)} to ${mark(i.linked.target.to)})`
                      : 'None set'}
                  </div>

                  <div>
                    Result: <Outcome i={i} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A student's risk profile: the latest prediction with its explanation and
 * targets, how risk and results moved through the year, and the interventions
 * teachers recorded with what followed them. Everything here is a
 * decision-support signal; it does not say what will happen, and what followed
 * an intervention is not proof that it worked.
 */
export default function StudentProfile() {
  const { studentId } = useParams();
  const { actor } = useAuth();
  const { online } = useSync();
  const navigate = useNavigate();
  const location = useLocation();
  const [view, setView] = useState({ data: null, fromDevice: false, savedAt: null });
  const [year, setYear] = useState(null); // null: the current school year
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [laterAssessmentPoint, setLaterAssessmentPoint] = useState(null);
  const [earlierAssessmentPoint, setEarlierAssessmentPoint] = useState(null);
  const [laterTargetIndex, setLaterTargetIndex] = useState(null);
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetMessage, setTargetMessage] = useState('');
  const activeView = useRef(null);
  activeView.current = `${actor.schoolId}:${studentId}:${year}`;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setTargetMessage('');
    setView({ data: null, fromDevice: false, savedAt: null });
    setComparisonOpen(false);
    setLaterAssessmentPoint(null);
    setEarlierAssessmentPoint(null);
    setLaterTargetIndex(null);
    repository.loadProfile(actor.schoolId, studentId, year)
      .then((v) => live && setView(v))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [actor.schoolId, studentId, online, year]);

  async function saveTarget(option_index) {
    const profile = view.data;
    const viewKey = activeView.current;
    setSavingTarget(true);
    setTargetMessage('');
    try {
      const { selectStudentTarget: saved } = await gql(SELECT_STUDENT_TARGET, { input: {
        school_id: actor.schoolId, student_id: profile.student.student_id,
        prediction_token: profile.targets.prediction_token,
        expected_version: profile.targets.selection_version ?? 0, option_index,
      } });
      if (activeView.current !== viewKey) return;
      setView((v) => {
        if (v.data?.student.student_id !== profile.student.student_id || v.data?.targets?.prediction_token !== saved.prediction_token) return v;
        return { ...v, data: { ...v.data,
          targets: { ...v.data.targets, ...saved },
          assessment_history: v.data.assessment_history?.map((entry) => entry.targets?.prediction_token === saved.prediction_token
            ? { ...entry, targets: { ...entry.targets, ...saved } } : entry),
        } };
      });
      setTargetMessage('');
    } catch (e) {
      if (activeView.current === viewKey) setTargetMessage(`Not saved: ${e.message}`);
    } finally { setSavingTarget(false); }
  }

  const p = view.data;
  if (error) return <div className="stack"><Link to="/dashboard">Back</Link><div className="notice">{error}</div></div>;
  if (!p) return <div className="hint">{loading ? 'Loading…' : 'This profile has not been opened on this device before, so it cannot be shown offline.'}</div>;
  const assessmentHistory = profileAssessments(p);
  const active = (p.student.status || 'ACTIVE') === 'ACTIVE';
  const years = p.available_years || [];
  const viewingPast = years.length > 0 && p.academic_year !== years[0];

  // The first panel defaults to the newest available prediction.
  const defaultLaterAssessment = assessmentHistory.at(-1) ?? null;

  const laterAssessment =
    assessmentHistory.find(
      (a) => a.prediction.prediction_point === laterAssessmentPoint
    ) ?? defaultLaterAssessment;

  const laterPoint =
    laterAssessment?.prediction.prediction_point ?? null;

  const laterIndex = laterPoint
    ? CHECKPOINT_ORDER.indexOf(laterPoint)
    : -1;

  // The second panel must always contain an earlier checkpoint.
  const earlierAssessment =
    assessmentHistory.find(
      (a) =>
        a.prediction.prediction_point === earlierAssessmentPoint &&
        CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) < laterIndex
    ) ??
    assessmentHistory
      .filter(
        (a) =>
          CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) < laterIndex
      )
      .at(-1) ??
    null;

  const earlierPoint =
    earlierAssessment?.prediction.prediction_point ?? null;

  const earlierIndex = earlierPoint
    ? CHECKPOINT_ORDER.indexOf(earlierPoint)
    : -1;

  // Selecting any later checkpoint automatically repairs the earlier selection.
  const laterOptions = assessmentHistory.slice(1).reverse().map((a) => ({
    value: a.prediction.prediction_point, label: a.prediction.label,
  }));

  // Earlier panel: only checkpoints before the later panel's selection.
  const earlierOptions = assessmentHistory
    .filter(
      (a) =>
        laterIndex !== -1 &&
        CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) < laterIndex
    )
    .slice()
    .reverse()
    .map((a) => ({
      value: a.prediction.prediction_point,
      label: a.prediction.label,
    }));

  // Targets are selectable only for the most recent, current prediction.
  const canSwitchLaterTargets =
      active && !viewingPast && Boolean(laterPoint) &&
      laterPoint === p.latest?.prediction_point &&
      p.current === true;

  const handleLaterAssessmentChange = (point) => {
    const newIndex = CHECKPOINT_ORDER.indexOf(point);

    // If the current earlier selection is no longer valid,
    // move it to the nearest available earlier checkpoint.
    if (earlierIndex >= newIndex) {
      const replacement = assessmentHistory
        .filter(
          (a) =>
            CHECKPOINT_ORDER.indexOf(a.prediction.prediction_point) < newIndex
        )
        .at(-1);

      setEarlierAssessmentPoint(
        replacement?.prediction.prediction_point ?? null
      );
    }

    setLaterAssessmentPoint(point);
    setLaterTargetIndex(null);
  };

  const handleEarlierAssessmentChange = (point) => {
    setEarlierAssessmentPoint(point);
  };

  const points = CHECKPOINT_ORDER.filter((c) => p.risk_trend.some((r) => r.prediction_point === c) || p.performance_trend.some((r) => r.point === c));
  const riskAt = new Map(p.risk_trend.map((r) => [r.prediction_point, r.probability * 100]));
  const resultsAt = new Map(p.performance_trend.map((r) => [r.point, r]));
  const subjects = [...new Set(p.performance_trend.flatMap((r) => r.subjects.map((s) => s.subject)))];
  const latest = p.latest;

  return (
    <div className="stack">
      <button type="button" className="btn link back" onClick={() => navigate(backTo(location))}>Back</button>
      {view.fromDevice && <div className="notice">You are offline. This is the copy saved on this device at {new Date(view.savedAt).toLocaleString()}.</div>}

      <div className="card profile-head">
        <h1>{p.student.first_name} {p.student.last_name}</h1>

        <div className="profile-student-info profile-info">
          <div>
            Admission no: <b>{p.student.admission_no}</b>
          </div>
          <div>
            Class: <b>{p.student.class_name ?? '—'}</b>
          </div>
        </div>

        {p.student.status === 'GRADUATED' && <b>Graduated{p.student.graduation_year ? ` ${p.student.graduation_year}` : ''}</b>}
        {p.student.status === 'INACTIVE' && <b className="warn">Not active</b>}
        {years.length > 1 && (
          <label className="choice-inline">
            School year{' '}
            <select value={String(p.academic_year)} onChange={(e) => setYear(Number(e.target.value) === years[0] ? null : Number(e.target.value))}>
              {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
            {p.year_class_name && <span className="hint">in {p.year_class_name}</span>}
          </label>
        )}
        {active && !viewingPast && (
          <Link className="btn primary" to={`/students/${studentId}/interventions`} state={{ from: backTo(location) }}>Log or update interventions</Link>
        )}

        <div className="profile-teaching-info profile-info">
          <div>
            Subjects taught:{' '}
            <b>{p.teaching?.subjects?.length
              ? p.teaching.subjects.join(', ')
              : 'No subject assignments available'}</b>
          </div>

          {p.teaching?.isClassTeacher && (
            <span className="pill good">Class teacher</span>
          )}
        </div>
      </div>
      {!active && <div className="notice">This student has {p.student.status === 'GRADUATED' ? 'graduated' : 'left the school'}. Their record is read-only.</div>}
      {active && viewingPast && <div className="notice">You are looking at {p.academic_year}, an earlier school year. Interventions are logged against the current year.</div>}


      {!p.scope.all && (
        <div className="hint">You see {p.scope.factors.join(' and ')}: the subject{p.scope.factors.length === 1 ? '' : 's'} you teach this student. The class teacher sees every subject and attendance.</div>
      )}
      {!latest && <div className="notice">No risk prediction for this student in {p.academic_year ?? 'this school year'} yet. Predictions are made when Mid-term and End-term results are published.</div>}
      {latest && !p.current && (
        <div className="notice">
          Not current: results up to {CHECKPOINT_LABEL[p.last_published_point]} are published, but the latest prediction is from {latest.label}.
          It is shown until a new prediction is made.
        </div>
      )}

      {p.results && !assessmentHistory.some((entry) => entry.results?.point === p.results.point) && (
        <div className="card stack">
          <h2>{p.results.label} (latest published results)</h2>
          <div className="hint">These published results do not have a matching prediction in this view.</div>
          <div className="table-wrap"><table>
            <thead><tr><th>Subject</th><th>Result</th><th>Grade</th></tr></thead>
            <tbody>
              {p.results.subjects.map((subject) => <tr key={subject.subject}><td>{subject.subject}</td><td>{mark(subject.score)}</td><td>{subject.grade ?? '—'}</td></tr>)}
              {p.results.average != null && <tr><td><b>Average</b></td><td><b>{mark(p.results.average)}</b></td><td /></tr>}
            </tbody>
          </table></div>
        </div>
      )}

      {targetMessage && laterAssessment?.targets?.status === 'FOUND' && laterAssessment.targets.options.filter((option) => option.method === 'dice-random').length > 1 && <div className="notice" role="alert">{targetMessage}</div>}
      {assessmentHistory.length > 0 && <div className="assessment-toolbar">
        <div>
          <h2>Assessment overview</h2>
          <p className="hint">{comparisonOpen
            ? 'Choose two assessment checkpoints to compare.'
            : 'The latest available assessment for this school year.'}</p>
        </div>
        {assessmentHistory.length > 1 && <button type="button" className="btn assessment-compare-toggle"
          aria-expanded={comparisonOpen} aria-controls="assessment-panels"
          onClick={() => {
            if (comparisonOpen) {
              setLaterAssessmentPoint(null);
              if (laterPoint !== p.latest?.prediction_point) setLaterTargetIndex(null);
            }
            setComparisonOpen((open) => !open);
          }}>
          {comparisonOpen ? 'Close comparison' : 'Compare with earlier assessment'}
        </button>}
      </div>}
      <div id="assessment-panels" className={`profile-grid assessment-comparison${comparisonOpen ? ' is-comparing' : ''}`}>
        <AssessmentPanel
          heading={comparisonOpen ? "Later assessment" : active && !viewingPast && p.current ? "Current assessment" : "Latest available assessment"}
          entry={laterAssessment}
          options={laterOptions}
          onChange={comparisonOpen ? handleLaterAssessmentChange : undefined}
          value={laterPoint ?? ''}
          targetIndex={laterTargetIndex}
          onTargetIndexChange={setLaterTargetIndex}
          allowTargetSelection={canSwitchLaterTargets && p.scope.all}
          selectedOnly={!canSwitchLaterTargets || !p.scope.all}
          onSaveTarget={canSwitchLaterTargets && p.scope.all ? saveTarget : undefined}
          savingTarget={savingTarget}
          targetSaveDisabled={!online || loading}
          isCurrent={laterPoint === p.latest?.prediction_point && p.current === true}
        />

        {comparisonOpen && <AssessmentPanel
          heading="Earlier assessment"
          entry={earlierAssessment}
          options={earlierOptions}
          value={earlierPoint ?? ''}
          onChange={handleEarlierAssessmentChange}
          targetIndex={earlierAssessment?.targets?.selected_option ?? 0}
          allowTargetSelection={false}
          selectedOnly
        />}
      </div>

      <div className="two-col">
        <div className="card stack">
          <h2>Estimated risk through the year</h2>
          {p.risk_trend.length ? (
            <LineChart title="Estimated risk by checkpoint" labels={points.map((c) => SHORT[c])}
              series={[{ name: 'Estimated risk', emphasis: true, values: points.map((c) => riskAt.get(c) ?? null) }]} yLabel="% estimated risk" valueLabels
              line={latest ? { value: latest.threshold * 100, label: `flagged from ${Math.round(latest.threshold * 100)}%` } : null} format={(v) => `${Math.round(v)}%`} />
          ) : <div className="hint">No predictions yet.</div>}
        </div>
        <div className="card stack">
          <h2>{p.scope.all ? 'Average result' : 'Your subjects’ results'}</h2>
          {p.performance_trend.length ? (
            <LineChart title="Results by checkpoint" labels={points.map((c) => SHORT[c])}
              series={p.scope.all
                ? [{ name: 'Average', emphasis: true, values: points.map((c) => resultsAt.get(c)?.average ?? null) }]
                : subjects.map((s) => ({ name: s, values: points.map((c) => resultsAt.get(c)?.subjects.find((x) => x.subject === s)?.score ?? null) }))} />
          ) : <div className="hint">No published results yet.</div>}
        </div>
      </div>
      {p.scope.all && subjects.length > 0 && (
        <div className="card stack">
          <h2>Results by subject</h2>
          <SubjectPerformanceChart
            performanceTrend={p.performance_trend}
            subjects={subjects}
            targetOption={
              canSwitchLaterTargets
                ? laterAssessment?.targets?.options?.find((option, i) => (option.option_index ?? i) === (laterTargetIndex ?? laterAssessment.targets.selected_option ?? 0)) ?? null
                : null
            }
          />
        </div>
      )}

      <div className="card stack">
        <h2>Intervention history</h2>
        {p.interventions.length === 0 && <div className="hint">No interventions recorded{p.scope.all ? '' : ' for your subjects'}.</div>}
        {p.interventions.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Started</th><th>For</th><th>Intervention</th><th>Status</th><th>Target then</th><th>What followed</th><th>By</th></tr></thead>
              <tbody>
                {p.interventions.map((i) => (
                  <tr key={i.intervention_id}>
                    <td>{i.started_on}</td>
                    <td>{i.factor}</td>
                    <td>{i.method}<div className="hint">{FREQUENCY_LABEL[i.frequency]}{i.expected_outcome ? ` · expected: ${i.expected_outcome}` : ''}</div></td>
                    <td>{i.status === 'ONGOING' ? 'Ongoing' : `Stopped ${i.stopped_on}`}</td>
                    <td>{i.linked?.target ? `+${i.linked.target.gain} by ${targetCheckpoint(i.linked.target.column)}` : '—'}</td>
                    <td><Outcome i={i} /></td>
                    <td>{i.created_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint">
          &quot;What followed&quot; is monitoring: how the result and the estimate moved after the intervention began. It does not show
          that the intervention caused the change.
        </div>
      </div>
    </div>
  );
}
