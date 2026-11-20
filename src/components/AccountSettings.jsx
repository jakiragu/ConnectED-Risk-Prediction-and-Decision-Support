import { useCallback, useEffect, useState } from 'react';
import { gql } from '../api/graphql.js';
import { GET_ACCOUNT_POLICY, LIST_ACCOUNT_LINKS, REMOVE_GOOGLE_LINK, SAVE_ACCOUNT_POLICY } from '../api/accountOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { setSignOutNotice } from '../auth/signOutNotice.js';
import { DangerButton, Dialog, Notice } from './ui.jsx';
import { linkedOn, usePasswordConfirmation } from './SignInMethods.jsx';

/**
 * Settings > Accounts: who at the school may link a personal Google account to
 * their ConnectED account, and everyone's link status. The school issues each
 * account and decides what it can reach; a linked Google account is only a
 * second way to log in to it. Nobody may link until an administrator says so.
 */
const POLICY_LABEL = {
  NOBODY: 'Nobody',
  TEACHERS: 'Teachers only',
  TEACHERS_AND_ADMINS: 'Teachers and administrators',
};
const POLICY_HELP = {
  NOBODY: 'Everyone logs in with their school email and password. Google works only where the Google address is the school email.',
  TEACHERS: 'Teachers can link one personal Google account from My Profile. Administrators cannot.',
  TEACHERS_AND_ADMINS: 'Teachers and administrators can each link one personal Google account from My Profile.',
};
const REMOVED_OWN = 'You were logged out because Google sign-in was removed from your account. Log in with your password.';

const fullName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email;
const roleName = (role) => (role === 'Admin' ? 'Administrator' : 'Teacher');

