import { startGoogle } from '../auth/oauth.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { completeNewPassword, signInWithPassword, requestPasswordReset, confirmPasswordReset } from '../auth/cognito.jsx';
import { Field } from '../components/Field.jsx';

export default function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [resetStep, setResetStep] = useState(null);
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetNotice, setResetNotice] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [googleNotice, setGoogleNotice] = useState(null);

  function finish(tokens) {
    signIn(tokens, rememberMe);
    navigate('/dashboard');
  }

  async function submit(e) {
    e.preventDefault();

    if (resetStep === 'email') {
      if (!resetEmail.trim()) return;

      setBusy(true); setError(null);
      try {
        await requestPasswordReset(resetEmail);
        setResetNotice('If this account can recover by email, a code has been sent. Check your inbox and spam folder.');
        setResetStep('code');
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
      return;
    }

    if (resetStep === 'code') {
      if (!resetCode.trim()) {
        setResetNotice('Enter the verification code.');
        return;
      }

      if (resetPassword.length < 8) {
        setResetNotice('Your new password must contain at least 8 characters.');
        return;
      }

      if (resetPassword !== resetConfirm) {
        setResetNotice('The two passwords do not match.');
        return;
      }

      setBusy(true); setError(null);
      try {
        await confirmPasswordReset(resetEmail, resetCode, resetPassword);
        setResetStep('complete');
      } catch (err) { setError(err.message); }
      finally { setBusy(false); }
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (challenge) {
        if (newPassword !== confirm) throw new Error('The two passwords do not match');
        finish((await completeNewPassword(email.trim().toLowerCase(), challenge.session, newPassword)).tokens);
        return;
      }
      const res = await signInWithPassword(email.trim().toLowerCase(), password);
      if (res.challenge) setChallenge(res);
      else finish(res.tokens);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ minHeight: '100vh', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>Welcome back to</p>
        <div className="brand-name">ConnectED</div>
        <div className="brand-sub">Exam and Gradebook System</div>
      </div>

      <form className="card form-card" onSubmit={submit} style={{ marginTop: 0 }}>
        <div className="stack">
          {!resetStep && (
            <h2>{challenge ? 'Choose your own password.' : 'Fill out the following form to log in.'}</h2>
          )}

          {error && <div className="error">{error}</div>}

          {resetStep === 'email' ? (
          <>
            <h2>Reset your password</h2>

            <p className="hint">
              Enter the email address associated with your ConnectED account.
              We'll use it to identify your account for password recovery.
            </p>

            <div className="auth-notice">
              We will send a recovery code to your verified email address.
            </div>

            <Field label="Email address" htmlFor="resetEmail">
              <input
                id="resetEmail"
                type="email"
                autoComplete="email"
                placeholder="Enter your registered email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                required
              />
            </Field>

            <button className="btn" type="submit" disabled={busy}>
              Continue
            </button>

            <button
              type="button"
              className="btn link"
              onClick={() => {
                setResetStep(null);
                setResetNotice(null);
              }}
            >
              Back to login
            </button>
          </>
        ) : resetStep === 'code' ? (
          <>
            <h2>Verify your email</h2>

            <p className="hint">
              Enter the verification code and choose a new password for your account.
            </p>

            <div className="auth-notice">
              Check your inbox and spam folder for your recovery code.
            </div>

            <Field label="Verification code" htmlFor="resetCode">
              <input
                id="resetCode"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Enter verification code"
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                required
              />
            </Field>

            <Field label="New password" htmlFor="resetPassword">
              <input
                id="resetPassword"
                type="password"
                autoComplete="new-password"
                placeholder="Enter new password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                required
              />
            </Field>

            <Field label="Confirm new password" htmlFor="resetConfirm">
              <input
                id="resetConfirm"
                type="password"
                autoComplete="new-password"
                placeholder="Confirm new password"
                value={resetConfirm}
                onChange={(e) => setResetConfirm(e.target.value)}
                required
              />
            </Field>

            {resetNotice && (
              <div className="auth-notice" role="status">
                {resetNotice}
              </div>
            )}

            <button className="btn" type="submit" disabled={busy}>
              Reset password
            </button>

            <button
              type="button"
              className="btn link"
              onClick={() => {
                setResetStep('email');
                setResetNotice(null);
              }}
            >
              Back
            </button>
          </>
        ) : resetStep === 'complete' ? (
          <>
            <h2>Password updated</h2>

            <p className="hint">
              Your password has been changed. Sign in with your new password.
            </p>

            <div className="auth-notice">
              Your new password is ready to use.
            </div>

            <button
              type="button"
              className="btn"
              onClick={() => {
                setResetStep(null);
                setResetEmail('');
                setResetCode('');
                setResetPassword('');
                setResetConfirm('');
                setResetNotice(null);
                setPassword('');
              }}
            >
              Return to login
            </button>
          </>
        ) : !challenge ? (
            <>
              <Field label="Email" htmlFor="email">
                <input id="email" type="email" autoComplete="username" placeholder="Enter school email address"
                  value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password" htmlFor="password">
                <input id="password" type="password" autoComplete="current-password" placeholder="•••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              <div className="auth-options">
                <label className="remember-row" htmlFor="rememberMe">
                  <input id="rememberMe" type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)}/>
                  <span>Remember me on this device</span>
                </label>
                <button type="button" className="btn link"
                  onClick={() => {
                    setResetEmail(email);
                    setResetNotice(null);
                    setResetStep('email');
                  }}
                >
                  Forgot password?
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="hint">You signed in with a temporary password. Choose the password you will use from now on.</div>
              <Field label="New password" htmlFor="new" hint="At least 8 characters, with upper and lower case, a number and a symbol">
                <input id="new" type="password" autoComplete="new-password" value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)} required />
              </Field>
              <Field label="Confirm new password" htmlFor="confirm">
                <input id="confirm" type="password" autoComplete="new-password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
            </>
          )}

          {!resetStep && (
            <>
              <button className="btn" type="submit" disabled={busy}>
                {busy ? 'Please wait' : challenge ? 'Set password and log in' : 'Log in'}
              </button>

              {!challenge && (
                <>
                  <div className="auth-divider">
                    <span>OR</span>
                  </div>

                  <button className="btn google-btn" type="button"
                    onClick={() => startGoogle('school', rememberMe).catch(err => setGoogleNotice(err.message))}
                  >
                    <span className="google-mark" aria-hidden="true">G</span>
                    Continue with Google
                  </button>

                  {googleNotice && (
                    <p className="auth-notice" role="status">
                      {googleNotice}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}