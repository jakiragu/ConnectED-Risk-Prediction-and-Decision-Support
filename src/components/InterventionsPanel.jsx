import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon } from './ui.jsx';
import { FREQUENCY_LABEL } from '@gradebook/domain/decision';

const PAGE_SIZE = 5; // students per page
const OPEN_KEY = 'connected:dashboard:interventions-open';
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'ONCE'];
const SHORT_FREQUENCY = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', ONCE: 'Once' };
const MINE = 'mine';
const ALL = 'all';

/** "2026-04-12" -> "12 Apr 2026", read as a calendar date so it never shifts a day by time zone. */
function day(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether the panel was left open on this device (open unless the teacher closed it). */
function savedOpen() {
  try { return localStorage.getItem(OPEN_KEY) !== 'closed'; } catch { return true; }
}

function Chevron({ open }) {
  return (
    <svg className={`intv-chevron${open ? ' open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 6.5 8 9.5 11 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "2 daily · 1 weekly" */
const frequencyLine = (list) => FREQUENCIES
  .map((f) => [f, list.filter((i) => i.frequency === f).length])
  .filter(([, n]) => n)
  .map(([f, n]) => `${n} ${SHORT_FREQUENCY[f].toLowerCase()}`)
  .join(' · ');

/**
 * The interventions under way that concern the teacher, grouped by student.
 *
 * Which interventions arrive is decided by the server: every subject in a
 * class the person is class teacher of, and only their own subjects in classes
 * where they teach a subject (whoever logged them). This panel only narrows
 * that set. A class teacher opens on the ones they logged themselves; a subject
 * teacher opens on everything for their subjects, because a class teacher may
 * have logged a Mathematics intervention the Mathematics teacher must follow.
 *
 * @param {{ items: object[], viewerIsClassTeacher: boolean }} props
 */
export default function InterventionsPanel({ items, viewerIsClassTeacher }) {
  const [owner, setOwner] = useState(viewerIsClassTeacher ? MINE : ALL);
  const [frequency, setFrequency] = useState(ALL);
  const [subject, setSubject] = useState(ALL);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(savedOpen);
  const [expanded, setExpanded] = useState(() => new Set()); // students whose interventions are shown
  const bodyId = useId();
  const toggleOpen = () => setOpen((o) => {
    try { localStorage.setItem(OPEN_KEY, o ? 'closed' : 'open'); } catch { /* private mode: not remembered */ }
    return !o;
  });
  const toggleStudent = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // The default follows the role once the dashboard knows it (a cached copy may arrive first).
  useEffect(() => { setOwner(viewerIsClassTeacher ? MINE : ALL); }, [viewerIsClassTeacher]);

  const mineCount = items.filter((i) => i.assigned_by_me).length;
  const byOwner = useMemo(() => (owner === MINE ? items.filter((i) => i.assigned_by_me) : items), [items, owner]);
  const subjects = useMemo(() => [...new Set(byOwner.map((i) => i.factor))].sort(), [byOwner]);
  const frequencyCounts = useMemo(() => {
    const counts = new Map(FREQUENCIES.map((f) => [f, 0]));
    for (const i of byOwner) if (subject === ALL || i.factor === subject) counts.set(i.frequency, (counts.get(i.frequency) || 0) + 1);
    return counts;
  }, [byOwner, subject]);

  const groups = useMemo(() => {
    const shown = byOwner.filter((i) => (frequency === ALL || i.frequency === frequency) && (subject === ALL || i.factor === subject));
    const map = new Map();
    for (const i of shown) {
      if (!map.has(i.student_id)) map.set(i.student_id, { student_id: i.student_id, name: i.student_name, admission_no: i.admission_no, class_name: i.class_name, items: [] });
      map.get(i.student_id).items.push(i);
    }
    const order = (i) => FREQUENCIES.indexOf(i.frequency);
    return [...map.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => order(a) - order(b) || a.factor.localeCompare(b.factor)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [byOwner, frequency, subject]);

  // A filter that no longer matches anything falls back to "all", and any change returns to page 1.
  useEffect(() => { if (subject !== ALL && !subjects.includes(subject)) setSubject(ALL); }, [subjects, subject]);
  useEffect(() => { setPage(1); }, [owner, frequency, subject]);

  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = groups.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const shownCount = groups.reduce((n, g) => n + g.items.length, 0);
  const filtered = frequency !== ALL || subject !== ALL;

  const pageIds = visible.map((g) => g.student_id);
  const allOpenOnPage = pageIds.length > 0 && pageIds.every((id) => expanded.has(id));
  const setPageOpen = (on) => setExpanded((prev) => {
    const next = new Set(prev);
    for (const id of pageIds) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const students = new Set(items.map((i) => i.student_id)).size;

  return (
    <section className={`card intv-panel${open ? ' is-open' : ''}`} aria-labelledby={`${bodyId}-title`}>
      {/* The heading's button opens and closes the section (keyboard and screen readers); the rest of
          the header is a larger click target for the mouse. Closed, the header still says what is under way. */}
      <div className="intv-toggle" onClick={toggleOpen}>
        <div className="intv-toggle-text">
          <h2 id={`${bodyId}-title`}>
            <button type="button" className="intv-title-btn" aria-expanded={open} aria-controls={bodyId}
              onClick={(e) => { e.stopPropagation(); toggleOpen(); }}>
              Interventions under way
            </button>
          </h2>
          <p className="intv-summary">
            {items.length === 0 ? (
              <span>None yet</span>
            ) : (
              <>
                <span className="intv-fact"><b>{items.length}</b> {items.length === 1 ? 'intervention' : 'interventions'}</span>
                <span className="intv-fact"><b>{students}</b> {students === 1 ? 'student' : 'students'}</span>
                <span className="intv-fact"><b>{mineCount}</b> assigned by you</span>
                {FREQUENCIES.filter((f) => items.some((i) => i.frequency === f)).map((f) => (
                  <span key={f} className={`intv-freq f-${f.toLowerCase()}`}>{items.filter((i) => i.frequency === f).length} {SHORT_FREQUENCY[f].toLowerCase()}</span>
                ))}
              </>
            )}
          </p>
        </div>
        <span className="intv-toggle-hint" aria-hidden="true">{open ? 'Hide' : 'Show'}<Chevron open={open} /></span>
      </div>

      {open && (
        <div id={bodyId} className="intv-body stack">
          {items.length === 0 ? (
            <div className="empty">
              <b>No interventions under way</b>
              <p>Log one from a flagged student below, or from a student&apos;s risk profile.</p>
            </div>
          ) : (
            <>
              <div className="intv-filters">
                <label className="field">
                  <span className="intv-filter-label">Assigned by</span>
                  <select aria-label="Whose interventions" value={owner} onChange={(e) => setOwner(e.target.value)}>
                    <option value={ALL}>Anyone ({items.length})</option>
                    <option value={MINE}>Me ({mineCount})</option>
                  </select>
                </label>
                <label className="field">
                  <span className="intv-filter-label">How often</span>
                  <select aria-label="How often" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                    <option value={ALL}>All frequencies ({byOwner.filter((i) => subject === ALL || i.factor === subject).length})</option>
                    {FREQUENCIES.filter((f) => frequencyCounts.get(f) > 0 || f === frequency).map((f) => (
                      <option key={f} value={f}>{SHORT_FREQUENCY[f]} ({frequencyCounts.get(f)})</option>
                    ))}
                  </select>
                </label>
                {subjects.length > 1 && (
                  <label className="field">
                    <span className="intv-filter-label">Subject</span>
                    <select aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
                      <option value={ALL}>All subjects</option>
                      {subjects.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                )}
              </div>

              {groups.length === 0 ? (
                <div className="empty">
                  {owner === MINE && !filtered ? (
                    <>
                      <b>You have not assigned any interventions under way</b>
                      <p>Interventions colleagues logged for your students are under Assigned by anyone.</p>
                      <button type="button" className="btn secondary" onClick={() => setOwner(ALL)}>Show interventions assigned by anyone</button>
                    </>
                  ) : (
                    <>
                      <b>No interventions match</b>
                      <p>Try another subject or frequency.</p>
                      <button type="button" className="btn secondary" onClick={() => { setFrequency(ALL); setSubject(ALL); }}>Clear filters</button>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="intv-listbar">
                    <span className="hint">{plural(shownCount, 'intervention')} for {plural(groups.length, 'student')}{owner === MINE ? ', assigned by you' : ''}</span>
                    <button type="button" className="btn link small" onClick={() => setPageOpen(!allOpenOnPage)}>
                      {allOpenOnPage ? 'Collapse all' : 'Expand all'}
                    </button>
                  </div>
                  <ul className="intv-groups">
                    {visible.map((g) => {
                      const isOpen = expanded.has(g.student_id);
                      const listId = `${bodyId}-${g.student_id}`;
                      const subjectsHere = [...new Set(g.items.map((i) => i.factor))];
                      return (
                        <li key={g.student_id} className={`intv-group${isOpen ? ' open' : ''}`}>
                          <div className="intv-student">
                            <button type="button" className="intv-student-toggle" aria-expanded={isOpen} aria-controls={listId}
                              onClick={() => toggleStudent(g.student_id)}>
                              <Chevron open={isOpen} />
                              <span className="intv-who">
                                <b>{g.name}</b>
                                <span className="hint">{[g.admission_no, g.class_name].filter(Boolean).join(' · ')}</span>
                              </span>
                              <span className="intv-glance">
                                <span className="intv-subjects">
                                  {subjectsHere.slice(0, 3).map((x) => <span key={x} className="chip">{x}</span>)}
                                  {subjectsHere.length > 3 && <span className="chip muted">+{subjectsHere.length - 3}</span>}
                                </span>
                                <span className="intv-count">{plural(g.items.length, 'intervention')} · {frequencyLine(g.items)}</span>
                              </span>
                            </button>
                            <Link to={`/students/${g.student_id}/risk`} state={{ from: '/dashboard' }} className="btn link student-quick-action intv-profile" title="Risk profile" aria-label={`Risk profile for ${g.name}`}>
                              <ActionIcon name="users" />
                            </Link>
                          </div>
                          {isOpen && (
                            <div id={listId} className="intv-detail">
                              <div className="intv-cols" aria-hidden="true">
                                <span>Intervention</span><span>Subject</span><span>How often</span><span>Since</span><span>Assigned by</span>
                              </div>
                              <ul className="intv-items">
                                {g.items.map((i) => (
                                  <li key={i.intervention_id} className="intv-item">
                                    <span className="intv-method">{i.method}</span>
                                    <span>{i.factor}</span>
                                    <span className={`intv-freq f-${i.frequency.toLowerCase()}`} title={FREQUENCY_LABEL[i.frequency]}>{SHORT_FREQUENCY[i.frequency]}</span>
                                    <span className="intv-since"><span className="intv-k">Since </span>{day(i.started_on)}</span>
                                    <span className={`intv-by${i.assigned_by_me ? ' me' : ''}`}>
                                      <span className="intv-k">Assigned by </span>{i.assigned_by_me ? 'Me' : (i.created_by_name || 'Unknown teacher')}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {pages > 1 && (
                    <nav className="intv-pages" aria-label="Interventions pages">
                      <span className="hint">
                        Students {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, groups.length)} of {groups.length}
                      </span>
                      <div className="intv-pager">
                        <button type="button" className="btn secondary" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button>
                        <span className="hint" aria-live="polite">Page {current} of {pages}</span>
                        <button type="button" className="btn secondary" disabled={current === pages} onClick={() => setPage(current + 1)}>Next</button>
                      </div>
                    </nav>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