export default function AccountSettings({ schoolId, onDirtyChange }) {
  const { actor, reauthenticate, signOut } = useAuth();
  const [saved, setSaved] = useState(null);
  const [choice, setChoice] = useState(null);
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [listError, setListError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null); // the person whose link is being removed
  const [removeBusy, setRemoveBusy] = useState(false);
  const { run, prompt } = usePasswordConfirmation({ reauthenticate, accountEmail: actor.email });

  const loadPeople = useCallback(() => gql(LIST_ACCOUNT_LINKS, { school_id: schoolId })
    .then(({ listAccountLinks }) => { setPeople(listAccountLinks); setListError(null); })
    .catch((e) => setListError(e.message)), [schoolId]);

  useEffect(() => {
    gql(GET_ACCOUNT_POLICY, { school_id: schoolId })
      .then(({ getAccountPolicy }) => { setSaved(getAccountPolicy); setChoice(getAccountPolicy.google_linking); })
      .catch((e) => setError(e.message));
    loadPeople();
  }, [schoolId, loadPeople]);

  const dirty = Boolean(saved) && choice !== saved.google_linking;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { saveAccountPolicy } = await run(() => gql(SAVE_ACCOUNT_POLICY, { input: { school_id: schoolId, google_linking: choice, _version: saved._version } }));
      setSaved(saveAccountPolicy);
      setChoice(saveAccountPolicy.google_linking);
      setNotice(saveAccountPolicy.google_linking === 'NOBODY'
        ? 'Saved. Nobody can link a new Google account. Accounts already linked stay linked until you remove them below.'
        : 'Saved. The people you chose can now link a Google account from My Profile.');
    } catch (e) {
      if (!e.cancelled) setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeLink() {
    const person = removing;
    setRemoveBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { removeGoogleLink } = await run(() => gql(REMOVE_GOOGLE_LINK, { input: { school_id: schoolId, teacher_id: person.teacher_id } }));
      setRemoving(null);
      if (removeGoogleLink.signed_out) { // the administrator removed their own link
        setSignOutNotice('school', REMOVED_OWN);
        signOut();
        return;
      }
      setNotice(`Google sign-in removed for ${fullName(person)}. They were logged out and emailed at ${person.email}.`);
      await loadPeople();
    } catch (e) {
      setRemoving(null);
      if (!e.cancelled) setError(e.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  if (error && !saved) return <div className="card settings-card"><h2>Accounts</h2><Notice tone="error">{error}</Notice></div>;
  if (!saved) return <div className="card settings-card"><h2>Accounts</h2><p className="hint" role="status">Loading…</p></div>;

  const linkedCount = (people || []).filter((p) => p.google_linked).length;
  return (
    <div className="stack">
      <div className="settings-intro">
        <p>
          Your school issues every account and decides what it can open. Here you choose whether people may also log in with
          a personal Google account, and see who has linked one.
        </p>
      </div>

      {notice && <Notice>{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="card settings-card">
        <div className="settings-section-head"><h3>Who may link a personal Google account</h3></div>
        <div className="choices" role="radiogroup" aria-label="Who may link a personal Google account">
          {Object.keys(POLICY_LABEL).map((k) => (
            <label key={k} className={`choice${choice === k ? ' active' : ''}`}>
              <input type="radio" name="google-linking" value={k} checked={choice === k} onChange={() => { setNotice(null); setChoice(k); }} />
              <span><b>{POLICY_LABEL[k]}</b><br /><span className="hint">{POLICY_HELP[k]}</span></span>
            </label>
          ))}
        </div>
        <p className="hint">
          Linking never changes a person’s school, role, classes or school email. A Google account can be linked to one
          ConnectED account only, and each person can link one.
        </p>
      </div>

      <div className={`card settings-card save-bar${dirty ? ' dirty' : ''}`}>
        <div className="grow">
          {dirty
            ? <div>{choice === 'NOBODY' ? 'Nobody will be able to link a new Google account.' : `${POLICY_LABEL[choice]} will be able to link a Google account.`}</div>
            : <div className="hint">No unsaved changes.</div>}
        </div>
        {dirty && <button type="button" className="btn secondary" disabled={saving} onClick={() => setChoice(saved.google_linking)}>Undo changes</button>}
        <button type="button" className="btn" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      <div className="card settings-card">
        <div className="settings-section-head">
          <h3>People and their Google sign-in</h3>
          {people && <span className="hint">{linkedCount} of {people.length} linked</span>}
        </div>
        <p className="hint">
          Remove a link when a phone is lost or someone leaves. The person is logged out, emailed at their school address,
          and must link again themselves. Deactivating an account on the Teachers page blocks both password and Google.
        </p>
        {listError && <Notice tone="error">{listError}</Notice>}
        {!people && !listError && <p className="hint" role="status">Loading…</p>}
        {people && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">School email</th><th scope="col">Role</th>
                  <th scope="col">Google sign-in</th><th scope="col">Linked Google account</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.teacher_id}>
                    <td>
                      <b>{fullName(p)}</b>
                      {p.status !== 'ACTIVE' && <div className="hint">Deactivated</div>}
                    </td>
                    <td>{p.email}</td>
                    <td>{roleName(p.role)}</td>
                    <td>
                      <span className={`pill ${p.google_linked ? 'good' : 'neutral'}`}>{p.google_linked ? 'Linked' : 'Not linked'}</span>
                      {!p.confirmed && <div className="hint">Could not be confirmed</div>}
                    </td>
                    <td>
                      {p.google_linked ? (
                        <>
                          {p.google_email || 'Address not recorded'}
                          {linkedOn(p.google_linked_at) && <div className="hint">Linked {linkedOn(p.google_linked_at)}</div>}
                        </>
                      ) : '—'}
                    </td>
                    <td className="actions">
                      {p.google_linked && (
                        <button type="button" className="btn link danger" onClick={() => { setNotice(null); setError(null); setRemoving(p); }}>Remove link</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={Boolean(removing)} title={removing ? `Remove Google sign-in for ${fullName(removing)}?` : ''} onClose={() => setRemoving(null)} busy={removeBusy} labelId="remove-link-title">
        {removing && (
          <>
            <p>
              {removing.google_email ? <b>{removing.google_email}</b> : 'The linked Google account'} will no longer be able to log in
              as {fullName(removing)}. Their school email and password keep working.
            </p>
            <ul className="plain consequences">
              <li>{removing.teacher_id === actor.sub ? 'You are' : `${removing.first_name || 'They'} is`} logged out on every device.</li>
              <li>We email {removing.email} to say an administrator removed it, naming you.</li>
              <li>It is not linked again automatically. {removing.teacher_id === actor.sub ? 'You' : 'They'} can link again from My Profile if your setting allows it.</li>
            </ul>
            <div className="row">
              <DangerButton onClick={removeLink} disabled={removeBusy}>{removeBusy ? 'Removing…' : 'Remove Google sign-in'}</DangerButton>
              <button type="button" className="btn secondary" onClick={() => setRemoving(null)} disabled={removeBusy} data-autofocus>Cancel</button>
            </div>
          </>
        )}
      </Dialog>
      {prompt}
    </div>
  );
}
