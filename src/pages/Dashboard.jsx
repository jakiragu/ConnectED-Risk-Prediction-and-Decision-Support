import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { targetText } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { ActionIcon, Checkbox, Sparkline } from '../components/ui.jsx';
import InterventionsPanel from '../components/InterventionsPanel.jsx';
import { Skeleton } from '../components/insights.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { classLabels } from '../classLabels.js';

const pct = (p) => `${Math.round(p * 100)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

/**
 * Where a teacher starts: their classes, the students the model flags, the
 * interventions under way and the papers still to be marked. A subject teacher
 * sees their own subjects' targets and interventions; the class teacher and
 * administrators see every subject and attendance. Flags are decision-support
 * signals from the risk model, not judgements about students.
 */
/** The Trend column: this year's estimates as a sparkline, and how the latest moved from the one before. */
function TrendCell({ points }) {
  if (!points?.length) return <span className="hint">—</span>;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const change = prev ? Math.round((last.probability - prev.probability) * 100) : null;
  return (
    <div className="trend-cell">
      <Sparkline points={points} width={96} height={28} />
      <span className="hint" title={prev ? `Since ${prev.label}` : undefined}>
        {change == null ? 'First estimate' : change === 0 ? 'No change' : `${change > 0 ? '↑' : '↓'} ${Math.abs(change)} pts`}
      </span>
    </div>
  );
}

export default function Dashboard() {
  const { actor, isAdmin, displayName } = useAuth();
  const { online } = useSync();
  const [view, setView] = useState({ data: null, savedAt: null, fromDevice: false });
  const [loading, setLoading] = useState(true);
  const [riskQuery, setRiskQuery] = useState('');
  const [expandedStudent, setExpandedStudent] = useState(null);
  // Flagged students ticked for one intervention; kept across search and pages.
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [riskPage, setRiskPage] = useState(1);
  const RISK_PAGE_SIZE = 10;
  const classes = useLive(() => db().classes.toArray(), [], []);
  const students = useLive(() => db().students.toArray(), [], []);
  const navigate = useNavigate();

  // The copy kept on this device is shown at once; the server's answer replaces it when it arrives.
  useEffect(() => {
    let live = true;
    setLoading(true);
    repository.loadDashboard(actor.schoolId, { onCached: (v) => live && setView((cur) => (cur.data ? cur : v)) })
      .then((v) => live && (v.data || !online) && setView(v))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [actor.schoolId, online]);

  // Rosters for "Find a student" are fetched only when the teacher starts a search,
  // all classes at once, so they no longer compete with the dashboard as it loads.
  const [rosters, setRosters] = useState('idle'); // idle | loading | ready
  const loadRosters = () => {
    if (rosters !== 'idle') return;
    setRosters('loading');
    repository.loadRosters(actor.schoolId).catch(() => {}).finally(() => setRosters('ready'));
  };

  const className = useMemo(() => classLabels(classes), [classes]);
  const classById = useMemo(() => new Map(classes.map((c) => [c.class_id, c])), [classes]);
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return students
      .filter((s) => `${s.first_name} ${s.last_name} ${s.admission_no}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, students]);

  const d = view.data;

  const flaggedStudents = useMemo(() => {
    const q = riskQuery.trim().toLowerCase();

    return (d?.at_risk_students || []).filter((c) => {
      const s = c.student;
      const searchable = [
        s.first_name,
        s.last_name,
        s.admission_no,
        s.class_name,
      ].join(' ').toLowerCase();

      return searchable.includes(q);
    });
  }, [d, riskQuery]);
  const riskPageCount = Math.ceil(flaggedStudents.length / RISK_PAGE_SIZE);
  const paginatedStudents = flaggedStudents.slice(
    (riskPage - 1) * RISK_PAGE_SIZE,
    riskPage * RISK_PAGE_SIZE
  );

  useEffect(() => {
    setRiskPage((page) => Math.min(page, Math.max(1, riskPageCount)));
  }, [riskPageCount]);

  useEffect(() => {
    setRiskPage(1);
  }, [riskQuery]);

  // Only students still flagged count, in the order the table lists them.
  const pickedStudents = useMemo(
    () => (d?.at_risk_students || []).filter((c) => picked.has(c.student.student_id)),
    [d, picked]
  );
  const pageIds = paginatedStudents.map((c) => c.student.student_id);
  const pagePicked = pageIds.filter((id) => picked.has(id)).length;
  const hiddenPicked = pickedStudents.filter((c) => !pageIds.includes(c.student.student_id)).length;
  const pickedClasses = new Set(pickedStudents.map((c) => c.student.class_id)).size;
  const togglePick = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickPage = (on) => setPicked((prev) => {
    const next = new Set(prev);
    for (const id of pageIds) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const logForPicked = () => navigate(
    `/interventions/new?students=${pickedStudents.map((c) => c.student.student_id).join(',')}`,
    { state: { from: '/dashboard' } }
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Hello, {displayName}</h1>
        {d?.term_name && <span className="hint">{d.term_name}</span>}
      </div>
      {view.fromDevice && !view.refreshing && <div className="notice">You are offline. This is the copy saved on this device at {when(view.savedAt)}.</div>}
      {!d && !loading && <div className="notice">The dashboard could not be loaded, and there is no saved copy on this device yet.</div>}
      {!d && loading && <Skeleton tiles={3} lines={6} label="Loading the dashboard" />}

      <div className="dash-top">
        {d && (
          <div className="stats">
            <div className="stat"><b>{d.classes}</b><span>{d.classes === 1 ? 'class' : 'classes'}</span></div>
            <div className="stat"><b>{d.at_risk}<small>/{d.students}</small></b><span>students flagged at risk</span></div>
            <div className="stat"><b>{d.pending_assessments.length}</b><span>papers still being marked</span></div>
          </div>
        )}
        <div className="card stack find">
          <label htmlFor="find-student"><b>Find a student</b></label>
          <input id="find-student" type="search" placeholder="Name or admission number" value={query}
            onFocus={loadRosters} onChange={(e) => { loadRosters(); setQuery(e.target.value); }} />
          {found.length > 0 && (
            <ul className="found" aria-label="Matching students">
              {found.map((s) => {
                const klass = classById.get(s.class_id);
                // Logging needs a role in the student's class: administrator, class teacher, or a subject taught there.
                const canLog = isAdmin || klass?.is_class_teacher === true || (klass?.my_subjects?.length ?? 0) > 0;
                return (
                  <li key={s.student_id}>
                    <div className="found-who">
                      <b>{s.first_name} {s.last_name}</b>
                      <span className="hint">{[s.admission_no, className.get(s.class_id)].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="found-actions">
                      <Link className="btn link student-quick-action" title="Risk profile" aria-label={`Risk profile for ${s.first_name} ${s.last_name}`} to={`/students/${s.student_id}/risk`} state={{ from: '/dashboard' }}><ActionIcon name="users" /></Link>
                      {canLog && (
                        <Link className="btn link student-quick-action" title="Log intervention" aria-label={`Log intervention for ${s.first_name} ${s.last_name}`} to={`/students/${s.student_id}/interventions`} state={{ from: '/dashboard' }}><ActionIcon name="clipboard" /></Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {query.trim().length >= 2 && !found.length && (
            <span className="hint" role="status">{rosters === 'loading' ? 'Looking through your classes…' : 'No student in your classes matches.'}</span>
          )}
        </div>
      </div>

      {d && (
        <>
          {!isAdmin && (
            <InterventionsPanel items={d.ongoing_interventions || []} viewerIsClassTeacher={Boolean(d.viewer_is_class_teacher)} />
          )}

          <section className="stack">
            <div className="row">
              <h2 className="grow">Students flagged at risk</h2>
              <span className="hint">
                {flaggedStudents.length} of {d.at_risk_students.length} students
              </span>
            </div>

            <input type="search" aria-label="Search flagged students" placeholder="Search by student name, admission number or class" value={riskQuery}
              onChange={(e) => {
                setRiskQuery(e.target.value);
                setExpandedStudent(null);
              }}
            />

            {d.at_risk_students.length === 0 ? (
              <div className="hint">
                The model flags none of your students at their latest checkpoint.
              </div>
            ) : flaggedStudents.length === 0 ? (
              <div className="hint">No flagged students match your search.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="pick">
                        <Checkbox label="Select every student on this page" checked={pageIds.length > 0 && pagePicked === pageIds.length}
                          indeterminate={pagePicked > 0} onChange={pickPage} />
                      </th>
                      <th>Student</th>
                      <th>Class</th>
                      <th>Estimated risk</th>
                      <th>Checkpoint</th>
                      <th>Trend</th>
                    </tr>
                  </thead>

                  <tbody>
                    {paginatedStudents.map((c) => {
                      const id = c.student.student_id;
                      const isOpen = expandedStudent === id;

                      const isPicked = picked.has(id);

                      return (
                        <Fragment key={id}>
                          <tr className={`risk-student-row${isOpen ? ' open' : ''}${isPicked ? ' selected' : ''}`}
                            onClick={() => setExpandedStudent(isOpen ? null : id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setExpandedStudent(isOpen ? null : id);
                              }
                            }}
                            tabIndex={0} aria-expanded={isOpen}
                          >
                            {/* Ticking a student must not open or close their details. */}
                            <td className="pick" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                              <Checkbox label={`Select ${c.student.first_name} ${c.student.last_name}`} checked={isPicked}
                                onChange={() => togglePick(id)} />
                            </td>
                            <td>
                              <b>{c.student.first_name} {c.student.last_name}</b>
                              <div className="hint">{c.student.admission_no}</div>
                            </td>
                            <td>{c.student.class_name}</td>
                            <td>
                              <b className="risk">{pct(c.latest.probability)}</b>
                            </td>
                            <td>{c.latest.label}</td>
                            <td><TrendCell points={c.trend} /></td>
                          </tr>

                          {isOpen && (
                            <tr className="risk-detail-row">
                              <td colSpan={6}>
                                <div className="risk-student-details">
                                  <div className="stack">
                                    <h3 className="sub">Targets</h3>

                                    {c.targets.length > 0 ? (
                                      <>
                                        {c.partial && (
                                          <span className="hint">
                                            Showing targets for the subjects you teach.
                                          </span>
                                        )}
                                        <div className="chips">
                                          {c.targets.map((t) => (
                                            <span key={t.column} className="chip target">
                                              {targetText(t)}
                                            </span>
                                          ))}
                                        </div>
                                      </>
                                    ) : (
                                      <span className="hint">
                                        {c.latest.targets_status === 'MAINTAIN'
                                          ? 'Keep current results.'
                                          : 'No targets available for your subjects.'}
                                      </span>
                                    )}
                                  </div>

                                  <div className="stack">
                                    <h3 className="sub">Ongoing interventions</h3>

                                    {c.interventions.length > 0 ? (
                                      <ul className="plain">
                                        {c.interventions.map((method, i) => (
                                          <li key={`${method}-${i}`}>{method}</li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <span className="hint">
                                        No ongoing interventions recorded.
                                      </span>
                                    )}
                                  </div>

                                  <div className="actions">
                                    <button
                                      type="button"
                                      className="btn secondary"
                                      onClick={() => navigate(
                                        `/students/${id}/risk`,
                                        { state: { from: '/dashboard' } }
                                      )}
                                    >
                                      View risk profile
                                    </button>

                                    <button
                                      type="button"
                                      className="btn"
                                      onClick={() => navigate(
                                        `/students/${id}/interventions`,
                                        { state: { from: '/dashboard' } }
                                      )}
                                    >
                                      Log or update interventions
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {riskPageCount > 1 && (
                  <div className="row wrap between risk-pagination">
                    <span className="hint">
                      Showing {(riskPage - 1) * RISK_PAGE_SIZE + 1}–
                      {Math.min(riskPage * RISK_PAGE_SIZE, flaggedStudents.length)}
                      {' '}of {flaggedStudents.length} students
                    </span>

                    <div className="row">
                      <button type="button" className="btn secondary" disabled={riskPage === 1}
                        onClick={() => setRiskPage((page) => page - 1)}
                      >
                        Previous
                      </button>

                      <span className="hint">
                        Page {riskPage} of {riskPageCount}
                      </span>

                      <button type="button" className="btn secondary" disabled={riskPage === riskPageCount}
                        onClick={() => setRiskPage((page) => page + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {pickedStudents.length > 0 && (
              <div className="action-bar" role="region" aria-label="Selected students">
                <span className="count">{pickedStudents.length} {pickedStudents.length === 1 ? 'student' : 'students'} selected</span>
                <span className="why">
                  {pickedClasses > 1 ? `from ${pickedClasses} classes` : ''}
                  {hiddenPicked > 0 ? `${pickedClasses > 1 ? ', ' : ''}${hiddenPicked} not shown on this page` : ''}
                </span>
                <span className="grow" />
                <button type="button" className="btn secondary" onClick={() => setPicked(new Set())}>Clear selection</button>
                <button type="button" className="btn" onClick={logForPicked}>
                  Log an intervention for {pickedStudents.length === 1 ? 'this student' : `these ${pickedStudents.length}`}
                </button>
              </div>
            )}
          </section>

          <section className="stack">
            <h2>Papers still being marked</h2>
            {d.pending_assessments.length === 0 && <div className="hint">Nothing waiting for marks this term.</div>}
            <div className="cards">
              {d.pending_assessments.map((a) => (
                <div key={a.assessment_id} className="card">
                  <b>{a.class_name} {a.title}</b>
                  <div>Status: <span className={`pill ${a.status.toLowerCase()}`}>{a.status === 'UNRECORDED' ? 'Not started' : 'Being recorded'}</span></div>
                  <div>Missing marks: <b>{a.missing}</b></div>
                  <Link to={`/assessments/${a.assessment_id}/scores`}>Enter marks</Link>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
