import { useEffect, useRef, useState } from 'react';
import { DangerButton, Dialog, Notice } from './ui.jsx';
import { Field } from './Field.jsx';

/*
 * The ways a person can sign in to their account, on My Profile (school staff)
 * and on the Angaza console's My Profile. Email and password are always there;
 * one personal Google account can be linked as a second way in.
 *
 * Every rule is the server's (backend/library/accountLink.js). This file shows
 * the state, asks for the password again when the server wants a recent
 * sign-in, and confirms before removing.
 */

const PENDING_KEY = 'connected.google-link';

/** Remembered across the trip to Google: which portal started it and the value Google must send back. */
export function rememberLinkRequest(realm, state) {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ realm, state, created: Date.now() }));
}
export function readLinkRequest() {
  try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { return null; }
}
export function clearLinkRequest() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing to clear */ }
}

/** "16 Nov 2026" */
export const linkedOn = (iso) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
};

/**
 * Runs a sensitive action; if the server asks for a recent sign-in, asks for the password,
 * signs in again and retries the same action. Used by this card and by Settings > Accounts.
 *
 * @returns {{ run: (action: () => Promise<any>) => Promise<any>, prompt: JSX.Element|null }}
 */
export function usePasswordConfirmation({ reauthenticate, accountEmail }) {
  const [pending, setPending] = useState(null); // { action, resolve, reject }
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  // Set on every mount (React StrictMode mounts twice in development), cleared on unmount.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = async (action) => {
    try {
      return await action();
    } catch (e) {
      if (e.errorType !== 'ReauthRequired') throw e;
      return new Promise((resolve, reject) => { setPassword(''); setError(null); setPending({ action, resolve, reject }); });
    }
  };

  function cancel() {
    pending?.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    setPending(null);
  }

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await reauthenticate(password);
    } catch (err) {
      if (alive.current) {
        setError(err.message === 'Incorrect email or password' ? 'That password is not correct. Try again.' : err.message);
        setBusy(false);
      }
      return;
    }
    const { action, resolve, reject } = pending;
    if (alive.current) { setPending(null); setBusy(false); }
    action().then(resolve, reject);
  }

  const prompt = pending ? (
    <Dialog open title="Confirm your password" onClose={cancel} busy={busy} labelId="confirm-password-title">
      <form className="stack" onSubmit={confirm}>
        <p>Changing how you sign in needs a recent log in. Enter your password to continue.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        <Field label="Email">
          <input value={accountEmail || ''} readOnly disabled autoComplete="username" />
        </Field>
        <Field label="Password" htmlFor="confirm-password">
          <input id="confirm-password" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required data-autofocus />
        </Field>
        <div className="row">
          <button type="submit" className="btn" disabled={busy || !password}>{busy ? 'Checking…' : 'Continue'}</button>
          <button type="button" className="btn secondary" onClick={cancel} disabled={busy}>Cancel</button>
        </div>
      </form>
    </Dialog>
  ) : null;

  return { run, prompt };
}

/**
 * @param {object} props
 * @param {object} props.methods        SignInMethods from the API
 * @param {string} props.accountEmail   the account's own (school or Angaza) address
 * @param {'school'|'angaza'} props.realm
 * @param {boolean} props.online
 * @param {() => Promise<{url:string,state:string}>} props.start     starts a link request
 * @param {() => Promise<{signed_out:boolean,sign_in:object}>} props.remove
 * @param {(password:string) => Promise<void>} props.reauthenticate
 * @param {() => void} props.onSignedOut  the person's sessions were ended: sign out here too
 * @param {JSX.Element} [props.adminHint]  for administrators: a link to the school's setting
 */
