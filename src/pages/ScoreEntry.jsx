import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { validateEntry, normalize, isBlank, cellText, tokenStatus } from '@gradebook/domain/score';
import { checkpointOf, componentLabel } from '@gradebook/domain/assessment';
import { gql } from '../api/graphql.js';
import { SUBMIT_SCORES } from '../api/operations.js';
import { useAuth } from '../auth/AuthContext.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { Info, Notice, useToast } from '../components/ui.jsx';
import { db, scoreKey } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { isOnline } from '../offline/syncEngine.js';
import { STATUS, supersede } from '../offline/outbox.js';
import { useLive } from '../offline/useLive.js';
import { useSync } from '../offline/useSync.js';
import { afterEdit, finish, follow, isChanged, versionFor } from '../offline/scoreDrafts.js';
import { useCheckpointSetup } from '../offline/useCheckpointSetup.js';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges.js';

// A cell holds a number, ABS (absent) or NA (not assessed); see score.js.
const asText = (score) => cellText(score);
// The server lists a roster by admission number; the copy on this device is put in the same order.
const byAdmission = (a, b) => String(a.admission_no).localeCompare(String(b.admission_no), undefined, { numeric: true });

export default function ScoreEntry() {
  const { assessmentId } = useParams();
  const [params] = useSearchParams();
  const { actor } = useAuth();

  const [assessment, setAssessment] = useState(null);
  // The school's name for this assessment's exam.
  const setup = useCheckpointSetup(actor.schoolId, assessment?.term_id);
  const [roster, setRoster] = useState([]);
  const { online } = useSync();
  // Marks as this device holds them: the server's, plus any saved here and still waiting to be sent.
  // Live, so a mark changes from "Waiting to send" to "Saved" by itself once it reaches the server.
  const kept = useLive(() => db().scores.where('assessment_id').equals(assessmentId).toArray(), [assessmentId], []);
  const saved = useMemo(() => Object.fromEntries(kept.map((x) => [x.student_id, x])), [kept]);
  // This assessment's marks in the outbox: waiting, refused by the server, or held for a decision.
  const queued = useLive(
    () => db().outbox.where('entity').equals('Score').filter((e) => e.payload.assessment_id === assessmentId).toArray(),
    [assessmentId], []
  );
  const outboxFor = useMemo(() => Object.fromEntries(queued.map((e) => [e.payload.student_id, e])), [queued]);
  const [drafts, setDrafts] = useState({});
  // Rows being edited, with the server version each edit started from (see scoreDrafts.js).
  const [bases, setBases] = useState({});
  const basesNow = useRef(bases);
  basesNow.current = bases;
  // When the device copy changes, rows nobody is editing show it.
  useEffect(() => {
    setDrafts((d) => follow(d, basesNow.current, saved));
  }, [saved]);
  const [rowErrors, setRowErrors] = useState({});
  const [rowNotes, setRowNotes] = useState({});
  const [failure, setFailure] = useState(null);
  const [summary, setSummary] = useState(null);
  const [toast, showToast] = useToast();
  const [find, setFind] = useState('');
  const [saving, setSaving] = useState(false);
  const inputs = useRef([]);

  /**
   * Refresh this device's copy from the server when it can be reached, then show the device copy.
   * Offline, the page opens from what was saved here the last time it was opened.
   */
  const load = useCallback(async () => {
    await repository.loadAssessment(actor.schoolId, assessmentId);
    const a = await db().assessments.get(assessmentId);
    if (!a) {
      setFailure(isOnline()
        ? 'This assessment no longer exists.'
        : 'You are offline, and this assessment has not been opened on this device yet. Open it once while online to enter marks offline.');
      return;
    }
    await Promise.all([
      repository.loadRoster(actor.schoolId, a.class_id),
      repository.loadScores(actor.schoolId, assessmentId),
    ]);
    const students = (await db().students.where('class_id').equals(a.class_id).toArray()).sort(byAdmission);
    const marks = await db().scores.where('assessment_id').equals(assessmentId).toArray();
    const byStudent = Object.fromEntries(marks.map((x) => [x.student_id, x]));
    setAssessment(a);
    setRoster(students);
    setDrafts(Object.fromEntries(students.map((st) => [st.student_id, asText(byStudent[st.student_id])])));
    setBases({});
    setRowErrors({});
  }, [actor.schoolId, assessmentId]);

  useEffect(() => {
    load().catch((e) => setFailure(e.message));
  }, [load]);

  const rosterIds = useMemo(() => new Set(roster.map((s) => s.student_id)), [roster]);
  // Rows shown: the whole roster, or those matching the search. Unsaved marks live in drafts, so filtering keeps them.
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return q ? roster.filter((s) => `${s.first_name} ${s.last_name} ${s.admission_no}`.toLowerCase().includes(q)) : roster;
  }, [roster, find]);
  const classes = useLive(() => db().classes.toArray(), [], []);
  const isAdmin = actor.groups.includes('Admin');
  const teaches = isAdmin || (classes.find((c) => c.class_id === assessment?.class_id)?.my_subjects || []).includes(assessment?.subject);
  const readOnly = assessment?.status === 'LOCKED' || !teaches;

  const changed = useMemo(
    () => roster.filter((s) => isChanged(drafts[s.student_id], saved[s.student_id])),
    [roster, drafts, saved]
  );

  // Unsaved marks are protected from in-app navigation (Back, sidebar) as well as closing the tab.
  useUnsavedChanges(
    changed.length > 0,
    `${changed.length} mark${changed.length === 1 ? ' is' : 's are'} not saved yet. Leave this page and lose ${changed.length === 1 ? 'it' : 'them'}?`
  );

  function edit(studentId, value) {
    setDrafts((d) => ({ ...d, [studentId]: value }));
    setBases((b) => afterEdit(b, studentId, value, saved[studentId]));
    setRowNotes((n) => ({ ...n, [studentId]: undefined }));
    // ABS and NA are statuses, not scores: check them as the status they mean, as save() sends them.
    const status = tokenStatus(value);
    const check = validateEntry(status
      ? { student_id: studentId, raw_score: null, mark_status: status }
      : { student_id: studentId, raw_score: value }, { assessment, roster: rosterIds });
    setRowErrors((e) => ({ ...e, [studentId]: check.ok ? undefined : check.reason }));
  }

  function nextOnEnter(e, index) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    inputs.current.slice(index + 1).find((input) => input && !input.disabled)?.focus();
  }

  async function save() {
    setFailure(null);
    setSummary(null);
    const entries = changed
      .filter((s) => !rowErrors[s.student_id])
      .map((s) => {
        const draft = drafts[s.student_id];
        return {
          student_id: s.student_id,
          ...(tokenStatus(draft)
            ? { raw_score: null, mark_status: tokenStatus(draft) }
            : { raw_score: isBlank(draft) ? null : Number(draft) }),
          _version: versionFor(bases, saved, s.student_id),
        };
      });
    if (!entries.length) return;

    setSaving(true);
    try {
      // Marks of this assessment already waiting to be sent go first; new ones join them so they arrive in order.
      const waiting = queued.some((e) => e.status === STATUS.PENDING || e.status === STATUS.SENDING);
      let unreachable = !isOnline();
      if (!unreachable && !waiting) {
        try {
          await submitNow(entries);
          return;
        } catch (e) {
          if (e.errorType !== 'Network') throw e;
          unreachable = true; // the server could not be reached after all: keep the marks on this device instead
        }
      }
      for (const entry of entries) {
        await repository.saveScore({
          schoolId: actor.schoolId,
          assessment,
          studentId: entry.student_id,
          rawScore: entry.raw_score,
          markStatus: entry.mark_status ?? null,
          version: entry._version,
          actor,
        });
      }
      setBases((b) => finish(b, entries.map((e) => e.student_id)));
      const n = entries.length;
      showToast(!unreachable
        ? `Sending ${n} mark${n === 1 ? '' : 's'}…`
        : `Saved ${n} mark${n === 1 ? '' : 's'} on this device. ${n === 1 ? 'It is' : 'They are'} sent when you reconnect.`);
    } catch (e) {
      setFailure(e.message);
    } finally {
      setSaving(false);
    }
  }

  /** Online: send at once, so rejected marks and conflicts come back to the rows straight away. */
  async function submitNow(entries) {
    const { submitScores: res } = await gql(SUBMIT_SCORES, {
      input: { school_id: actor.schoolId, assessment_id: assessmentId, entries },
    });
    const nextDrafts = { ...drafts };
    const nextErrors = { ...rowErrors };
    const nextNotes = {};
    const done = [];
    for (const r of res.results) {
      if (r.outcome === 'REJECTED') {
        nextErrors[r.student_id] = r.reason; // the draft stays, so it can be fixed
        continue;
      }
      // The device copy takes the server's answer; the row then shows it (see follow).
      const id = scoreKey(assessmentId, r.student_id);
      if (r.item) await db().scores.put({ ...r.item, id });
      else await db().scores.delete(id);
      await supersede(id); // an earlier offline change to this mark that the server refused is now replaced
      nextDrafts[r.student_id] = asText(r.item); // the row now shows what the server holds
      if (r.outcome === 'CONFLICT') nextNotes[r.student_id] = r.reason;
      done.push(r.student_id);
    }
    setBases((b) => finish(b, done));
    setDrafts(nextDrafts);
    setRowErrors(nextErrors);
    setRowNotes(nextNotes);
    // A clean save is confirmed briefly; rejected, conflicted or held marks stay on screen.
    if (res.rejected || res.conflicted || res.review) setSummary(res);
    else showToast(`Saved ${res.accepted} mark${res.accepted === 1 ? '' : 's'}`);
    const a = await repository.loadAssessment(actor.schoolId, assessmentId);
    if (a) setAssessment(a);
  }

  if (!assessment) {
    return failure ? <div className="card error-card">{failure}</div> : <p className="hint">Loading…</p>;
  }

  const entered = Object.keys(saved).length;
  const invalid = changed.filter((s) => rowErrors[s.student_id]).length;

  return (
    <>
      <div className="page-head">
        <Link to={`/assessments?class=${params.get('class') || assessment.class_id}&term=${assessment.term_id}`}>Back</Link>
        <h1>{assessment.title}</h1>
        <StatusPill status={assessment.status} />
      </div>

      <div className="budget-row">
        <span>{assessment.subject}</span>
        <span>
          {setup.label(checkpointOf(assessment.assessment_type))}
          {assessment.paper_no ? ` · ${componentLabel(assessment)} ${assessment.paper_no}` : ''} · {assessment.weight}%
        </span>
        <span>Marked out of <b>{assessment.max_score}</b></span>
        <Info label="Entering marks">Enter a mark or choose Absent or Not assessed. Choose Mark to enter a number again. Marks save when you press Save.</Info>
        <span><b>{entered}</b> of {roster.length} entered</span>
        {changed.length > 0 && <span><b>{changed.length}</b> unsaved</span>}
      </div>

      {failure && <Notice tone="error">{failure}</Notice>}
      {!online && !readOnly && (
        <Notice tone="warn">You are offline. Marks you save are kept on this device and sent when you reconnect.</Notice>
      )}
      {readOnly && (
        <div className="notice warn">
          {!teaches
            ? `You do not teach ${assessment.subject} in this class, so these marks are view-only.`
            : (assessment.published_in || []).length
              ? 'Published results include this paper. Marks can be viewed but not changed.'
              : 'This assessment is locked. Marks can be viewed but not changed.'}
        </div>
      )}
      {summary && (
        <Notice tone="warn">
          Saved {summary.accepted}
          {summary.rejected > 0 && `; ${summary.rejected} rejected (see the rows marked below)`}
          {summary.conflicted > 0 && `; ${summary.conflicted} changed by someone else`}
          {summary.review > 0 && `; ${summary.review} held for a decision because another teacher entered a different mark`}.
        </Notice>
      )}
      {toast}

      <div className="table-wrap">
        <div className="toolbar table-tools">
          <input type="search" aria-label="Find a student" placeholder="Find a student by name or admission number"
            value={find} onChange={(e) => setFind(e.target.value)} />
          {find.trim() && <span className="hint">Showing {shown.length} of {roster.length}</span>}
        </div>
        <table className="score-table">
          <thead>
            <tr>
              <th>Adm. no</th><th>Student</th><th>Mark</th><th>%</th><th>State</th>
            </tr>
          </thead>
          <tbody>
            {roster.length === 0 && (
              <tr className="empty"><td colSpan={5}>No students are enrolled in this class.</td></tr>
            )}
            {shown.length === 0 && roster.length > 0 && (
              <tr className="empty"><td colSpan={5}>No student matches “{find.trim()}”.</td></tr>
            )}
            {shown.map((s, i) => {
              const draft = drafts[s.student_id] ?? '';
              const status = tokenStatus(draft);
              const err = rowErrors[s.student_id];
              const note = rowNotes[s.student_id];
              const dirty = isChanged(draft, saved[s.student_id]);
              const waiting = outboxFor[s.student_id];
              const pct = !err && !isBlank(draft) && !tokenStatus(draft) ? normalize(Number(draft), assessment.max_score) : null;
              return (
                <tr key={s.student_id} className={err ? 'row-error' : dirty ? 'row-dirty' : ''}>
                  <td>{s.admission_no}</td>
                  <td>{s.first_name} {s.last_name}</td>
                  <td>
                    <div className="mark-control">
                      <input
                        ref={(el) => (inputs.current[i] = el)}
                        className="mark-input"
                        type="number"
                        min="0"
                        max={assessment.max_score}
                        step="0.5"
                        value={status ? '' : draft}
                        disabled={readOnly || Boolean(status)}
                        aria-invalid={Boolean(err)}
                        aria-label={`Mark for ${s.first_name} ${s.last_name}`}
                        onChange={(e) => edit(s.student_id, e.target.value)}
                        onKeyDown={(e) => nextOnEnter(e, i)}
                      />
                      <span className="hint"> / {assessment.max_score}</span>
                      <select
                        value={status ? draft : ''}
                        disabled={readOnly}
                        aria-label={`Mark status for ${s.first_name} ${s.last_name}`}
                        onChange={(e) => edit(s.student_id, e.target.value)}
                      >
                        <option value="">Mark</option>
                        <option value="ABS">Absent</option>
                        <option value="NA">Not assessed</option>
                      </select>
                    </div>
                  </td>
                  <td>{pct === null ? '—' : `${pct}%`}</td>
                  <td>
                    {err ? <span className="error">{err}</span>
                      : note ? <span className="warn">{note}</span>
                      : dirty ? <span className="warn">Unsaved</span>
                      : waiting?.status === STATUS.FAILED ? <span className="error">Not saved: {waiting.reason}</span>
                      : waiting?.status === STATUS.CONFLICT ? <span className="warn">{waiting.reason}</span>
                      : waiting ? <span className="warn">Waiting to send</span>
                      : saved[s.student_id]?.status === 'CONFLICT_REVIEW'
                        ? <span className="warn">Waiting for a decision: {asText(saved[s.student_id])} or {asText({
                          raw_score: saved[s.student_id].conflict_with_score, mark_status: saved[s.student_id].conflict_with_mark_status,
                        }) || 'no mark'}</span>
                      : saved[s.student_id] ? <span className="ok">Saved</span>
                      : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <div className="page-head">
          <button className="btn" type="button" onClick={save} disabled={saving || changed.length === invalid}>
            {saving ? 'Saving' : 'Save marks'}
          </button>
          {invalid > 0 && <span className="error">{invalid} mark{invalid === 1 ? ' needs' : 's need'} fixing before {invalid === 1 ? 'it' : 'they'} can be saved</span>}
        </div>
      )}
    </>
  );
}