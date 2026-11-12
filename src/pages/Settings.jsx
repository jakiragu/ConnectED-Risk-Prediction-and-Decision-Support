import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { SUBJECTS } from '@gradebook/domain/assessment';
import { SUBJECT_TO_MODEL, RISK_OUTCOME } from '@gradebook/domain/features';
import { gql } from '../api/graphql.js';
import { GET_RISK_MODEL } from '../api/riskOperations.js';
import { LIST_TERMS_FULL } from '../api/calendarOperations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { useSync } from '../offline/useSync.js';
import { Offline, Notice } from '../components/ui.jsx';
import { Field, Select } from '../components/Field.jsx';
import AssessmentSetup from '../components/AssessmentSetup.jsx';
import CheckpointWeights from '../components/CheckpointWeights.jsx';
import GradingSettings from '../components/GradingSettings.jsx';
import ClassSetupSettings from '../components/ClassSetupSettings.jsx';
import ImportSettings from '../components/ImportSettings.jsx';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges.js';
import Terms from './Terms.jsx';

/**
 * Every school-wide rule in one place, for administrators. Each section says
 * in one line what it affects. Rules that define what a grade or a term result
 * means are school-wide on purpose: per-class rules would make the same grade
 * mean different things in different classes, and the risk model assumes one
 * definition. Teachers see the rules read-only on each class page.
 */
export const SECTIONS = [
  { id: 'school', label: 'School', blurb: 'Your school’s details' },
  { id: 'calendar', label: 'Calendar', blurb: 'Terms, dates and closures' },
  { id: 'classes', label: 'Classes', blurb: 'Forms and streams' },
  { id: 'exams', label: 'Exams and weights', blurb: 'Exam names, the Opener, how exams count' },
  { id: 'grading', label: 'Grading', blurb: 'Grade bands, pass mark, missing marks' },
  { id: 'subjects', label: 'Subjects', blurb: 'Subjects the school teaches' },
  { id: 'risk', label: 'Risk model', blurb: 'What risk estimates mean' },
  { id: 'import', label: 'Import from CSV', blurb: 'Students, assessments and marks from a file' },
];

function SchoolSection() {
  const { schoolName, actor } = useAuth();
  return (
    <div className="card settings-card">
      <h2>School</h2>
      <dl className="facts">
        <dt>Name</dt><dd>{schoolName || '—'}</dd>
        <dt>School ID</dt><dd><code>{actor.schoolId}</code></dd>
        <dt>Who can change settings</dt><dd>Administrators</dd>
      </dl>
      <p className="hint">Angaza keeps your school’s name and location. To change them, contact Angaza.</p>
    </div>
  );
}

function ExamsSection({ schoolId, online, onDirty }) {
  const [terms, setTerms] = useState([]);
  const [termId, setTermId] = useState('');
  const [setupDirty, setSetupDirty] = useState(false);
  const [weightsDirty, setWeightsDirty] = useState(false);

  useEffect(() => {
    gql(LIST_TERMS_FULL, { school_id: schoolId }).then(({ listTerms }) => {
      const sorted = [...listTerms].sort((a, b) => (b.academic_year - a.academic_year) || (b.term_number - a.term_number));
      setTerms(sorted);
      setTermId((id) => id || (sorted.find((t) => t.status === 'CURRENT') ?? sorted[0])?.term_id || '');
    }).catch(() => {});
  }, [schoolId]);
  useEffect(() => { onDirty(setupDirty || weightsDirty); }, [setupDirty, weightsDirty, onDirty]);

  return (
    <div className="stack">
      <div className="settings-intro">
        <p>
          Every term has a Mid-term and an End-term exam and may hold an Opener. The weights decide how much each exam counts
          towards the term result, for every class in the term.
        </p>
      </div>
      <AssessmentSetup schoolId={schoolId} onDirtyChange={setSetupDirty} />
      <div className="card settings-card">
        <Field label="This term" htmlFor="weights-term">
          <Select id="weights-term" value={termId} onChange={(v) => { if (!weightsDirty || window.confirm('Discard the unsaved weights?')) setTermId(v); }}
            options={terms.map((t) => ({ value: t.term_id, label: `${t.name}${t.status === 'CURRENT' ? ' (current)' : ''}` }))} />
        </Field>
      </div>
      {termId && (
        <CheckpointWeights key={termId} schoolId={schoolId} termId={termId} online={online}
          title="Whether this term holds an Opener, and its weights" onDirtyChange={setWeightsDirty} />
      )}
    </div>
  );
}

