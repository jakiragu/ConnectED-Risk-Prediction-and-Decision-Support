import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { placeLabel } from '@gradebook/domain/locations';
import { CREATE_SCHOOL, LIST_SCHOOLS } from '../api/platformOperations.js';
import { Field } from '../components/Field.jsx';
import { useAngaza } from './AngazaAuth.jsx';
import { Crumbs, PlaceFields, focusField, splitError, useNow } from './parts.jsx';

const EMPTY = { name: '', country: '', region: '', town: '' };
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Registers a school. The next step, its first administrator, happens on the school's page. */
export default function NewSchoolPage() {
  const { api } = useAngaza();
  const navigate = useNavigate();
  const now = useNow();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState(null);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState([]);

  useEffect(() => { document.title = 'Add a school: Angaza console'; }, []);
  // Only to warn early about a school that is already registered; the server enforces it anyway.
  useEffect(() => { api(LIST_SCHOOLS).then((d) => setExisting(d.listSchools)).catch(() => {}); }, [api]);

  const sameName = useMemo(() => {
    if (!form.name.trim() || !form.country) return null;
    return existing.find((s) => s.country === form.country && norm(s.name) === norm(form.name)) || null;
  }, [existing, form.name, form.country]);

  async function submit(e) {
    e.preventDefault();
    const missing = {};
    if (!form.name.trim()) missing.name = 'Enter the school’s name';
    if (!form.country) missing.country = 'Choose the country the school is in';
    else if (!form.region.trim()) missing.region = 'Choose where in the country it is';
    if (Object.keys(missing).length) {
      setErrors(missing);
      focusField(Object.keys(missing)[0]);
      return;
    }
    setBusy(true);
    setErrors({});
    setGeneral(null);
    try {
      const { createSchool } = await api(CREATE_SCHOOL, { input: { ...form, town: form.town || null } });
      navigate(`/angaza/schools/${createSchool.school_id}`, { state: { created: true } });
    } catch (err) {
      const { fields, general: g } = splitError(err);
      setErrors(fields);
      setGeneral(g);
      if (err.field) focusField(err.field);
      setBusy(false);
    }
  }

  return (
    <>
      <Crumbs items={[{ label: 'Schools', to: '/angaza' }, { label: 'Add a school' }]} />
      <div className="form-split">
        <form className="card stack" onSubmit={submit} noValidate>
          <h1>Add a school</h1>
          {general && <div className="notice error" role="alert">{general}</div>}
          <Field label="School name" htmlFor="place-name" error={errors.name} hint="As the school writes it, for example Kitale Girls High School">
            <input id="place-name" value={form.name} maxLength={100} autoComplete="off"
              onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={Boolean(errors.name)} />
          </Field>
          <PlaceFields value={form} onChange={setForm} errors={errors} now={now} />
          {sameName && (
            <div className="notice warn" role="status">
              {sameName.name} is already registered in {placeLabel(sameName)}.{' '}
              <Link to={`/angaza/schools/${sameName.school_id}`}>Open it</Link> instead, unless this is a different school in another place.
            </div>
          )}
          <div className="row">
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Adding…' : 'Add school'}</button>
            <Link to="/angaza" className="btn secondary">Cancel</Link>
          </div>
        </form>

        <aside className="card stack" aria-labelledby="next-title">
          <h2 id="next-title">What happens next</h2>
          <ol className="steps">
            <li><b>Add the school.</b> That is this page.</li>
            <li><b>Add its first administrator.</b> We email them a sign-in link and a temporary password.</li>
            <li><b>They sign in</b>, choose their own password and set up classes, terms and teachers.</li>
          </ol>
          <p className="hint">Angaza sees totals for each school, never students’ names, marks or risk estimates.</p>
        </aside>
      </div>
    </>
  );
}
