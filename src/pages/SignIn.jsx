import { startGoogle } from '../auth/oauth.js';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { completeNewPassword, signInWithPassword, requestPasswordReset, confirmPasswordReset } from '../auth/cognito.jsx';
import { Field } from '../components/Field.jsx';
import chalkboard from '../assets/sign-in-chalkboard.webp';
import { clearSignOutNotice, readSignOutNotice } from '../auth/signOutNotice.js';

/** Google's four-colour "G", as Google's sign-in branding asks for it. */
export function GoogleLogo() {
  return (
    <svg className="google-logo" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** The school portal's sign-in. The Angaza console uses the same screen (src/angaza/ConsoleSignIn.jsx). */
export default function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  return (
    <SignInScreen realm="school" subtitle="Exam and Gradebook System" emailPlaceholder="Enter school email address"
      onSignedIn={(tokens, remember) => { signIn(tokens, remember); navigate('/dashboard'); }} />
  );
}

/**
 * One sign-in screen for both portals, so they cannot drift apart. They differ only in the line
 * under the name, the sign-in pool (clientId; omitted for the school pool) and where signing in leads.
 *
 * @param {{ realm: 'school'|'angaza', subtitle: string, emailPlaceholder: string, clientId?: string,
 *           wrongAccountHelp?: string, onSignedIn: (tokens: object, remember: boolean) => void }} props
 */
export function SignInScreen({ realm, subtitle, emailPlaceholder, clientId, wrongAccountHelp, onSignedIn }) {
  // Why the person was signed out, if the app did it (their Google link was removed or changed). Shown once.
  const [signedOutNotice] = useState(() => readSignOutNotice(realm));
  useEffect(() => { clearSignOutNotice(realm); }, [realm]);
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
    onSignedIn(tokens, rememberMe);
  }

  async function submit(e) {
    e.preventDefault();

    if (resetStep === 'email') {
      if (!resetEmail.trim()) return;

      setBusy(true); setError(null);
      try {
        await requestPasswordReset(resetEmail, clientId);
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
        await confirmPasswordReset(resetEmail, resetCode, resetPassword, clientId);
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
        finish((await completeNewPassword(email.trim().toLowerCase(), challenge.session, newPassword, clientId)).tokens);
        return;
      }
      const res = await signInWithPassword(email.trim().toLowerCase(), password, clientId);
      if (res.challenge) setChallenge(res);
      else finish(res.tokens);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sign-in-page">
      <div className="sign-in-card">
        <div className="sign-in-art" style={{ backgroundImage: `url(${chalkboard})` }} aria-hidden="true" />
        <form className="sign-in-form" onSubmit={submit}>
          <div className="sign-in-brand">
            <p>Welcome back to</p>
            <div className="sign-in-name">ConnectED</div>
            <div className="sign-in-sub">{subtitle}</div>
          </div>
        <div className="stack">
          {!resetStep && (
            <h2>{challenge ? 'Choose your own password.' : 'Fill out the following form to log in.'}</h2>
          )}

          {signedOutNotice && !error && !resetStep && !challenge && (
            <div className="auth-notice" role="status">{signedOutNotice}</div>
          )}

          {error && (
            <div className="error" role="alert">
              {error}
              {wrongAccountHelp && error === 'Incorrect email or password' && <div>{wrongAccountHelp}</div>}
            </div>
          )}

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
                <input id="email" type="email" autoComplete="username" placeholder={emailPlaceholder}
                  value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password" htmlFor="password">
                <input id="password" type="password" autoComplete="current-password" placeholder="•••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              <div className="auth-options">
                <label className="remember-row" htmlFor="rememberMe">
                  <input id="rememberMe" type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)}/>
                  <span>Remember me</span>
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
                    onClick={() => startGoogle(realm, rememberMe).catch(err => setGoogleNotice(err.message))}
                  >
                    <GoogleLogo />
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
    </div>
  );
}