import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { GET_STAFF_PROFILE, REMOVE_STAFF_GOOGLE_LINK, START_STAFF_GOOGLE_LINK } from '../api/accountOperations.js';
import { Field } from '../components/Field.jsx';
import SignInMethods from '../components/SignInMethods.jsx';
import { setSignOutNotice } from '../auth/signOutNotice.js';
import { useAngaza } from './AngazaAuth.jsx';
import { Crumbs } from './parts.jsx';

export const STAFF_ROLE = 'Angaza staff';
const REMOVED = 'You were logged out because Google sign-in was removed from your account. Log in with your password.';

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '—';
};

/**
 * My Profile for Angaza staff: who the console knows them as, and how they sign in.
 * Laid out like the school app's My Profile. Names are read-only here: console accounts
 * are created by the Angaza team (local/add-angaza-staff.js), not from the console.
 */
export default function ProfilePage() {
  const { staff, api, reauthenticate, signOut } = useAngaza();
  const { profile: loaded, setProfile: share } = useOutletContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(loaded);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => { document.title = 'My Profile: Angaza Center Console'; }, []);
  // Always read afresh: the link status may have changed since the frame loaded it.
  useEffect(() => {
    let active = true;
    api(GET_STAFF_PROFILE)
      .then(({ getStaffProfile }) => { if (active) { setProfile(getStaffProfile); share(getStaffProfile); } })
      .catch((e) => { if (active) setError(e.message || 'Your profile could not be loaded.'); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Back from Google with the account linked (GoogleLinkReturn): say so once.
  useEffect(() => {
    const linked = location.state?.googleLinked;
    if (!linked) return;
    setNotice(typeof linked === 'string'
      ? `${linked} is now linked. You can log in with “Continue with Google”. We emailed ${staff.email} about it.`
      : `Your Google account is now linked. We emailed ${staff.email} about it.`);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const crumbs = <Crumbs items={[{ label: 'Schools', to: '/angaza' }, { label: 'My Profile' }]} />;
  if (!profile) {
    return (
      <div className="stack">
        {crumbs}
        <div className="page-head"><h1>My Profile</h1></div>
        {error ? <div className="card error-card">{error}</div> : <div className="hint" role="status">Loading your profile…</div>}
      </div>
    );
  }

  return (
    <div className="stack">
      {crumbs}
      <div className="page-head"><h1>My Profile</h1></div>
      {error && <div className="card error-card">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      <section className="card stack">
        <h2>Account Information</h2>
        <div className="hint">
          These details belong to your Angaza console account and cannot be edited here. To correct them, ask the Angaza
          team member who looks after console accounts.
        </div>
        <div className="two-col">
          <div className="stack">
            <Field label="First name"><input value={profile.first_name || '—'} readOnly disabled /></Field>
            <Field label="Last name"><input value={profile.last_name || '—'} readOnly disabled /></Field>
            <Field label="Angaza email"><input value={profile.email || '—'} readOnly disabled /></Field>
          </div>
          <div className="stack">
            <Field label="Role"><input value={STAFF_ROLE} readOnly disabled /></Field>
            <Field label="Account status"><input value={profile.status === 'ACTIVE' ? 'Active' : profile.status || '—'} readOnly disabled /></Field>
            <Field label="Account created"><input value={formatDate(profile.created_at)} readOnly disabled /></Field>
          </div>
        </div>
      </section>

      <SignInMethods
        methods={profile.sign_in}
        accountEmail={profile.email}
        realm="angaza"
        start={async () => (await api(START_STAFF_GOOGLE_LINK)).startStaffGoogleLink}
        remove={async () => (await api(REMOVE_STAFF_GOOGLE_LINK)).removeStaffGoogleLink}
        reauthenticate={reauthenticate}
        onSignedOut={() => { setSignOutNotice('angaza', REMOVED); signOut(); }}
      />
    </div>
  );
}
