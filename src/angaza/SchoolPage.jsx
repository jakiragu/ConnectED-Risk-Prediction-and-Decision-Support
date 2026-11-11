import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { placeLabel } from '@gradebook/domain/locations';
import {
  ADD_SCHOOL_ADMIN, GET_SCHOOL, REACTIVATE_SCHOOL, RESET_SCHOOL_ADMIN_PASSWORD, SUSPEND_SCHOOL, UPDATE_SCHOOL,
} from '../api/platformOperations.js';
import { Field } from '../components/Field.jsx';
import { DangerButton, Dialog, EmptyState, useToast } from '../components/ui.jsx';
import { useAngaza } from './AngazaAuth.jsx';
import {
  Crumbs, Handover, LocalTime, PlaceFields, SchoolStatus, SignInState, focusField, splitError, useLoad, useNow,
} from './parts.jsx';
import { when } from './time.js';

const fullName = (a) => `${a.first_name} ${a.last_name}`;

/**
 * One school: getting it started (its first administrator), helping its
 * administrators, its details, and suspending it. Everything inside the school
 * (classes, teachers, students) is the school's own administrators' work.
 */
export default function SchoolPage() {
  const { schoolId } = useParams();
  const location = useLocation();
  const { api } = useAngaza();
  const now = useNow();
  const [toast, showToast] = useToast();
  const [handover, setHandover] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // 'suspend' | 'reactivate' | { reset: admin }
  const { data, error, loading, reload } = useLoad(async () => (await api(GET_SCHOOL, { school_id: schoolId })).getSchool, [api, schoolId]);

  const school = data?.school;
  useEffect(() => { if (school) document.title = `${school.name}: Angaza console`; }, [school]);
  // A school without an administrator cannot start; open the form straight away.
  useEffect(() => { if (data && !data.admins.some((a) => a.status === 'ACTIVE')) setAddOpen(true); }, [data]);

  if (error && !data) {
    const missing = error.errorType === 'NotFound';
    return (
      <>
        <Crumbs items={[{ label: 'Schools', to: '/angaza' }, { label: missing ? 'Not found' : 'School' }]} />
        <EmptyState title={missing ? 'This school is not registered' : 'The school could not be loaded'}
          action={missing ? <Link to="/angaza" className="btn">Back to schools</Link> : <button type="button" className="btn" onClick={reload}>Try again</button>}>
          {error.message}
        </EmptyState>
      </>
    );
  }
  if (!data) return <p className="hint" role="status">{loading ? 'Loading the school…' : ''}</p>;

  const { admins, usage } = data;
  const backTo = location.state?.from || '/angaza';
  const suspended = school.status === 'SUSPENDED';

  async function afterHandover(account, reset) {
    setHandover({ account, reset });
    await reload();
  }

  return (
    <>
      <Crumbs items={[{ label: 'Schools', to: backTo }, { label: school.name }]} />

      <header className="school-head">
        <div className="school-title">
          <h1>{school.name}</h1>
          <SchoolStatus status={school.status} />
        </div>
        <p className="school-place">{placeLabel(school)}</p>
        <LocalTime timeZone={school.time_zone} now={now} />
      </header>

      {location.state?.created && !admins.length && !handover && (
        <div className="notice success" role="status">{school.name} is registered. Next, add its first administrator.</div>
      )}

      {suspended && (
        <div className="notice warn suspended-notice" role="status">
          <div>
            <b>Suspended</b> on {when(school.suspended_at)}{school.suspended_by_name ? ` by ${school.suspended_by_name}` : ''}.
            Nobody at this school can use ConnectED until it is reactivated. Their records are kept.
          </div>
          {school.suspended_reason && <div><span className="hint">Reason:</span> {school.suspended_reason}</div>}
          <div><button type="button" className="btn" onClick={() => setDialog('reactivate')}>Reactivate school</button></div>
        </div>
      )}

      {handover && (
        <Handover account={handover.account} reset={handover.reset} schoolName={school.name} onClose={() => setHandover(null)} />
      )}

      <div className="school-grid">
        <div className="stack wide-gap">
          <AdminsCard school={school} admins={admins} api={api} open={addOpen} setOpen={setAddOpen}
            onAdded={(account) => { setAddOpen(false); afterHandover(account, false); }}
            onReset={(admin) => setDialog({ reset: admin })} />
          <DetailsCard school={school} api={api} now={now}
            onSaved={async () => { showToast('Details saved'); await reload(); }} />
          {!suspended && admins.some((a) => a.status === 'ACTIVE') && (
            <section className="card stack danger-zone" aria-labelledby="suspend-title">
              <h2 id="suspend-title">Suspend this school</h2>
              <p>
                Stops everyone at {school.name} from using ConnectED until you reactivate it. Nothing is deleted.
                Use it when a school leaves the programme, or when an account there may be misused.
              </p>
              <div><DangerButton onClick={() => setDialog('suspend')}>Suspend school…</DangerButton></div>
            </section>
          )}
        </div>

        <div className="stack wide-gap">
          <SetupChecklist school={school} admins={admins} onAddAdmin={() => { setAddOpen(true); setTimeout(() => focusField('first_name', 'admin'), 0); }}
            onReset={(admin) => setDialog({ reset: admin })} />
          <section className="card stack" aria-labelledby="usage-title">
            <h2 id="usage-title">At a glance</h2>
            <div className="stats compact">
              <div className="stat"><b>{usage.classes}</b><span>current classes</span></div>
              <div className="stat"><b>{usage.teachers}</b><span>staff accounts</span></div>
              <div className="stat"><b>{usage.students}</b><span>students</span></div>
            </div>
            <p className="hint">Totals only. Angaza never sees students’ names, marks or risk estimates.</p>
          </section>
        </div>
      </div>

      <SuspendDialog open={dialog === 'suspend'} school={school} api={api} onClose={() => setDialog(null)}
        onDone={async () => { setDialog(null); showToast('School suspended'); await reload(); }} />
      <ReactivateDialog open={dialog === 'reactivate'} school={school} api={api} onClose={() => setDialog(null)}
        onDone={async () => { setDialog(null); showToast('School reactivated'); await reload(); }} />
      <ResetDialog admin={dialog?.reset || null} school={school} api={api} onClose={() => setDialog(null)}
        onDone={(account) => { setDialog(null); afterHandover(account, true); }} />
      {toast}
    </>
  );
}

