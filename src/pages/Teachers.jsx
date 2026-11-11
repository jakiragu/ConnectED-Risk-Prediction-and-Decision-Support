import { useCallback, useEffect, useMemo, useState } from 'react';
import { SUBJECTS } from '@gradebook/domain/assessment';
import { gql } from '../api/graphql.js';
import {
  CREATE_TEACHER,
  DEACTIVATE_TEACHER,
  LIST_SCHOOL_CLASSES,
  LIST_TEACHERS,
  REACTIVATE_TEACHER,
  RESET_TEACHER_PASSWORD,
  SET_CLASS_TEACHER,
  SET_TEACHER_ASSIGNMENTS,
  UPDATE_TEACHER,
} from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, Select } from '../components/Field.jsx';
import { useSync } from '../offline/useSync.js';
import { DangerButton, ActionIcon } from '../components/ui.jsx';
import { classLabel, classLabels } from '../classLabels.js';

const ROLES = ['Teacher', 'Admin'];
const EMPTY = { first_name: '', last_name: '', email: '', role: 'Teacher' };
const fullName = (t) => `${t.first_name} ${t.last_name}`;

/**
 * After a teacher is added or their password reset. Normally the details were
 * emailed, so this confirms it and keeps the temporary password one click away
 * in case the email does not arrive. If it could not be sent, it says why and
 * shows the password to hand over, as before. It is shown only here, once.
 */
function Handover({ account, onClose }) {
  if (!account) return null;
  const { teacher, temporary_password: password, email } = account;
  const secret = <code className="secret">{password}</code>;
  return (
    <div className="notice handover" role="status">
      {email?.sent ? (
        <>
          <div>
            Sign-in details emailed to <b>{fullName(teacher)}</b> ({teacher.email}). They choose their own password the first time they log in.
          </div>
          <details className="handover-fallback">
            <summary>Email not arriving? Show the temporary password</summary>
            <div>Temporary password: {secret}</div>
            <div className="hint">It is not shown again.</div>
          </details>
        </>
      ) : (
        <>
          {email && <div className="warn">The email to {teacher.email} was not sent. {email.problem}</div>}
          <div>Give <b>{fullName(teacher)}</b> ({teacher.email}) this temporary password: {secret}</div>
          <div className="hint">They choose their own password the first time they log in. It is not shown again.</div>
        </>
      )}
      <button type="button" className="btn link" onClick={onClose}>Done</button>
    </div>
  );
}

