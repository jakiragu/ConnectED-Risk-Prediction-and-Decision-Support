import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { CREATE_STUDENT, LIST_STUDENTS, SET_STUDENT_STATUS, TRANSFER_STUDENT, UPDATE_STUDENT } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { DangerButton, ActionIcon } from '../components/ui.jsx';
import { loadStudentRisk } from '../api/studentRisk.js';
import { classLabel, isCurrent, sortClasses } from '../classLabels.js';
import { displayPhone } from '@gradebook/domain/student';

const statusText = (s) => (s.status === 'ACTIVE' ? 'Active'
  : s.status === 'GRADUATED' ? `Graduated${s.graduation_year ? ` ${s.graduation_year}` : ''}`
  : s.departure_kind === 'TEMPORARY' ? 'Temporarily deactivated' : s.left_year ? `Left ${s.left_year}` : 'Deactivated');

const EMPTY = { first_name: '', last_name: '', admission_no: '', guardian_name: '', guardian_phone: '' };

/** The edit row's starting values: the phone as people write it locally. */
const draftOf = (s) => ({
  first_name: s.first_name,
  last_name: s.last_name,
  admission_no: s.admission_no,
  guardian_name: s.guardian_name || '',
  guardian_phone: displayPhone(s.guardian_phone),
  results_sms: s.results_sms !== false,
});

