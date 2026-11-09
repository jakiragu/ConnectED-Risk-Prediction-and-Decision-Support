import { startGoogle, hostedRecovery } from '../auth/oauth.js';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ANGAZA_CLIENT_ID, completeNewPassword, signInWithPassword } from '../auth/cognito.jsx';
import { Field } from '../components/Field.jsx';
import { useAngaza } from './AngazaAuth.jsx';

/** Sign-in for Angaza staff. School staff who land here are pointed to their own sign-in. */
export default function ConsoleSignIn() {
  const { staff, signIn } = useAngaza();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [challenge, setChallenge] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { document.title = 'Sign in: Angaza console'; }, []);
  if (staff) return <Navigate to="/angaza" replace />;

  function finish(tokens) {
    signIn(tokens, remember);
    navigate(location.state?.from?.pathname || '/angaza', { replace: true });
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        if (newPassword !== confirm) throw new Error('The two passwords do not match');
        finish((await completeNewPassword(email.trim().toLowerCase(), challenge.session, newPassword, ANGAZA_CLIENT_ID)).tokens);
        return;
      }
      const res = await signInWithPassword(email.trim().toLowerCase(), password, ANGAZA_CLIENT_ID);
      if (res.challenge) setChallenge(res);
      else finish(res.tokens);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const wrongAccount = error === 'Incorrect email or password';

  return (
    <div className="console page console-signin">
      <div className="console-signin-head">
        <div className="brand-name">ConnectED</div>
        <div className="console-tag dark">Angaza console</div>
      </div>
      <form className="card form-card" onSubmit={submit}>
        <div className="stack">
          {!challenge ? (
            <>
              <h1 className="h2">Log in with your Angaza account</h1>
              <p className="hint">
                For Angaza staff who register schools and support their administrators.
                Teachers and school administrators: <Link to="/sign-in">log in to your school</Link>.
              </p>
            </>
          ) : (
            <>
              <h1 className="h2">Choose your own password</h1>
              <p className="hint">You logged in with a temporary password. Choose the one you will use from now on.</p>
            </>
          )}

          {error && (
            <div className="notice error" role="alert">
              {error}
              {wrongAccount && <div>Check that this is your Angaza email. School accounts cannot open the console.</div>}
            </div>
          )}

          {!challenge ? (
            <>
              <Field label="Email" htmlFor="a-email">
                <input id="a-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password" htmlFor="a-password">
                <input id="a-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              <label className="remember-row" htmlFor="a-remember">
                <input id="a-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>Keep me logged in on this device</span>
              </label>
            </>
          ) : (
            <>
              <Field label="New password" htmlFor="a-new" hint="At least 8 characters, with upper and lower case letters, a number and a symbol">
                <input id="a-new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
              </Field>
              <Field label="Confirm new password" htmlFor="a-confirm">
                <input id="a-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
            </>
          )}
          {!challenge && <>
            <button className="btn link" type="button" onClick={() => hostedRecovery('angaza').catch(e => setError(e.message))}>Forgot password?</button>
            <button className="btn google-btn" type="button" onClick={() => startGoogle('angaza', remember).catch(e => setError(e.message))}>Continue with Google</button>
          </>}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Logging in…' : challenge ? 'Save password and log in' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}
