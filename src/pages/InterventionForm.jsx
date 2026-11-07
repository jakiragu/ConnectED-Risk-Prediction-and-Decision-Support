import { selectedChanges } from '@gradebook/domain/targets';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { todayIn } from '@gradebook/domain/calendar';
import { FREQUENCY_LABEL, INTERVENTION_STATUS, methodKey, validateIntervention } from '@gradebook/domain/decision';
import { ulid } from '@gradebook/domain/ids';
import { targetText } from '@gradebook/domain/targets';
import { useAuth } from '../auth/AuthContext.jsx';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { InterventionEditor as Editor, MethodSuggestions } from '../components/InterventionEditor.jsx';
import { ActionIcon, DangerButton } from '../components/ui.jsx';

const today = () => todayIn('Africa/Nairobi');
const blank = (factor) => ({ factor, method: '', frequency: 'WEEKLY', started_on: today(), expected_outcome: '', notes: '' });

/** The parts of an intervention the server takes (SaveInterventionInput). */
const inputOf = (schoolId, studentId, i, patch = {}) => {
  const v = { ...i, ...patch };
  return {
    school_id: schoolId, student_id: studentId, intervention_id: v.intervention_id, factor: v.factor, method: v.method,
    frequency: v.frequency, status: v.status, started_on: v.started_on, stopped_on: v.stopped_on ?? null,
    expected_outcome: v.expected_outcome || null, notes: v.notes || null,
  };
};

function SyncState({ i, onDiscard }) {
  if (i._failed) {
    return (
      <span className="warn">
        Not saved: {i._failed} <button type="button" className="btn link" onClick={onDiscard}>Discard this change</button>
      </span>
    );
  }
  if (i._pending) return <span className="hint">{i._pending === 'DELETE' ? 'Deleted on this device; waiting to send' : 'Saved on this device; waiting to send'}</span>;
  return null;
}

/**
 * Recording what a teacher decided to do for a student (FR-12): add, edit,
 * stop, restart and delete interventions, by subject or attendance. Works
 * offline: changes are kept on this device and sent when the server can be
 * reached. Suggestions are methods teachers in the school have used before;
 * the system does not choose interventions.
 */