function SubjectsSection() {
  return (
    <div className="card settings-card">
      <h2>Subjects</h2>
      <p className="hint">
        The subjects marks can be entered for. In this version the list is fixed; a school cannot add or rename subjects yet.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Subject</th><th scope="col">Used in risk estimates</th></tr></thead>
          <tbody>
            {SUBJECTS.map((s) => (
              <tr key={s}><td>{s}</td><td>{SUBJECT_TO_MODEL[s] ? 'Yes' : 'No'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const pointLabel = (point) => {
  const m = /^T(\d)([MF])$/.exec(point || '');
  return m ? `Term ${m[1]} ${m[2] === 'M' ? 'Mid-term' : 'End-term'}` : point;
};

function RiskSection({ schoolId }) {
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    gql(GET_RISK_MODEL, { school_id: schoolId }).then((d) => setModel(d.getRiskModel)).catch((e) => setError(e.message));
  }, [schoolId]);
  return (
    <div className="stack">
      <div className="card settings-card">
        <h2>Risk model</h2>
        <p>
          A student is flagged when the model estimates they are likely to reach {RISK_OUTCOME.description}. This
          definition comes from how the model was trained, so it cannot be changed here, and it does not follow the school’s
          pass mark.
        </p>
        <p className="hint">
          Estimates are decision support: they point to students who may need attention. Whether and how to support a
          student is the teacher’s decision.
        </p>
      </div>
      <div className="card settings-card">
        <h3>Model in use</h3>
        {error && <Notice tone="error">{error}</Notice>}
        {!model && !error && <p className="hint">Loading…</p>}
        {model && !model.available && <Notice tone="warn">{model.message || 'No model is published yet.'}</Notice>}
        {model?.available && (
          <>
            <dl className="facts">
              <dt>Version</dt><dd>{model.model_version}</dd>
              {model.created_at && (<><dt>Published</dt><dd>{new Date(model.created_at).toLocaleDateString()}</dd></>)}
            </dl>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Prediction made at</th><th scope="col">Inputs used</th><th scope="col">Flags a student from</th></tr></thead>
                <tbody>
                  {(model.points || []).map((p) => (
                    <tr key={p.point}><td>{pointLabel(p.point)}</td><td>{p.features}</td><td>{Math.round(p.threshold * 100)}% estimated risk</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Settings() {
  const { section = 'school' } = useParams();
  const { actor } = useAuth();
  const { online } = useSync();
  const [dirty, setDirty] = useState({});
  const markDirty = useCallback((id) => (value) => setDirty((d) => (d[id] === value ? d : { ...d, [id]: value })), []);
  const handlers = useMemo(() => Object.fromEntries(SECTIONS.map((s) => [s.id, markDirty(s.id)])), [markDirty]);
  useUnsavedChanges(Boolean(dirty[section]));

  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/settings/school" replace />;
  if (!online) return <Offline what="Changing settings" />;

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <p className="hint page-lede">School-wide rules. Changes here affect every class, so only administrators can make them.</p>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <Link key={s.id} to={`/settings/${s.id}`} aria-current={s.id === section ? 'page' : undefined}>
              <b>{s.label}</b>
              <span>{s.blurb}</span>
            </Link>
          ))}
        </nav>
        <section className="settings-body" aria-label={SECTIONS.find((s) => s.id === section)?.label}>
          {section === 'school' && <SchoolSection />}
          {section === 'calendar' && <Terms embedded />}
          {section === 'classes' && (
            <div className="stack">
              <ClassSetupSettings schoolId={actor.schoolId} onDirtyChange={handlers.classes} />
              <div className="card settings-card stack">
                <h2>Student promotion and year rollover</h2>
                <p className="hint">Review final results, promotion exceptions and next year's teacher assignments before closing the school year.</p>
                <div><Link className="btn" to="/classes/promotion">Promote students</Link></div>
              </div>
            </div>
          )}
          {section === 'exams' && <ExamsSection schoolId={actor.schoolId} online={online} onDirty={handlers.exams} />}
          {section === 'grading' && <GradingSettings schoolId={actor.schoolId} onDirtyChange={handlers.grading} />}
          {section === 'subjects' && <SubjectsSection />}
          {section === 'risk' && <RiskSection schoolId={actor.schoolId} />}
          {section === 'import' && <ImportSettings schoolId={actor.schoolId} onDirtyChange={handlers.import} />}
        </section>
      </div>
    </>
  );
}
