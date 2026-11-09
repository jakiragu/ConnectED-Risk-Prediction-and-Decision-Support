import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ulid } from '@gradebook/domain/ids';
import { gql } from '../api/graphql.js';
import { APPLY_PROMOTION, LIST_PROMOTION_RUNS, LIST_SCHOOL_CLASSES, PLAN_PROMOTION, REVERT_PROMOTION } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';
import { Notice, Offline } from '../components/ui.jsx';
import { repository } from '../offline/repository.js';
import { useSync } from '../offline/useSync.js';

/**
 * Closing a school year (administrators). The server builds the plan from what
 * is stored; this page only sends per-student choices and shows what the server
 * says will happen. Nothing changes until "Promote" is confirmed, and the run
 * can be undone until the new year has records of its own.
 */

const ACTION_LABEL = { PROMOTE: 'Promote', REPEAT: 'Repeat', GRADUATE: 'Graduate', LEAVE: 'Left the school' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Summary({ s }) {
  return (
    <div className="stats">
      <div className="stat"><b>{s.promote}</b><span>move up</span></div>
      <div className="stat"><b>{s.repeat}</b><span>repeat</span></div>
      <div className="stat"><b>{s.graduate}</b><span>graduate</span></div>
      <div className="stat"><b>{s.leave}</b><span>left the school</span></div>
      <div className="stat"><b>{s.classes_created}</b><span>classes created</span></div>
      <div className="stat"><b>{s.classes_archived}</b><span>classes archived</span></div>
    </div>
  );
}

function RunCard({ run, onUndo, busy }) {
  const done = run.status === 'APPLIED';
  return (
    <div className="card stack">
      <h2>
        {done ? `${run.from_year} was closed` : run.status === 'REVERTED' ? `Promotion of ${run.from_year} was undone` : `Promotion of ${run.from_year} is still running`}
      </h2>
      <div className="hint">
        {run.created_by_name ? `By ${run.created_by_name}. ` : ''}
        {run.applied_at ? `Applied ${new Date(run.applied_at).toLocaleString()}. ` : ''}
        {run.reverted_at ? `Undone ${new Date(run.reverted_at).toLocaleString()}${run.reverted_by_name ? ` by ${run.reverted_by_name}` : ''}.` : ''}
      </div>
      <Summary s={run.summary} />
      {done && (
        <div className="hint">
          {plural(run.interventions_stopped, 'ongoing intervention')} stopped because the school year ended.
          {` Teacher strategy: ${{ STAY: 'Stay with the form', FOLLOW: 'Follow the students', MANUAL: 'Assign manually' }[run.teacher_strategy]}.`}
        </div>
      )}
      {run.decisions?.length > 0 && <details><summary>Applied decisions and overrides ({run.decisions.length})</summary><div className="table-wrap"><table><thead><tr><th>Student</th><th>Average / pass mark</th><th>Automatic</th><th>Final decision</th><th>Override reason / administrator</th></tr></thead><tbody>{run.decisions.map((d) => <tr key={d.student_id}><td>{d.name}</td><td>{d.average ?? '—'} / {d.pass_mark ?? '—'}</td><td>{d.automatic_action || 'Legacy run'}</td><td>{d.action}</td><td>{d.overridden ? <>{d.override_reason || 'No reason supplied'} · {d.overridden_by_name || 'Unknown administrator'}{d.overridden_by && <span className="hint"> ({d.overridden_by})</span>}</> : '—'}</td></tr>)}</tbody></table></div></details>}
      {run.skipped.length > 0 && (
        <Notice tone="warn">
          {plural(run.skipped.length, 'student was', 'students were')} left as they were because someone changed them after the plan was made:{' '}
          {run.skipped.map((s) => s.name).join(', ')}. Move them from their class page.
        </Notice>
      )}
      {run.skipped_teachers.length > 0 && (
        <Notice tone="warn">
          Not updated because they were edited meanwhile: {run.skipped_teachers.join(', ')}. Check their classes on the Teachers page.
        </Notice>
      )}
      {done && (
        run.can_revert ? (
          <div className="weights-row">
            <button type="button" className="btn secondary" disabled={busy} onClick={onUndo}>Undo this promotion</button>
            <span className="hint">Possible until the new classes have assessments, attendance or interventions.</span>
          </div>
        ) : run.revert_blocked_reason && <div className="hint">{run.revert_blocked_reason}</div>
      )}
    </div>
  );
}

function ClassPlan({ c, choices, choose, search }) {
  const actionsFor = () => {
    if (!c.level) return [];
    return c.graduating ? ['GRADUATE', 'REPEAT', 'LEAVE'] : ['PROMOTE', 'REPEAT', 'LEAVE'];
  };
  const destinationsFor = (action) => {
    const level = action === 'PROMOTE' ? c.level + 1 : c.level;
    return choices.filter((d) => d.level === level);
  };
  const where = c.graduating
    ? 'graduates'
    : c.destination
      ? `${c.destination.name} ${c.destination.year}${c.destination.exists ? '' : ' (will be created)'}`
      : 'next level unknown';

  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(null);
  const matches = (s) => `${s.first_name} ${s.last_name} ${s.admission_no}`.toLowerCase().includes(search.toLowerCase());
  const attention = (s) => s.default_action === 'REPEAT' || s.result_problem || s.overridden;
  const published = c.publication_status === 'PUBLISHED';
  const shown = (published ? c.students : []).filter((s) => search ? matches(s) : expanded || attention(s));
  return (
    <div className="card stack">
      <h2>{c.source_name} → {where}</h2>
      <div className="hint">
        {c.class_teacher_name ? `Class teacher: ${c.class_teacher_name}. ` : 'No class teacher. '}
        {plural(c.active_count, 'active student')}
        {c.inactive_count ? `; ${c.inactive_count} deactivated (they stay on the archived class)` : ''}.
      </div>
      {!published && <Notice tone="warn"><b>Term 3 final results are not published.</b> Decisions for this class cannot be calculated until publication. Student rosters and actions are unavailable. <Link to="/results">Open Results</Link></Notice>}
      {published && <>
      <button type="button" className="btn secondary small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide full roster' : `Show full roster (${c.students.length})`}</button>
      {!shown.length && <p className="hint">{search ? 'No matching students in this class.' : 'No exceptions to review.'}</p>}
      </>}
      {shown.length > 0 && (
        <div className="table-wrap bordered">
          <table>
            <thead><tr><th>Admission no</th><th>Name</th><th>Average / pass mark</th><th>Action</th><th>Goes to</th></tr></thead>
            <tbody>
              {shown.map((s) => {
                const options = destinationsFor(s.action);
                return (
                  <tr key={s.student_id} className={s.overridden ? 'row-dirty' : undefined}>
                    <td>{s.admission_no}</td>
                    <td>{s.first_name} {s.last_name}{s.result_problem && <div className="warn">{s.result_problem}</div>}{s.overridden && <div className="hint">Override: {ACTION_LABEL[s.default_action] || 'Unresolved'} → {ACTION_LABEL[s.action]}</div>}</td>
                    <td>{s.average == null ? 'Unresolved' : `${s.average}%`} / {s.pass_mark}%</td>
                    <td>
                      {!s.overridden && s.default_action && <div className="hint">Automatic: {ACTION_LABEL[s.default_action]}</div>}
                      {selected !== s.student_id ? <button type="button" className="btn secondary small" onClick={() => setSelected(s.student_id)}>{ACTION_LABEL[s.action] || 'Resolve result'} · Edit</button> : <>
                      <Select placeholder="Resolve final result" aria-label={`Action for ${s.first_name} ${s.last_name}`} value={s.action || ''}
                        onChange={(action) => choose(s, { action, to_key: null })}
                        options={actionsFor().map((a) => ({ value: a, label: ACTION_LABEL[a] }))} />
                      <input aria-label={`Override reason for ${s.first_name}`} placeholder="Optional reason" maxLength={500} defaultValue={s.override_reason || ''} key={`${s.student_id}-${s.override_reason || ""}`} onBlur={(e) => { if (s.action && e.target.value !== (s.override_reason || "")) choose(s, { action: s.action, to_key: s.to_key, reason: e.target.value }); }} />
                      {s.overridden && s.default_action && <button type="button" className="btn link" onMouseDown={(e) => e.preventDefault()} onClick={() => { setSelected(null); choose(s, { reset: true }); }}>Reset to automatic decision</button>}
                      </>}
                    </td>
                    <td>
                      {s.action === 'PROMOTE' || s.action === 'REPEAT' ? (
                        <Select aria-label={`Class for ${s.first_name} ${s.last_name}`} value={s.to_key || ''}
                          onChange={(to_key) => choose(s, { action: s.action, to_key })}
                          options={options.map((d) => ({ value: d.key, label: `${d.name} ${d.year}${d.exists ? '' : ' (new)'}` }))} />
                      ) : (
                        <span className="hint">{s.action === 'GRADUATE' ? 'Stays on this class as a graduate' : s.action === 'LEAVE' ? 'Permanently left; history retained' : 'Final result must be resolved'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Promotion() {
  const { actor } = useAuth();
  const { online } = useSync();
  const schoolId = actor.schoolId;

  const [openYears, setOpenYears] = useState([]);
  const [year, setYear] = useState('');
  const [overrides, setOverrides] = useState({});
  const [plan, setPlan] = useState(null);
  const [runs, setRuns] = useState([]);
  const [teacherStrategy, setTeacherStrategy] = useState('FOLLOW'); // the API's default when a caller omits it (school-service strategyOf)
  const [excludedTeachers, setExcludedTeachers] = useState([]);
  const [stage, setStage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const pendingReset = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const requestKey = useRef(ulid()); // one per confirmed attempt: sending it again returns the same run

  // Years that can be closed: those with current classes. The earliest is the one to close first.
  useEffect(() => {
    if (!online) return;
    Promise.all([
      gql(LIST_SCHOOL_CLASSES, { school_id: schoolId }),
      gql(LIST_PROMOTION_RUNS, { school_id: schoolId }),
    ]).then(([{ listSchoolClasses }, { listPromotionRuns }]) => {
      const open = [...new Set(listSchoolClasses.filter((c) => c.status === 'CURRENT' && c.year).map((c) => c.year))].sort((a, b) => a - b);
      setOpenYears(open);
      setRuns(listPromotionRuns);
      setYear((y) => y || String(open[0] ?? ''));
    }).catch((e) => setError(e.message));
  }, [schoolId, online]);

  // Years with current classes, plus years already promoted (so their run can be looked at or undone).
  const years = useMemo(() => [...new Set([
    ...openYears,
    ...runs.filter((r) => r.status !== 'REVERTED').map((r) => r.from_year),
    ...(year ? [Number(year)] : []),
  ])].sort((a, b) => a - b), [openYears, runs, year]);

  const overrideList = useMemo(() => Object.entries(overrides).map(([student_id, o]) => ({ student_id, ...o })), [overrides]);

  const load = useCallback(async () => {
    if (!year) return;
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const { planPromotion } = await gql(PLAN_PROMOTION, { school_id: schoolId, from_year: Number(year), overrides: overrideList, teacher_strategy: teacherStrategy, excluded_teachers: excludedTeachers });
      if (seq === sequence.current) {
        setPlan(planPromotion); setError(null);
        const reset = pendingReset.current;
        if (reset && !overrideList.some((o) => o.student_id === reset.student_id)) {
          const row = planPromotion.classes.flatMap((c) => c.students).find((s) => s.student_id === reset.student_id);
          if (row && !row.overridden && row.default_action) setNotice(`${row.first_name} ${row.last_name}: reset to automatic decision — ${ACTION_LABEL[row.default_action]}${row.to_class_name ? ` → ${row.to_class_name}` : ''}. The override and its reason were removed.`);
          pendingReset.current = null;
        }
      }
    } finally { if (seq === sequence.current) setLoading(false); }
  }, [schoolId, year, overrideList, teacherStrategy, excludedTeachers]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  function choose(student, o) {
    pendingReset.current = o.reset ? { student_id: student.student_id } : null;
    setNotice(null);
    setLoading(true);
    setOverrides((prev) => {
      const next = { ...prev };
      if (o.reset) delete next[student.student_id];
      else next[student.student_id] = { ...prev[student.student_id], action: o.action, ...(o.to_key ? { to_key: o.to_key } : { to_key: null }), ...(o.reason !== undefined ? { reason: o.reason } : {}) };
      return next;
    });
  }

  async function promote() {
    const s = plan.summary;
    const ok = window.confirm(
      `Close ${plan.from_year}?\n\n` +
      `${s.promote} move up, ${s.repeat} repeat, ${s.graduate} graduate, ${s.leave} recorded as left.\n` +
      `${s.classes_created} classes will be created for ${plan.to_year} and ${s.classes_archived} classes of ${plan.from_year} archived.\n\n` +
      'You can undo this until the new classes have records.'
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const { applyPromotion } = await gql(APPLY_PROMOTION, {
        input: { school_id: schoolId, from_year: plan.from_year, overrides: overrideList, teacher_strategy: teacherStrategy, excluded_teachers: excludedTeachers, review_token: plan.review_token, idempotency_key: requestKey.current },
      });
      requestKey.current = ulid();
      setOverrides({});
      setNotice(`${applyPromotion.from_year} is closed. The ${applyPromotion.to_year} classes are ready.`);
      await repository.loadClasses(schoolId); // keep this device's class list in step
      setRuns((r) => [applyPromotion, ...r.filter((x) => x.run_id !== applyPromotion.run_id)]);
      setOpenYears((ys) => [...new Set([...ys.filter((y) => y !== applyPromotion.from_year), applyPromotion.to_year])]);
      await load();
    } catch (e) {
      await load().catch(() => {});
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function undo(run) {
    if (!window.confirm(`Undo the promotion of ${run.from_year}? Students go back to their ${run.from_year} classes, and the classes it created are removed.`)) return;
    setBusy(true);
    setError(null);
    try {
      const { revertPromotion } = await gql(REVERT_PROMOTION, { input: { school_id: schoolId, run_id: run.run_id } });
      setNotice(`The promotion of ${revertPromotion.from_year} was undone.`);
      setRuns((r) => r.map((x) => (x.run_id === revertPromotion.run_id ? revertPromotion : x)));
      setYear(String(revertPromotion.from_year));
      setOpenYears((ys) => [...new Set([...ys, revertPromotion.from_year])]);
      await repository.loadClasses(schoolId);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!online) return <Offline what="Closing the school year" />;

  const blocked = plan?.blockers.length > 0;
  const earlier = runs.filter((r) => r.run_id !== plan?.run?.run_id);

  return (
    <div className="stack">
      <div className="page-head">
        <Link to="/settings/classes">Back to settings</Link>
        <h1>Close the school year</h1>
        <Field label="Year to close" htmlFor="promo-year">
          <Select id="promo-year" value={year} onChange={(v) => { setYear(v); setOverrides({}); setPlan(null); setStage(1); setSearch(''); }}
            options={years.map((y) => ({ value: String(y), label: String(y) }))} placeholder="Choose a year" />
        </Field>
      </div>

      <div className="hint">
        Proposed actions use published Term 3 final overall averages and the school pass mark.
        Results, report cards and risk history stay with their original classes. Missing or incomplete final results must be resolved before confirmation.
        Progression paths are configured in <Link to="/settings/classes">Settings, Classes</Link>.
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <div role="status" aria-live="polite"><Notice tone="success">{notice}</Notice></div>}
      {!year && years.length === 0 && <Notice>There are no current classes, so there is no year to close.</Notice>}

      {plan?.run && <RunCard run={plan.run} busy={busy} onUndo={() => undo(plan.run)} />}

      {plan && !plan.run && (
        <>
          {blocked && (
            <Notice tone="warn">
              <b>Fix these before {plan.from_year} can be closed:</b>
              <ul>
                {plan.blockers.map((b, i) => (
                  <li key={`${b.code}${b.class_id}${i}`}>
                    {b.message}
                    {b.code === 'UNPUBLISHED' && <> <Link to="/results">Open Results</Link></>}
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          <nav className="weights-row" aria-label="Rollover stages">
            {['Readiness and progression', 'Review exceptions', 'Teacher assignments', 'Review and confirm'].map((label, i) => <button type="button" className={`btn ${stage === i + 1 ? '' : 'secondary'}`} aria-current={stage === i + 1 ? 'step' : undefined} key={label} onClick={() => setStage(i + 1)}>{i + 1}. {label}</button>)}
          </nav>
          {loading && <Notice>Updating the server preview…</Notice>}
          {stage === 1 && <div className="card stack">
            <h2>Readiness and class progression</h2>
            <div className="table-wrap"><table><thead><tr><th>Current class</th><th>Default destination</th><th>Promote / repeat / graduate</th><th>Term 3 final results</th><th>Blockers</th></tr></thead><tbody>
              {plan.classes.map((c) => <tr key={c.source_class_id}><td>{c.source_name}</td><td>{c.destination ? `${c.destination.name} ${plan.to_year}` : c.graduating ? 'Graduate if passing' : 'Unknown'}</td><td>{c.publication_status === 'PUBLISHED' ? ['PROMOTE', 'REPEAT', 'GRADUATE'].map((a) => c.students.filter((s) => s.action === a).length).join(' / ') : 'Awaiting publication'}</td><td>{c.publication_status === 'PUBLISHED' ? 'Published' : 'Not published'}</td><td>{plan.blockers.filter((b) => b.class_id === c.source_class_id).map((b) => b.message).join(' ') || 'None'}</td></tr>)}
            </tbody></table></div>
          </div>}
          {stage === 2 && <div className="stack">
            <h2>Review exceptions</h2>
            <Notice>Students below the pass mark are proposed to repeat, including those in the final form. You can override any valid decision.</Notice>
            <input type="search" aria-label="Find any student" placeholder="Find any student by name or admission number" value={search} onChange={(e) => setSearch(e.target.value)} />
            {plan.classes.map((c) => <ClassPlan key={c.source_class_id} c={c} choices={plan.choices} choose={choose} search={search} />)}
          </div>}
          {stage === 3 && <div className="card stack">
            <h2>Teacher assignments</h2>
            <Select aria-label="Teacher assignment strategy" value={teacherStrategy} onChange={(v) => { setLoading(true); setTeacherStrategy(v); setExcludedTeachers([]); }} options={[
              { value: 'STAY', label: 'Stay with the form — same form and stream, incoming cohort' },
              { value: 'FOLLOW', label: 'Follow the students — destination classes of existing cohorts' },
              { value: 'MANUAL', label: 'Assign manually — no teaching assignments carried forward' },
            ]} />
            <p className="hint">Subject assignments follow each destination, including repeaters. A class teacher follows the progressing cohort, or the repeat cohort if no students progress. Historical teaching access is preserved. Exclude a conflicting teacher to arrange their new assignments manually, or <Link to="/teachers">edit teachers</Link> and refresh.</p>
            {plan.teacher_preview.map((t) => <div key={t.teacher_id} className="card"><b>{t.name}</b><p>{t.description}</p>{t.conflicts.map((c) => <p className="warn" key={c}>{c}</p>)}{teacherStrategy !== 'MANUAL' && <label><input type="checkbox" checked={excludedTeachers.includes(t.teacher_id)} onChange={(e) => setExcludedTeachers((ids) => e.target.checked ? [...ids, t.teacher_id] : ids.filter((id) => id !== t.teacher_id))} /> Assign this teacher manually</label>}</div>)}
            {plan.teacher_warnings.length > 0 && <Notice tone="warn"><b>Manual setup required after rollover</b><ul>{plan.teacher_warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice>}
            <button type="button" className="btn secondary" disabled={loading} onClick={() => load().catch((e) => setError(e.message))}>Refresh assignments</button>
          </div>}
          {stage === 4 && <div className="card stack">
            <h2>Review and confirm: {plan.from_year} → {plan.to_year}</h2>
            <button type="button" className="btn secondary" disabled={loading} onClick={() => load().catch((e) => setError(e.message))}>Refresh latest decisions</button>
            <Summary s={plan.summary} />
            <p>Teacher strategy: {teacherStrategy === 'STAY' ? 'Stay with the form' : teacherStrategy === 'FOLLOW' ? 'Follow the students' : 'Assign manually'}.</p>
            {plan.teacher_preview.filter((t) => !t.excluded).map((t) => <p key={t.teacher_id}><b>{t.name}:</b> {t.description}</p>)}
            {plan.teacher_warnings.length > 0 && <Notice tone="warn">{plan.teacher_warnings.join(' ')}</Notice>}
            <p>Creating: {plan.choices.filter((d) => !d.exists && (plan.classes.some((c) => c.students.some((s) => s.to_key === d.key)) || teacherStrategy === 'STAY' && plan.classes.some((c) => c.repeat_destination?.key === d.key))).map((d) => `${d.name} ${d.year}`).join(', ') || 'None'}.</p>
            <p>Archiving: {plan.classes.map((c) => c.source_name).join(', ')}.</p>
            <h3>Overrides</h3>
            {plan.classes.flatMap((c) => c.students.filter((s) => s.overridden).map((s) => <p key={s.student_id}><b>{s.first_name} {s.last_name}</b> ({c.source_name}): {ACTION_LABEL[s.default_action] || 'Unresolved'} → {ACTION_LABEL[s.action]} · {s.to_class_name || 'No destination'}{s.override_reason ? ` · ${s.override_reason}` : ''}</p>))}
            <p className="hint">Ongoing interventions stop at year end. Published assessments, results, report cards and risk predictions remain unchanged. Unassigned teachers can be configured on the Teachers page.</p>
            <button type="button" className="btn" disabled={busy || loading || Boolean(error) || blocked || !plan.classes.length} onClick={promote}>{busy ? 'Applying…' : `Confirm rollover to ${plan.to_year}`}</button>
          </div>}
          <div className="weights-row">
            {stage > 1 && <button type="button" className="btn secondary" onClick={() => setStage(stage - 1)}>Back</button>}
            {stage < 4 && <button type="button" className="btn" onClick={() => setStage(stage + 1)}>Continue</button>}
            {Object.keys(overrides).length > 0 && <button type="button" className="btn secondary" disabled={busy} onClick={() => setOverrides({})}>Reset overrides</button>}
          </div>
        </>
      )}

      {earlier.length > 0 && (
        <details className="more">
          <summary>Earlier promotions</summary>
          <div className="stack">
            {earlier.map((r) => <RunCard key={r.run_id} run={r} busy={busy} onUndo={() => undo(r)} />)}
          </div>
        </details>
      )}
    </div>
  );
}