export default function Students() {
  const { classId } = useParams();
  const [params, setParams] = useSearchParams();
  const { actor, isAdmin } = useAuth();
  const { online } = useSync();
  const classes = useLive(() => db().classes.toArray(), [], []);
  const klass = classes.find((c) => c.class_id === classId);
  const canManage = isAdmin || Boolean(klass?.is_class_teacher);

  const [students, setStudents] = useState([]);
  const [risks, setRisks] = useState(new Map());
  const [riskError, setRiskError] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const canReadRisk = isAdmin || Boolean(klass?.is_class_teacher);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [transfer, setTransfer] = useState({});
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [departure, setDeparture] = useState(null);

  useEffect(() => {
    repository.loadClasses(actor.schoolId).catch(() => {});
  }, [actor.schoolId]);

  const load = useCallback(async () => {
    const { listStudents } = await gql(LIST_STUDENTS, { school_id: actor.schoolId, class_id: classId, include_inactive: true });
    setStudents(listStudents);
  }, [actor.schoolId, classId]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  // ?edit=<student_id> (the Add link on Report cards) opens that student's row for editing.
  const editParam = params.get('edit');
  useEffect(() => {
    if (!editParam || !students.length) return;
    const s = students.find((x) => x.student_id === editParam);
    if (s && s.status !== 'GRADUATED') {
      setEditing(s.student_id);
      setDraft(draftOf(s));
      setTimeout(() => document.getElementById(`guardian-phone-${s.student_id}`)?.focus(), 0);
    }
    setParams((p) => { p.delete('edit'); return p; }, { replace: true });
  }, [editParam, students, setParams]);

  // Risk is optional enrichment: a denied or failed request never hides the roster.
  useEffect(() => {
    let live = true;
    setRisks(new Map());
    setRiskError(null);
    setRiskLoading(online && canReadRisk);
    if (online && canReadRisk) {
      loadStudentRisk({ request: gql, schoolId: actor.schoolId, classId,
        academicYear: klass?.year, allowed: canReadRisk })
        .then((value) => { if (live) setRisks(value); })
        .catch(() => { if (live) setRiskError('Risk estimates could not be loaded. Student records are still available.'); })
        .finally(() => { if (live) setRiskLoading(false); });
    }
    return () => { live = false; };
  }, [online, canReadRisk, actor.schoolId, classId, klass?.year]);

  async function run(mutation, input, done) {
    setError(null);
    setNotice(null);
    try {
      await gql(mutation, { input: { school_id: actor.schoolId, ...input } });
      setNotice(done);
      setEditing(null);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      await load().catch(() => {});
    }
  }

  async function add(e) {
    e.preventDefault();
    if (await run(CREATE_STUDENT, { class_id: classId, ...form }, `${form.first_name} ${form.last_name} added`)) setForm(EMPTY);
  }

  const shown = students.filter((s) => showInactive || (klass && !isCurrent(klass)) || s.status === 'ACTIVE');
  const inactive = students.filter((s) => s.status !== 'ACTIVE').length;
  const destinations = sortClasses(classes.filter((c) => c.class_id !== classId && isCurrent(c)));
  const archived = klass && !isCurrent(klass);

  if (!online) return <div className="notice">Managing students needs a connection.</div>;

  return (
    <>
      <div className="page-head">
        <h1>{klass ? classLabel(klass, classes) : 'Class'}</h1>
        <span className="hint">{students.length - inactive} active{inactive ? `, ${inactive} not active` : ''}</span>
      </div>
      <nav className="tabs" aria-label="Class pages">
        <Link to={`/classes/${classId}`}>Overview</Link>
        <Link to={`/classes/${classId}/students`} aria-current="page">{canManage ? 'Manage students' : 'Students'}</Link>
        <Link to={`/assessments?class=${classId}`}>Assessments</Link>
      </nav>
      {archived && (
        <div className="notice">
          This class is archived{klass.year ? ` (${klass.year})` : ''}. Its students' results, report cards and risk history stay here, read-only.
          {klass.promoted_to_class_id && ' Its students moved up when the school year was closed.'}
        </div>
      )}
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      {riskError && <div className="notice">{riskError}</div>}
      {departure && <form className="card stack" onSubmit={async (e) => { e.preventDefault(); const { student, ...details } = departure; if (await run(SET_STUDENT_STATUS, { student_id: student.student_id, status: 'INACTIVE', _version: student._version, ...details }, 'Student status recorded')) setDeparture(null); }}>
        <h2>Deactivate {departure.student.first_name} {departure.student.last_name}</h2>
        <Field label="Departure type"><Select value={departure.departure_kind} onChange={(departure_kind) => setDeparture({ ...departure, departure_kind })} options={[{ value: 'TEMPORARY', label: 'Temporarily deactivated' }, { value: 'LEFT', label: 'Permanently left the school' }]} /></Field>
        <Field label="Reason"><input required maxLength={500} value={departure.deactivation_reason} onChange={(e) => setDeparture({ ...departure, deactivation_reason: e.target.value })} /></Field>
        <Field label="Effective date"><input required type="date" value={departure.deactivation_date} onChange={(e) => setDeparture({ ...departure, deactivation_date: e.target.value })} /></Field>
        <div className="weights-row"><button className="btn" type="submit">Confirm deactivation</button><button className="btn secondary" type="button" onClick={() => setDeparture(null)}>Cancel</button></div>
      </form>}
      {!canManage && <div className="notice">Only the class teacher or an administrator can change this list.</div>}

      {canManage && klass?.status === 'CURRENT' && (
        <form className="card stack" onSubmit={add}>
          <h2>Add a student</h2>
          <div className="weights-row">
            <Field label="First name" htmlFor="s-first">
              <input id="s-first" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
            </Field>
            <Field label="Last name" htmlFor="s-last">
              <input id="s-last" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
            </Field>
            <Field label="Admission no" htmlFor="s-adm">
              <input id="s-adm" value={form.admission_no} onChange={(e) => setForm({ ...form, admission_no: e.target.value })} required />
            </Field>
            <Field label="Parent or guardian" htmlFor="s-guardian">
              <input id="s-guardian" value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} />
            </Field>
            <Field label="Guardian phone" htmlFor="s-phone">
              <input id="s-phone" type="tel" inputMode="tel" placeholder="0712 345 678" value={form.guardian_phone}
                onChange={(e) => setForm({ ...form, guardian_phone: e.target.value })} />
            </Field>
            <button className="btn" type="submit">Add student</button>
          </div>
        </form>
      )}

      <label className="choice-inline">
        <input type="checkbox" checked={showInactive || archived} disabled={archived} onChange={(e) => setShowInactive(e.target.checked)} /> Show graduated, left and deactivated students
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Admission no</th><th>First name</th><th>Last name</th><th>Status</th>{canManage && <th>Parent or guardian</th>}<th>Risk</th>{canManage && <th>Action</th>}</tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr className="empty"><td colSpan={canManage ? 7 : 5}>No students.</td></tr>}
            {shown.map((s) =>
              editing === s.student_id ? (
                <tr key={s.student_id} className="row-dirty">
                  <td><input aria-label="Admission no" value={draft.admission_no} onChange={(e) => setDraft({ ...draft, admission_no: e.target.value })} /></td>
                  <td><input aria-label="First name" value={draft.first_name} onChange={(e) => setDraft({ ...draft, first_name: e.target.value })} /></td>
                  <td><input aria-label="Last name" value={draft.last_name} onChange={(e) => setDraft({ ...draft, last_name: e.target.value })} /></td>
                  <td />
                  <td className="guardian-edit">
                    <input aria-label="Parent or guardian name" placeholder="Name" value={draft.guardian_name}
                      onChange={(e) => setDraft({ ...draft, guardian_name: e.target.value })} />
                    <input id={`guardian-phone-${s.student_id}`} aria-label="Guardian phone" type="tel" inputMode="tel" placeholder="0712 345 678"
                      value={draft.guardian_phone} onChange={(e) => setDraft({ ...draft, guardian_phone: e.target.value })} />
                    <label className="choice-inline">
                      <input type="checkbox" checked={draft.results_sms} onChange={(e) => setDraft({ ...draft, results_sms: e.target.checked })} /> Results by SMS
                    </label>
                  </td>
                  <td />
                  <td className="actions">
                    <button type="button" className="btn link" aria-label="Save student changes" title="Save"
                      onClick={() => run(
                        UPDATE_STUDENT,
                        { student_id: s.student_id, ...draft, _version: s._version },
                        'Saved'
                      )}
                    >
                      <ActionIcon name="check" />
                    </button>

                    <button type="button" className="btn link" aria-label="Cancel student editing" title="Cancel"
                      onClick={() => setEditing(null)}
                    >
                      <ActionIcon name="x" />
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={s.student_id}>
                  <td>{s.admission_no}</td>
                  <td>{s.first_name}</td>
                  <td>{s.last_name}</td>
                  <td>{s.status === 'ACTIVE' ? 'Active' : <span className={s.status === 'GRADUATED' ? 'hint' : 'warn'}>{statusText(s)}</span>}</td>
                  {canManage && (
                    <td className="guardian-cell">
                      {s.guardian_name || s.guardian_phone ? (
                        <>
                          {s.guardian_name && <span>{s.guardian_name}</span>}
                          {s.guardian_phone && <span className="hint">{displayPhone(s.guardian_phone)}{s.results_sms === false ? ' · SMS off' : ''}</span>}
                        </>
                      ) : <span className="hint">None</span>}
                    </td>
                  )}
                  <td>
                    {canReadRisk && (risks.has(s.student_id) ? (
                      <div>
                        <b className={risks.get(s.student_id).at_risk ? 'risk' : 'good'}>
                          {Math.round(risks.get(s.student_id).probability * 100)}% · {risks.get(s.student_id).at_risk ? 'At risk' : 'Not flagged'}
                        </b>
                        <div className="hint">{risks.get(s.student_id).prediction_point} · {risks.get(s.student_id).academic_year}</div>
                      </div>
                    ) : <div className="hint">{riskLoading ? 'Loading risk…' : riskError ? 'Risk unavailable' : 'No prediction'}</div>)}
                    <Link to={`/students/${s.student_id}/risk`} state={{ from: `/classes/${classId}/students` }}>Risk profile</Link>
                  </td>
                  {canManage && s.status === 'GRADUATED' && <td className="hint">Read-only record</td>}
                  {canManage && s.status !== 'GRADUATED' && (
                    <td className="actions student-actions">
                    <div className="row-actions">
                      <button type="button" className="btn link" aria-label={`Edit ${s.first_name} ${s.last_name}`} title="Edit"
                        onClick={() => {
                          setEditing(s.student_id);
                          setDraft(draftOf(s));
                        }}
                      >
                        <ActionIcon name="edit" />
                      </button>
                      {s.status === 'ACTIVE' ? (
                        <DangerButton className="link" aria-label={`Deactivate ${s.first_name} ${s.last_name}`} title="Deactivate"
                          onClick={() => setDeparture({ student: s, departure_kind: 'TEMPORARY', deactivation_reason: '', deactivation_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }) })}
                        >
                          <ActionIcon name="archive" />
                        </DangerButton>
                      ) : !archived && (
                        <button type="button" className="btn link" aria-label={`Reactivate ${s.first_name} ${s.last_name}`} title="Reactivate"
                          onClick={() =>
                            run(
                              SET_STUDENT_STATUS,
                              { student_id: s.student_id, status: 'ACTIVE', _version: s._version },
                              'Student reactivated'
                            )
                          }
                        >
                          <ActionIcon name="restore" />
                        </button>
                      )}
                      {/* An admin can move a student who is active, or one who left from an archived class and came back. */}
                      {isAdmin && (s.status === 'ACTIVE' || archived) && (
                        <>
                          <Select className="move-class-select" aria-label="Move to class" value={transfer[s.student_id] || ''}
                            onChange={(v) => setTransfer({ ...transfer, [s.student_id]: v })}
                            options={destinations.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))} placeholder="Move to…" />
                          <button type="button" className="btn link" disabled={!transfer[s.student_id]}
                            onClick={() => window.confirm('Move this student? Marks already recorded stay with this class.')
                              && run(TRANSFER_STUDENT, { student_id: s.student_id, to_class_id: transfer[s.student_id], _version: s._version }, 'Student moved')}>
                            Move
                          </button>
                        </>
                      )}
                    </div>
                    </td>
                  )}
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}