// ------------------------------------------------------------- getting started

function SetupChecklist({ school, admins, onAddAdmin, onReset }) {
  const active = admins.filter((a) => a.status === 'ACTIVE');
  const signedIn = active.some((a) => a.sign_in === 'SIGNED_IN');
  const waiting = active.filter((a) => a.sign_in === 'WAITING');
  const steps = [
    {
      done: true,
      title: 'School registered',
      detail: school.created_at ? `${school.created_by_name ? `By ${school.created_by_name}, ` : ''}${when(school.created_at)}` : null,
    },
    {
      done: active.length > 0,
      title: 'First administrator added',
      detail: active.length ? null : <button type="button" className="btn link" onClick={onAddAdmin}>Add an administrator</button>,
    },
    {
      done: signedIn,
      title: 'An administrator has signed in',
      detail: signedIn || !active.length ? null : waiting.length ? (
        <>
          Waiting for {waiting.map((a) => a.first_name).join(' or ')} to sign in with the temporary password.
          Invitation not received? <button type="button" className="btn link" onClick={() => onReset(waiting[0])}>Resend {waiting[0].first_name}’s invitation</button>
        </>
      ) : 'Their sign-in status is not available right now.',
    },
  ];
  const complete = steps.every((s) => s.done);

  return (
    <section className="card stack" aria-labelledby="setup-title">
      <h2 id="setup-title">{complete ? 'Setup complete' : 'Getting started'}</h2>
      <ol className="checklist">
        {steps.map((s) => (
          <li key={s.title} className={s.done ? 'done' : ''}>
            <span className="mark" aria-hidden="true">{s.done ? '✓' : ''}</span>
            <div>
              <b>{s.title}</b><span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
              {s.detail && <div className="hint">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      {complete && <p className="hint">The school’s administrators take it from here: classes, terms, teachers and students.</p>}
    </section>
  );
}

// -------------------------------------------------------------- administrators

const NO_ADMIN = { first_name: '', last_name: '', email: '' };

function AdminsCard({ school, admins, api, open, setOpen, onAdded, onReset }) {
  const [form, setForm] = useState(NO_ADMIN);
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    const missing = {};
    if (!form.first_name.trim()) missing.first_name = 'Enter their first name';
    if (!form.last_name.trim()) missing.last_name = 'Enter their last name';
    if (!form.email.trim()) missing.email = 'Enter the email they will sign in with';
    if (Object.keys(missing).length) {
      setErrors(missing);
      focusField(Object.keys(missing)[0], 'admin');
      return;
    }
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const { addSchoolAdmin } = await api(ADD_SCHOOL_ADMIN, { input: { school_id: school.school_id, ...form } });
      setForm(NO_ADMIN);
      onAdded(addSchoolAdmin);
    } catch (err) {
      const { fields, general: g } = splitError(err);
      setErrors(fields);
      setGeneral(g);
      if (err.field) focusField(err.field, 'admin');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="admins-title" id="admins">
      <div className="weights-head">
        <h2 id="admins-title">Administrators</h2>
        {!open && <button type="button" className="btn secondary small" onClick={() => setOpen(true)}>Add an administrator</button>}
      </div>
      <p className="hint">
        They run ConnectED at the school. Angaza adds the first one; after that they can add each other on their Teachers page.
      </p>

      {admins.length > 0 && (
        <div className="table-wrap bordered">
          <table>
            <thead><tr><th>Name</th><th>Sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.teacher_id}>
                  <td><b>{fullName(a)}</b><div className="hint">{a.email}</div></td>
                  <td><SignInState state={a.sign_in} /></td>
                  <td className="actions">
                    {a.status === 'ACTIVE' && (
                      <button type="button" className="btn link" onClick={() => onReset(a)}>
                        {a.sign_in === 'WAITING' ? 'Resend invitation' : 'Reset password'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <form className="stack add-admin" onSubmit={add} noValidate aria-labelledby="add-admin-title">
          <h3 id="add-admin-title">{admins.length ? 'Add another administrator' : 'Add the first administrator'}</h3>
          {general && <div className="notice error" role="alert">{general}</div>}
          <div className="field-grid">
            <Field label="First name" htmlFor="admin-first_name" error={errors.first_name}>
              <input id="admin-first_name" value={form.first_name} autoComplete="off" aria-invalid={Boolean(errors.first_name)}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
            </Field>
            <Field label="Last name" htmlFor="admin-last_name" error={errors.last_name}>
              <input id="admin-last_name" value={form.last_name} autoComplete="off" aria-invalid={Boolean(errors.last_name)}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
            </Field>
          </div>
          <Field label="Email" htmlFor="admin-email" error={errors.email} hint="Their own email. They sign in with it, and it can belong to only one school.">
            <input id="admin-email" type="email" value={form.email} autoComplete="off" aria-invalid={Boolean(errors.email)}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Adding…' : 'Add administrator'}</button>
            {admins.some((a) => a.status === 'ACTIVE') && (
              <button type="button" className="btn secondary" onClick={() => { setOpen(false); setErrors({}); setGeneral(null); }}>Cancel</button>
            )}
          </div>
          <p className="hint">We email them a sign-in link and a temporary password. If the email cannot be sent, you get the details to pass on.</p>
        </form>
      )}
    </section>
  );
}

function ResetDialog({ admin, school, api, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setError(null); }, [admin]);
  if (!admin) return null;
  const waiting = admin.sign_in === 'WAITING';

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const { resetSchoolAdminPassword } = await api(RESET_SCHOOL_ADMIN_PASSWORD, { input: { school_id: school.school_id, teacher_id: admin.teacher_id } });
      onDone(resetSchoolAdminPassword);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={waiting ? `Send ${admin.first_name} a new invitation?` : `Reset ${admin.first_name}’s password?`} onClose={onClose} busy={busy} labelId="reset-title">
      <p>
        {waiting
          ? `The temporary password in their earlier invitation stops working. We email ${admin.email} a new one.`
          : `Their current password stops working straight away. We email ${admin.email} a temporary password, and they choose a new one when they sign in.`}
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" onClick={reset} disabled={busy} data-autofocus>
          {busy ? (waiting ? 'Sending…' : 'Resetting…') : (waiting ? 'Send invitation' : 'Reset password')}
        </button>
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------- details

function DetailsCard({ school, api, now, onSaved }) {
  const [editing, setEditing] = useState(false);
  const start = () => ({ name: school.name, country: school.country, region: school.region, town: school.town || '' });
  const [form, setForm] = useState(start);
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);

  function edit() {
    setForm(start());
    setErrors({});
    setGeneral(null);
    setEditing(true);
    setTimeout(() => focusField('name'), 0);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      await api(UPDATE_SCHOOL, { input: { school_id: school.school_id, ...form, town: form.town || null, _version: school._version } });
      setEditing(false);
      await onSaved();
    } catch (err) {
      const { fields, general: g } = splitError(err);
      setErrors(fields);
      setGeneral(g);
      if (err.field) focusField(err.field);
      if (err.errorType === 'Conflict') await onSaved().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="details-title">
      <div className="weights-head">
        <h2 id="details-title">School details</h2>
        {!editing && <button type="button" className="btn secondary small" onClick={edit}>Edit details</button>}
      </div>
      {!editing ? (
        <dl className="facts">
          <dt>Name</dt><dd>{school.name}</dd>
          <dt>Country</dt><dd>{school.country_name}</dd>
          <dt>{school.region_label}</dt><dd>{school.region}</dd>
          <dt>Nearest town or area</dt><dd>{school.town || <span className="hint">Not given</span>}</dd>
          <dt>Time zone</dt><dd>{school.time_zone.replaceAll('_', ' ')}</dd>
          <dt>School ID</dt><dd><code>{school.school_id}</code></dd>
        </dl>
      ) : (
        <form className="stack" onSubmit={save} noValidate>
          {general && <div className="notice error" role="alert">{general}</div>}
          <Field label="School name" htmlFor="place-name" error={errors.name}>
            <input id="place-name" value={form.name} maxLength={100} aria-invalid={Boolean(errors.name)}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <PlaceFields value={form} onChange={setForm} errors={errors} now={now} />
          <p className="hint">The school sees its name and place in ConnectED, so check the spelling.</p>
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="btn secondary" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------- suspend, reactivate

function SuspendDialog({ open, school, api, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(''); setTyped(''); setError(null); } }, [open]);

  const nameMatches = typed.trim().toLowerCase() === school.name.trim().toLowerCase();
  const ready = reason.trim().length >= 5 && nameMatches;

  async function suspend(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api(SUSPEND_SCHOOL, { input: { school_id: school.school_id, reason: reason.trim(), _version: school._version } });
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={`Suspend ${school.name}?`} onClose={onClose} busy={busy} labelId="suspend-dialog-title">
      <form className="stack" onSubmit={suspend}>
        <ul className="plain consequences">
          <li>Everyone at the school is stopped at their next action and told that access is paused.</li>
          <li>Marks, results and records are kept. Work a teacher entered offline waits on their device.</li>
          <li>You or a colleague can reactivate the school at any time.</li>
        </ul>
        {error && <div className="notice error" role="alert">{error}</div>}
        <Field label="Reason" htmlFor="suspend-reason" hint="Only Angaza staff see this. Colleagues read it to decide when to reactivate.">
          <textarea id="suspend-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label={`Type the school’s name to confirm: ${school.name}`} htmlFor="suspend-name">
          <input id="suspend-name" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
        </Field>
        {!ready && <p className="hint" aria-live="polite">{reason.trim().length < 5 ? 'Give a reason to continue.' : 'Type the name exactly as shown to continue.'}</p>}
        <div className="row">
          <DangerButton type="submit" disabled={!ready || busy}>{busy ? 'Suspending…' : 'Suspend school'}</DangerButton>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function ReactivateDialog({ open, school, api, onClose, onDone }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setError(null); }, [open]);

  async function reactivate() {
    setBusy(true);
    setError(null);
    try {
      await api(REACTIVATE_SCHOOL, { input: { school_id: school.school_id, _version: school._version } });
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={`Reactivate ${school.name}?`} onClose={onClose} busy={busy} labelId="reactivate-title">
      <p>Everyone at the school can use ConnectED again straight away. Work waiting on their devices is sent when they next connect.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" onClick={reactivate} disabled={busy} data-autofocus>{busy ? 'Reactivating…' : 'Reactivate school'}</button>
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Dialog>
  );
}