export default function SignInMethods({ methods, accountEmail, realm, online = true, start, remove, reauthenticate, onSignedOut, adminHint }) {
  const [busy, setBusy] = useState(null); // 'link' | 'remove'
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const { run, prompt } = usePasswordConfirmation({ reauthenticate, accountEmail });

  const linked = methods.google_linked;
  const date = linkedOn(methods.google_linked_at);

  async function link() {
    setBusy('link');
    setError(null);
    try {
      const { url, state } = await run(start);
      rememberLinkRequest(realm, state);
      window.location.assign(url); // Google's own account chooser; it sends the person back to /auth/google-link
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setBusy(null);
    }
  }

  async function removeLink() {
    setBusy('remove');
    setError(null);
    try {
      await run(remove);
      setConfirming(false);
      onSignedOut();
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setConfirming(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-labelledby="sign-in-methods-title">
      <h2 id="sign-in-methods-title">Sign-in Methods</h2>
      <div className="hint">
        The ways you can log in to this account. Each one opens the same account, with the same {realm === 'angaza' ? 'access' : 'school, role and classes'}.
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!methods.confirmed && (
        <Notice tone="warn">The sign-in service did not answer, so this shows the last known state. Reload to check again.</Notice>
      )}

      <ul className="signin-methods">
        <li className="signin-method">
          <div className="signin-method-what">
            <b>Email and password</b>
            <span className="hint">{accountEmail}</span>
          </div>
          <span className="pill good">Always on</span>
          <div className="signin-method-actions" />
        </li>

        <li className="signin-method">
          <div className="signin-method-what">
            <b>Google</b>
            {linked ? (
              <span className="hint">
                {methods.google_email || 'A Google account (address not recorded)'}
                {date ? ` · linked ${date}` : ''}
              </span>
            ) : (
              <span className="hint">Link one personal Google account to use “Continue with Google”.</span>
            )}
          </div>
          <span className={`pill ${linked ? 'good' : 'neutral'}`}>{linked ? 'Linked' : 'Not linked'}</span>
          <div className="signin-method-actions">
            {linked ? (
              <>
                {methods.can_link && (
                  <button type="button" className="btn secondary" disabled={!online || Boolean(busy)} onClick={link}>
                    {busy === 'link' ? 'Opening Google…' : 'Change'}
                  </button>
                )}
                <DangerButton disabled={!online || Boolean(busy)} onClick={() => { setError(null); setConfirming(true); }}>Remove</DangerButton>
              </>
            ) : methods.can_link ? (
              <button type="button" className="btn" disabled={!online || Boolean(busy)} onClick={link}>
                {busy === 'link' ? 'Opening Google…' : 'Link Google account'}
              </button>
            ) : null}
          </div>
        </li>
      </ul>

      {!methods.can_link && methods.blocked_reason && (
        <div className="notice">
          {linked ? 'You cannot change the linked account. ' : ''}{methods.blocked_reason}
          {adminHint ? <> {adminHint}</> : null}
        </div>
      )}
      {linked && (
        <div className="hint">
          Changing or removing the Google account logs you out on every device, and we email {accountEmail} about it.
        </div>
      )}

      <Dialog open={confirming} title="Remove Google sign-in?" onClose={() => setConfirming(false)} busy={busy === 'remove'} labelId="remove-google-title">
        <p>
          {methods.google_email ? <><b>{methods.google_email}</b> will</> : 'The linked Google account will'} no longer be able to log in to this account.
          Your email and password keep working.
        </p>
        <ul className="plain consequences">
          <li>You are logged out on every device and log in again with your password.</li>
          <li>We email {accountEmail} to say Google sign-in was removed.</li>
          <li>It is not linked again automatically. You can link a Google account again from here.</li>
        </ul>
        <div className="row">
          <DangerButton onClick={removeLink} disabled={busy === 'remove'}>{busy === 'remove' ? 'Removing…' : 'Remove Google sign-in'}</DangerButton>
          <button type="button" className="btn secondary" onClick={() => setConfirming(false)} disabled={busy === 'remove'} data-autofocus>Cancel</button>
        </div>
      </Dialog>

      {prompt}
    </section>
  );
}
