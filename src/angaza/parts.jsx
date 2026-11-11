import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { COUNTRIES, countryOf } from '@gradebook/domain/locations';
import { Field, Select } from '../components/Field.jsx';
import { HOURS_LABEL, schoolClock } from './time.js';

/** The current time, refreshed every half minute so clocks on the page keep up. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Loads once, again on reload(); keeps the last good data while reloading. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await fn(), error: null, loading: false });
    } catch (e) {
      setState((s) => ({ ...s, error: e, loading: false }));
    }
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/** "2:30 PM  School hours  3 h ahead of you": the time where the school is, in the viewer's format. */
export function LocalTime({ timeZone, now, difference = true }) {
  const c = schoolClock(timeZone, now);
  return (
    <span className="local-time">
      <b>{c.day ? `${c.day} ${c.time}` : c.time}</b>
      <span className={`hours ${c.hours.toLowerCase()}`} title="Time-based reference, not live school availability">{HOURS_LABEL[c.hours]}</span>
      {difference && <span className="hint">{c.difference}</span>}
    </span>
  );
}

export function SchoolStatus({ status }) {
  return status === 'SUSPENDED'
    ? <span className="pill warn">Suspended</span>
    : <span className="pill good">Active</span>;
}

const SIGN_IN = {
  SIGNED_IN: ['good', 'Signed in'],
  WAITING: ['warn', 'Has not signed in yet'],
  DISABLED: ['neutral', 'Deactivated by the school'],
  UNKNOWN: ['neutral', 'Sign-in status unavailable'],
};

export function SignInState({ state }) {
  const [tone, label] = SIGN_IN[state] || SIGN_IN.UNKNOWN;
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function Crumbs({ items }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c) => (
          <li key={c.label}>{c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}</li>
        ))}
      </ol>
    </nav>
  );
}

/** A button that copies text and says so for two seconds (also to screen readers). */
function CopyButton({ text, children, primary = false }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      window.prompt('Copy this, then press OK:', text); // clipboard blocked (non-https or older browser)
    }
  }
  return (
    <button type="button" className={`btn ${primary ? '' : 'secondary'} small`} onClick={copy}>
      <span aria-live="polite">{done ? 'Copied' : children}</span>
    </button>
  );
}

/**
 * After an administrator is added or their password reset. Normally the details
 * were emailed, so this confirms it and keeps the password one click away in case
 * the email does not arrive. If the email could not be sent, it says why and
 * shows everything to pass on by hand, as before. Either way the password is
 * shown only here, once.
 */
export function Handover({ account, schoolName, reset = false, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const { admin, temporary_password: password, email } = account;
  const emailed = Boolean(email?.sent);
  const name = `${admin.first_name} ${admin.last_name}`;
  const signInAt = `${window.location.origin}/sign-in`;
  const message = [
    `Your ConnectED administrator account for ${schoolName}`,
    `Sign in at: ${signInAt}`,
    `Email: ${admin.email}`,
    `Temporary password: ${password}`,
    'You will choose your own password the first time you sign in.',
  ].join('\n');

  const details = (
    <>
      <dl className="facts">
        <dt>Sign in at</dt><dd>{signInAt}</dd>
        <dt>Email</dt><dd>{admin.email}</dd>
        <dt>Temporary password</dt><dd><code className="secret">{password}</code></dd>
      </dl>
      <p className="hint">
        It works once: {admin.first_name} chooses their own password when they first sign in. It is not shown
        again, so copy it now. For extra safety, send the password on its own, for example by text message.
      </p>
      <div className="row">
        <CopyButton text={message} primary={!emailed}>Copy all details</CopyButton>
        <CopyButton text={password}>Copy password only</CopyButton>
      </div>
    </>
  );

  return (
    <section className="card handover-card stack" tabIndex={-1} ref={ref} aria-labelledby="handover-title">
      {emailed ? (
        <>
          <h2 id="handover-title">{reset ? `New sign-in details emailed to ${admin.first_name}` : `Invitation emailed to ${name}`}</h2>
          <p>
            We sent <b>{admin.email}</b> a sign-in link and a temporary password. {admin.first_name} chooses their own
            password the first time they sign in.
          </p>
          <details className="handover-fallback">
            <summary>Email not arriving? Show the details to pass on yourself</summary>
            {details}
          </details>
        </>
      ) : (
        <>
          <h2 id="handover-title">{reset ? `Give ${admin.first_name} their new temporary password` : `Give ${name} their sign-in details`}</h2>
          {email && (
            <div className="notice warn" role="status">
              The email to {admin.email} was not sent. {email.problem} Pass these details on yourself.
            </div>
          )}
          {details}
        </>
      )}
      <div className="row">
        <button type="button" className="btn link" onClick={onClose}>Done</button>
      </div>
    </section>
  );
}

/**
 * Country, then its county or district, then the nearest town. The second
 * field is named the way the country names it, and offers the official list
 * where one is known, so the console can group and filter by it reliably.
 */
export function PlaceFields({ value, onChange, errors = {}, now }) {
  const country = countryOf(value.country);
  const set = (patch) => onChange({ ...value, ...patch });
  const regionLabel = country?.region_label || 'County or district';

  function chooseCountry(code) {
    const next = countryOf(code);
    // Keep a typed region if it still makes sense; drop one that is not in the new country's list.
    const keep = next && (!next.regions.length || next.regions.includes(value.region));
    set({ country: code, region: keep ? value.region : '' });
  }

  return (
    <>
      <Field label="Country" htmlFor="place-country" error={errors.country}>
        <Select id="place-country" value={value.country} onChange={chooseCountry}
          placeholder="Choose a country" aria-invalid={Boolean(errors.country)}
          options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))} />
      </Field>
      {country && (
        <div className="place-time" aria-live="polite">
          <span className="hint">Time there now</span>
          <LocalTime timeZone={country.time_zone} now={now} />
        </div>
      )}
      <Field label={regionLabel} htmlFor="place-region" error={errors.region}
        hint={!country ? 'Choose the country first' : undefined}>
        {country?.regions.length ? (
          <Select id="place-region" value={value.region} onChange={(v) => set({ region: v })}
            placeholder={`Choose a ${regionLabel.toLowerCase()}`} options={country.regions} aria-invalid={Boolean(errors.region)} />
        ) : (
          <input id="place-region" value={value.region} disabled={!country} maxLength={60}
            onChange={(e) => set({ region: e.target.value })} aria-invalid={Boolean(errors.region)} />
        )}
      </Field>
      <Field label="Nearest town or area (optional)" htmlFor="place-town" error={errors.town}
        hint="Helps colleagues tell apart schools with similar names">
        <input id="place-town" value={value.town} maxLength={60} onChange={(e) => set({ town: e.target.value })}
          aria-invalid={Boolean(errors.town)} />
      </Field>
    </>
  );
}

/** Field errors from the server land under the field they are about; anything else is shown above the form. */
export function splitError(e) {
  const known = ['name', 'country', 'region', 'town', 'email', 'first_name', 'last_name', 'reason'];
  return known.includes(e?.field) ? { fields: { [e.field]: e.message }, general: null } : { fields: {}, general: e?.message || 'Something went wrong. Try again.' };
}

/** Moves focus to the field a server error is about, so the person sees what to fix. */
export function focusField(field, prefix = 'place') {
  const el = document.getElementById(`${prefix}-${field}`) || document.getElementById(field);
  el?.focus();
}
