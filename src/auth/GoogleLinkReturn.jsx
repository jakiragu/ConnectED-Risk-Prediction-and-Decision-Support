import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { gql } from '../api/graphql.js';
import { COMPLETE_GOOGLE_LINK, COMPLETE_STAFF_GOOGLE_LINK } from '../api/accountOperations.js';
import { clearLinkRequest, readLinkRequest } from '../components/SignInMethods.jsx';
import { useAuth } from './AuthContext.jsx';
import { useAngaza } from '../angaza/AngazaAuth.jsx';
import { setSignOutNotice } from './signOutNotice.js';

/*
 * Where Google sends someone back after they chose an account to link
 * (/auth/google-link, one address for both portals). The page hands Google's
 * signed answer to the server, which decides everything; the browser checks
 * only that the answer belongs to the request this tab started.
 */
const CHANGED = 'You were logged out because the Google account linked to your account was changed. Log in again.';

// React StrictMode runs an effect twice; Google's answer can be used once.
const attempts = new Map();
const once = (key, fn) => {
  if (!attempts.has(key)) attempts.set(key, fn());
  return attempts.get(key);
};

export default function GoogleLinkReturn({ platform = false }) {
  const location = useLocation();
  const navigate = useNavigate();
  const school = useAuth();
  const angaza = useAngaza();
  const [error, setError] = useState(null);
  const pending = readLinkRequest();
  // Started from the Angaza console: finish inside it, where its own session lives.
  const forward = !platform && pending?.realm === 'angaza';
  const signedIn = platform ? Boolean(angaza?.staff) : Boolean(school.actor);
  const profile = platform ? '/angaza/profile' : '/profile';
  const signIn = platform ? '/angaza/sign-in' : '/sign-in';

  useEffect(() => {
    if (forward || !signedIn) return undefined;
    let active = true;
    const answer = new URLSearchParams(location.hash.replace(/^#/, ''));
    const fail = (message) => { if (active) setError(message); };

    if (answer.get('error')) {
      clearLinkRequest();
      fail(answer.get('error') === 'access_denied'
        ? 'Linking was cancelled at Google. Nothing was changed.'
        : 'Google did not complete the request. Nothing was changed.');
      return undefined;
    }
    const token = answer.get('id_token');
    if (!pending || !token || answer.get('state') !== pending.state || Date.now() - pending.created > 15 * 60_000) {
      fail('This link request expired or could not be matched to this browser tab. Start again from your profile.');
      return undefined;
    }

    once(token, async () => {
      clearLinkRequest();
      return platform
        ? (await angaza.api(COMPLETE_STAFF_GOOGLE_LINK, { input: { id_token: token } })).completeStaffGoogleLink
        : (await gql(COMPLETE_GOOGLE_LINK, { input: { school_id: school.actor.schoolId, id_token: token } })).completeGoogleLink;
    }).then((result) => {
      if (!active) return;
      if (result.signed_out) {
        setSignOutNotice(platform ? 'angaza' : 'school', CHANGED);
        (platform ? angaza : school).signOut();
        navigate(signIn, { replace: true });
        return;
      }
      navigate(profile, { replace: true, state: { googleLinked: result.sign_in.google_email || true } });
    }).catch((e) => fail(e.message));
    return () => { active = false; };
    // Google's answer is handled once; later session changes must not hand it in again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (forward) return <Navigate to={`/angaza/link/google${location.hash}`} replace />;

  const problem = error || (!signedIn ? 'Log in first, then link your Google account from your profile.' : null);
  // The same frame as the hand-back from "Continue with Google" (OAuthCallback).
  return (
    <div className="page" style={{ minHeight: '100vh', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="brand-name">ConnectED</div>
        <div className="brand-sub">{platform ? 'Angaza Center Console' : 'Exam and Gradebook System'}</div>
      </div>
      <div className="card form-card" style={{ marginTop: 0 }}>
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <h2>{problem ? 'Your Google account was not linked.' : 'Linking your Google account…'}</h2>
          {problem ? (
            <>
              <div className="error" role="alert">{problem}</div>
              <Link className="btn" style={{ alignSelf: 'center', width: 'auto', paddingInline: '1.5rem' }} to={signedIn ? profile : signIn}>
                {signedIn ? 'Back to my profile' : 'Go to log in'}
              </Link>
            </>
          ) : (
            <p className="hint" role="status" style={{ margin: 0 }}>Checking Google’s answer. This takes a moment.</p>
          )}
        </div>
      </div>
    </div>
  );
}