export default function InterventionForm() {
  const { studentId } = useParams();
  const location = useLocation();
  const { actor } = useAuth();
  const { online } = useSync();
  const [profile, setProfile] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [methods, setMethods] = useState([]);
  const [search, setSearch] = useState('');
  const methodRef = useRef(null);
  const items = useLive(() => db().interventions.where('student_id').equals(studentId).toArray(), [studentId], []);

  useEffect(() => {
    repository.loadProfile(actor.schoolId, studentId).then((v) => {
      setProfile(v.data);
      if (v.data) {
        const targeted = selectedChanges(v.data.targets)?.map((c) => c.group) ?? [];
        setDraft((d) => d || blank(targeted.find((g) => v.data.scope.factors.includes(g)) ?? v.data.scope.factors[0]));
      }
    }).catch((e) => setError(e.message));
  }, [actor.schoolId, studentId, online]);

  useEffect(() => {
    if (!draft?.factor) return;
    repository.loadMethods(actor.schoolId, draft.factor).then((v) => setMethods(v.data || []));
  }, [actor.schoolId, draft?.factor, online]);

  const factors = useMemo(() => {
    if (!profile) return [];
    const targeted = new Set(selectedChanges(profile.targets)?.map((c) => c.group) ?? []);
    return [...profile.scope.factors].sort((a, b) => Number(targeted.has(b)) - Number(targeted.has(a)) || a.localeCompare(b));
  }, [profile]);

  const visible = items.filter((i) => !profile || profile.scope.factors.includes(i.factor));
  const group = (status) => {
    const out = new Map();
    for (const i of visible.filter((x) => x.status === status)) out.set(i.factor, [...(out.get(i.factor) || []), i]);
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const save = async (input) => {
    const checked = validateIntervention(input);
    if (!checked.ok) { setError(checked.reason); return false; }
    setError(null);
    await repository.saveIntervention(input, actor);
    return true;
  };

  async function add(e) {
    e.preventDefault();
    const duplicate = visible.some((i) => i.status === INTERVENTION_STATUS.ONGOING && i._pending !== 'DELETE'
      && i.factor === draft.factor && methodKey(i.method) === methodKey(draft.method));
    if (duplicate) {
      setError(`${profile.student.first_name} already has this under way for ${draft.factor}. Edit that one instead of adding it again.`);
      return;
    }
    const ok = await save(inputOf(actor.schoolId, studentId, { ...draft, intervention_id: ulid(), status: INTERVENTION_STATUS.ONGOING }));
    if (ok) setDraft(blank(draft.factor));
  }
  const stop = (i) => save(inputOf(actor.schoolId, studentId, i, { status: INTERVENTION_STATUS.STOPPED, stopped_on: today() }));
  const restart = (i) => save(inputOf(actor.schoolId, studentId, i, { status: INTERVENTION_STATUS.ONGOING, stopped_on: null }));
  async function saveEdit(i) {
    if (await save(inputOf(actor.schoolId, studentId, i, editing.value))) setEditing(null);
  }
  async function remove(i) {
    if (!window.confirm(`Delete "${i.method}"? It is removed from this student's record.`)) return;
    await repository.deleteIntervention(i, actor);
  }

  if (error && !profile) return <div className="stack"><Link to="/dashboard">Back</Link><div className="notice">{error}</div></div>;
  if (!profile || !draft) return <div className="hint">Loading…</div>;
  const target = selectedChanges(profile.targets) ?? [];
  // Methods this student already has under way for the chosen subject: shown as ongoing, not offered again.
  const ongoingKeys = new Set(visible.filter((i) => i.status === INTERVENTION_STATUS.ONGOING && i.factor === draft.factor && i._pending !== 'DELETE').map((i) => methodKey(i.method)));
  const use = (method) => { setDraft({ ...draft, method }); methodRef.current?.focus(); };

  const row = (i, actions) => (
    <li key={i.intervention_id} className={`intervention ${i._pending === 'DELETE' ? 'removed' : ''}`}>
      {editing?.id === i.intervention_id ? (
        <div className="stack">
          <Editor value={editing.value} onChange={(value) => setEditing({ ...editing, value })} idPrefix={`edit-${i.intervention_id}`} />
          <div className="actions">
            <button type="button" className="btn primary" onClick={() => saveEdit(i)}>Save changes</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div>
            <b>{i.method}</b> <span className="hint">{FREQUENCY_LABEL[i.frequency]} · since {i.started_on}{i.stopped_on ? ` · stopped ${i.stopped_on}` : ''}</span>
            {i.expected_outcome && <div className="hint">Expected: {i.expected_outcome}</div>}
            <SyncState i={i} onDiscard={() => repository.discardIntervention(i.intervention_id)} />
          </div>
          {i._pending !== 'DELETE' && <div className="actions">{actions}</div>}
        </>
      )}
    </li>
  );

  return (
    <div className="stack">
      <Link to={`/students/${studentId}/risk`} replace state={{ from: location.state?.from }}>Back to {profile.student.first_name}&apos;s risk profile</Link>
      <div className="form-split">
        <div className="stack">
          <div className="card stack">
            <h1>{profile.student.first_name} {profile.student.last_name}</h1>
            <h2 className="sub">Targets{profile.targets?.target_label ? ` for the ${profile.targets.target_label}` : ''}</h2>
            {target.length ? (
              <div className="chips">{target.map((c) => <span key={c.column} className="chip target">{targetText(c)}</span>)}</div>
            ) : (
              <div className="hint">
                {profile.targets?.status === 'MAINTAIN' ? 'Keeping the current results would already clear the next checkpoint.'
                  : profile.latest?.at_risk ? 'No targets for your subjects in the latest prediction.' : 'Not flagged at risk at the latest prediction.'}
              </div>
            )}
            {profile.targets?.status === 'FALLBACK' && <div className="hint">These targets come from comparable students&apos; progress and may not be enough on their own.</div>}
            <div className="hint">Targets show what the model would need to see. Which intervention to use is your decision.</div>
          </div>

          <form className="card stack" onSubmit={add}>
            <h2>Add an intervention</h2>
            <Editor value={draft} onChange={setDraft} factors={factors} idPrefix="new" methodRef={methodRef} />
            {error && <div className="warn" role="alert">{error}</div>}
            <div className="actions">
              <button type="submit" className="btn primary">Save intervention</button>
              {!online && <span className="hint">You are offline; it is kept on this device and sent when you reconnect.</span>}
            </div>
          </form>

          <section className="card stack">
            <h2>Ongoing</h2>
            {group(INTERVENTION_STATUS.ONGOING).length === 0 && <div className="hint">No ongoing interventions.</div>}
            {group(INTERVENTION_STATUS.ONGOING).map(([factor, list]) => (
              <div key={factor}>
                <h3 className="sub">{factor}</h3>
                <ul className="plain">
                  {list.map((i) => row(i, (
                    <>
                      <button type="button" className="btn secondary small icon-text" onClick={() => setEditing({ id: i.intervention_id, value: { ...i } })}
                        aria-label={`Edit “${i.method}”`}><ActionIcon name="edit" />Edit</button>
                      <button type="button" className="btn secondary small icon-text" onClick={() => stop(i)}
                        aria-label={`Stop “${i.method}”`}><ActionIcon name="stop" />Stop</button>
                      <DangerButton className="small icon-text" onClick={() => remove(i)} aria-label={`Delete “${i.method}”`}>
                        <ActionIcon name="trash" />Delete
                      </DangerButton>
                    </>
                  )))}
                </ul>
              </div>
            ))}
          </section>

          <section className="card stack">
            <h2>Stopped</h2>
            {group(INTERVENTION_STATUS.STOPPED).length === 0 && <div className="hint">No stopped interventions.</div>}
            {group(INTERVENTION_STATUS.STOPPED).map(([factor, list]) => (
              <div key={factor}>
                <h3 className="sub">{factor}</h3>
                <ul className="plain">
                  {list.map((i) => row(i, (
                    <>
                      <button type="button" className="btn secondary small icon-text" onClick={() => restart(i)}
                        aria-label={`Restart “${i.method}”`}><ActionIcon name="restore" />Restart</button>
                      <DangerButton className="small icon-text" onClick={() => remove(i)} aria-label={`Delete “${i.method}”`}>
                        <ActionIcon name="trash" />Delete
                      </DangerButton>
                    </>
                  )))}
                </ul>
              </div>
            ))}
          </section>
        </div>

        <MethodSuggestions factor={draft.factor} methods={methods} search={search} onSearch={setSearch}
          current={draft.method} onUse={use} ongoing={ongoingKeys} />
      </div>
    </div>
  );
}