function Manage({ teacher, classes, isSelf, run }) {
  const [details, setDetails] = useState({ first_name: teacher.first_name, last_name: teacher.last_name, role: teacher.role });
  const [assignments, setAssignments] = useState(teacher.assignments);
  const [add, setAdd] = useState({ class_id: '', subject: '' });
  const [classTeacherOf, setClassTeacherOf] = useState(teacher.class_teacher_of || '');

  useEffect(() => {
    setDetails({ first_name: teacher.first_name, last_name: teacher.last_name, role: teacher.role });
    setAssignments(teacher.assignments);
    setClassTeacherOf(teacher.class_teacher_of || '');
  }, [teacher]);

  const byId = useMemo(() => new Map(classes.map((c) => [c.class_id, c])), [classes]);
  const open = classes.filter((c) => c.status === 'CURRENT');
  const isTeacher = teacher.role === 'Teacher';
  const active = teacher.status === 'ACTIVE';
  const changedDetails =
    details.first_name !== teacher.first_name || details.last_name !== teacher.last_name || details.role !== teacher.role;
  const changedAssignments = JSON.stringify(assignments) !== JSON.stringify(teacher.assignments);
  // A class can have one class teacher; offer classes without one, and this teacher's own.
  const classTeacherOptions = open.filter((c) => !c.class_teacher_id || c.class_teacher_id === teacher.teacher_id);

  const ref = { school_id: teacher.school_id, teacher_id: teacher.teacher_id, _version: teacher._version };

  function addAssignment() {
    if (!add.class_id || !add.subject) return;
    if (assignments.some((a) => a.class_id === add.class_id && a.subject === add.subject)) return;
    setAssignments([...assignments, { class_id: add.class_id, subject: add.subject }]);
    setAdd({ class_id: add.class_id, subject: '' });
  }

  function saveClassTeacher() {
    const current = teacher.class_teacher_of;
    if (classTeacherOf === (current || '')) return;
    if (classTeacherOf) {
      const target = byId.get(classTeacherOf);
      run(SET_CLASS_TEACHER, { input: { school_id: teacher.school_id, class_id: target.class_id, teacher_id: teacher.teacher_id, _version: target._version } },
        `${fullName(teacher)} is now class teacher of ${target.name}`);
    } else {
      const was = byId.get(current);
      run(SET_CLASS_TEACHER, { input: { school_id: teacher.school_id, class_id: was.class_id, teacher_id: null, _version: was._version } },
        `${was.name} has no class teacher now`);
    }
  }

  return (
    <div className="card stack manage">
      <div className="weights-head">
        <h2>{fullName(teacher)}</h2>
        <span className="hint">{teacher.email} · {teacher.role} · {active ? 'Active' : 'Deactivated'}</span>
      </div>

      <h3>Details</h3>
      <div className="weights-row">
        <Field label="First name" htmlFor="m-first">
          <input id="m-first" value={details.first_name} onChange={(e) => setDetails({ ...details, first_name: e.target.value })} />
        </Field>
        <Field label="Last name" htmlFor="m-last">
          <input id="m-last" value={details.last_name} onChange={(e) => setDetails({ ...details, last_name: e.target.value })} />
        </Field>
        <Field label="Role" htmlFor="m-role" hint={isSelf ? 'You cannot change your own role' : undefined}>
          <Select id="m-role" value={details.role} onChange={(v) => setDetails({ ...details, role: v })} options={ROLES} disabled={isSelf} />
        </Field>
        <button type="button" className="btn" disabled={!changedDetails}
          onClick={() => run(UPDATE_TEACHER, { input: { ...ref, ...details } }, 'Details saved')}>
          Save details
        </button>
      </div>

      {isTeacher && (
        <>
          <h3>Teaches</h3>
          <div className="hint">Each row lets this teacher create papers and enter marks for that subject in that class.</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Class</th><th>Subject</th><th /></tr></thead>
              <tbody>
                {assignments.length === 0 && <tr className="empty"><td colSpan={3}>No subjects assigned yet.</td></tr>}
                {assignments.map((a) => (
                  <tr key={`${a.class_id}|${a.subject}`}>
                    <td>{byId.get(a.class_id)?.name || a.class_id}</td>
                    <td>{a.subject}</td>
                    <td className="actions">
                      <DangerButton className="link" aria-label={`Remove ${a.subject} assignment`} title="Remove assignment"
                        onClick={() => setAssignments(assignments.filter((x) => x !== a))}
                      >
                        <ActionIcon name="trash" />
                      </DangerButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="weights-row">
            <Select aria-label="Class" value={add.class_id} onChange={(v) => setAdd({ ...add, class_id: v })}
              options={open.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))} placeholder="Class" />
            <Select aria-label="Subject" value={add.subject} onChange={(v) => setAdd({ ...add, subject: v })}
              options={SUBJECTS} placeholder="Subject" />
            <button type="button" className="btn secondary" disabled={!add.class_id || !add.subject} onClick={addAssignment}>Add</button>
            <button type="button" className="btn" disabled={!changedAssignments || !active}
              onClick={() => run(SET_TEACHER_ASSIGNMENTS, { input: { ...ref, assignments } }, 'Assignments saved')}>
              Save assignments
            </button>
          </div>

          <h3>Class teacher</h3>
          <div className="weights-row">
            <Select aria-label="Class teacher of" value={classTeacherOf} onChange={setClassTeacherOf}
              options={[{ value: '', label: 'Not a class teacher' }, ...classTeacherOptions.map((c) => ({ value: c.class_id, label: classLabel(c, classes) }))]} />
            <button type="button" className="btn" disabled={classTeacherOf === (teacher.class_teacher_of || '') || !active}
              onClick={saveClassTeacher}>
              Save class teacher
            </button>
          </div>
          <div className="hint">A class teacher sees every subject of their class, manages its students and downloads its report cards.</div>
        </>
      )}

      <h3>Account</h3>
      <div className="weights-row">
        {active ? (
          <>
            <button type="button" className="btn secondary"
              onClick={() => run(RESET_TEACHER_PASSWORD, { input: { school_id: teacher.school_id, teacher_id: teacher.teacher_id } }, null, true)}>
              Reset password
            </button>
            {!isSelf && (
              <DangerButton icon="ban"
                onClick={() => window.confirm(`Deactivate ${fullName(teacher)}? They can no longer log in. Their marks stay.`)
                  && run(DEACTIVATE_TEACHER, { input: ref }, `${fullName(teacher)} deactivated`)}>
                Deactivate account
              </DangerButton>
            )}
          </>
        ) : (
          <button type="button" className="btn" onClick={() => run(REACTIVATE_TEACHER, { input: ref }, `${fullName(teacher)} reactivated`)}>
            Reactivate account
          </button>
        )}
      </div>
    </div>
  );
}

export default function Teachers() {
  const { actor } = useAuth();
  const { online } = useSync();
  const [teachers, setTeachers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ listTeachers }, { listSchoolClasses }] = await Promise.all([
      gql(LIST_TEACHERS, { school_id: actor.schoolId }),
      gql(LIST_SCHOOL_CLASSES, { school_id: actor.schoolId }),
    ]);
    setTeachers(listTeachers);
    setClasses(listSchoolClasses);
  }, [actor.schoolId]);

  useEffect(() => {
    if (online) load().catch((e) => setError(e.message));
  }, [load, online]);

  async function run(mutation, variables, done, handsOver = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = Object.values(await gql(mutation, variables))[0];
      if (handsOver) setAccount(data);
      else if (done) setNotice(done);
    } catch (e) {
      setError(e.message);
    } finally {
      // As on the assessment form: after a refusal or conflict, show what the server now holds.
      await load().catch(() => {});
      setBusy(false);
    }
  }

  async function create(e) {
    e.preventDefault();
    await run(CREATE_TEACHER, { input: { school_id: actor.schoolId, ...form } }, null, true);
    setForm(EMPTY);
  }

  const classNames = classLabels(classes);
  const current = teachers.find((t) => t.teacher_id === selected) || null;

  if (!online) return <div className="notice">Managing teachers needs a connection.</div>;

  return (
    <>
      <div className="page-head"><h1>Teachers</h1></div>
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <Handover account={account} onClose={() => setAccount(null)} />

      <form className="card stack" onSubmit={create}>
        <h2>Add a teacher</h2>
        <div className="weights-row">
          <Field label="First name" htmlFor="t-first">
            <input id="t-first" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
          </Field>
          <Field label="Last name" htmlFor="t-last">
            <input id="t-last" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
          </Field>
          <Field label="School email" htmlFor="t-email">
            <input id="t-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field label="Role" htmlFor="t-role">
            <Select id="t-role" value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={ROLES} />
          </Field>
          <button className="btn" type="submit" disabled={busy}>Add teacher</button>
        </div>
        <div className="hint">This creates their sign-in account and emails them a sign-in link and a temporary password.</div>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Class teacher of</th><th>Teaches</th><th>Action</th></tr>
          </thead>
          <tbody>
            {teachers.map((t) => (
              <tr key={t.teacher_id} className={t.teacher_id === selected ? 'row-dirty' : ''}>
                <td>{fullName(t)}</td>
                <td>{t.email}</td>
                <td>{t.role}</td>
                <td>{t.status === 'ACTIVE' ? 'Active' : <span className="warn">Deactivated</span>}</td>
                <td>{t.class_teacher_of ? classNames.get(t.class_teacher_of) || t.class_teacher_of : '—'}</td>
                <td>
                  {t.role === 'Admin'
                    ? 'All classes'
                    : t.assignments.length
                      ? [...new Set(t.assignments.map((a) => a.subject))].join(', ') +
                        ` in ${new Set(t.assignments.map((a) => a.class_id)).size} class${new Set(t.assignments.map((a) => a.class_id)).size === 1 ? '' : 'es'}`
                      : <span className="hint">Nothing yet</span>}
                </td>
                <td className="actions">
                  <button type="button" className="btn link" onClick={() => setSelected(t.teacher_id === selected ? null : t.teacher_id)}>
                    {t.teacher_id === selected ? 'Close' : 'Manage'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {current && <Manage teacher={current} classes={classes} isSelf={current.teacher_id === actor.sub} run={run} />}
    </>
  );
}