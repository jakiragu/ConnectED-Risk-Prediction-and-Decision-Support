import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  STATUS, assessmentTemplate, checkAssessmentRows, checkScoreRows, checkStudentRows, markSheet, parseCsv, studentTemplate, tally,
} from '@gradebook/domain/csvImport';
import { COMPONENT_LABEL, checkpointOf, componentTypeOf } from '@gradebook/domain/assessment';
import { MAX_BATCH } from '@gradebook/domain/score';
import { labelOf } from '@gradebook/domain/results';
import { ulid } from '@gradebook/domain/ids';
import { gql } from '../api/graphql.js';
import { LIST_TERMS_FULL } from '../api/calendarOperations.js';
import {
  CREATE_ASSESSMENT, CREATE_STUDENT, LIST_ASSESSMENTS_PAGE, LIST_SCHOOL_CLASSES, LIST_STUDENTS, SUBMIT_SCORES, SYNC_SCORES,
  UPDATE_STUDENT,
} from '../api/operations.js';
import { db } from '../offline/db.js';
import { repository } from '../offline/repository.js';
import { useCheckpointSetup } from '../offline/useCheckpointSetup.js';
import { Field, Select } from './Field.jsx';
import { ActionIcon, Notice, Progress } from './ui.jsx';

/**
 * Setting a school up from CSV files: students, then the term's assessments,
 * then marks. Choosing a file writes nothing: every row is checked against what
 * the school already has and shown with its result. Import then sends the ready
 * rows through the same calls the forms and the mark grid use, a few at a time.
 * Rows that are already in place are skipped, so an interrupted import is
 * finished by choosing the same file again.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PARALLEL = 4;
const SHOWN = 200;
/** These mean the request may never have reached the server: stop rather than fail every remaining row. */
const CONNECTION = ['Network', 'Timeout', 'Transport'];
const UNSURE = 'The connection dropped while this was sent. Import the file again to finish; what was saved is skipped.';
const DISCARD = 'Discard the file you have not imported yet?';

const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Runs fn over items, at most `limit` at once, until stop() says otherwise. */
async function eachLimited(items, limit, fn, stop) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next;
      next += 1;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** An import that creates one record per ready row (students, assessments). */
const oneByOne = (create) => async (todo, { report, halt, halted }) => {
  await eachLimited(todo, PARALLEL, async ({ row, index }) => {
    try {
      await create(row.input);
      report(index, { state: 'done' });
    } catch (e) {
      if (CONNECTION.includes(e.errorType)) {
        halt(e.message);
        report(index, { state: 'unsure', message: UNSURE });
      } else {
        report(index, { state: 'failed', message: e.message });
      }
    }
  }, halted);
};

/** What a row shows: its check result, or what happened when it was imported. */
function shownStatus(row, outcome, words) {
  if (outcome?.state === 'done') return { key: 'ready', pill: 'recorded', text: words.done, icon: 'check', message: row.message };
  if (outcome?.state === 'failed') return { key: 'error', pill: 'unrecorded', text: words.failed, message: outcome.message };
  if (outcome?.state === 'unsure') return { key: 'ready', pill: 'recording', text: 'Check', message: outcome.message };
  if (row.status === STATUS.SKIP) return { key: 'skip', pill: 'neutral', text: words.skip, message: row.message };
  if (row.status === STATUS.ERROR) return { key: 'error', pill: 'unrecorded', text: 'Fix', message: row.message };
  return { key: 'ready', pill: 'recorded', text: 'Ready', message: row.message };
}

/**
 * What the file must look like: one line per column, with an example value.
 * columns: [{ name, needed, about, example }]
 */
function ColumnGuide({ columns, sample, tip, open, onToggle }) {
  return (
    <details className="card settings-card column-guide" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary><h3>What the file should look like</h3></summary>
      <p className="hint">
        A CSV file (in Excel or Google Sheets: Save as or Download as CSV), whose first row holds the column names below,
        in any order. Capitals and spaces in names and values do not matter.
      </p>
      <div className="table-wrap bordered">
        <table className="column-table">
          <thead>
            <tr><th scope="col">Column</th><th scope="col">Needed</th><th scope="col">What goes in it</th><th scope="col">Example</th></tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name}>
                <td>{c.literal === false ? c.name : <code>{c.name}</code>}</td>
                <td>{c.needed ? 'Required' : <span className="hint">Optional</span>}</td>
                <td>{c.about}</td>
                <td className="example">{c.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sample && (
        <>
          <h4 className="sample-head">Example</h4>
          <div className="table-wrap bordered">
            <table className="sample-table">
              <thead><tr>{sample[0].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {sample.slice(1).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tip && <p className="hint">{tip}</p>}
    </details>
  );
}

/**
 * One import: what the file needs, a file picker, the checked rows, and the import itself.
 *   loadContext()            what the rows are checked against; reloaded when it changes
 *   check(parsed, ctx)       → { problem, rows, warnings? } (see csvImport.js)
 *   importRows(todo, tools)  sends the ready rows, calling tools.report(index, outcome) for each
 *   template()               → the CSV text of the starting file
 *   words                    { noun, nouns, verb, done, skip, failed, button, warningTitle, templateButton }
 */
function CsvImporter({
  title, intro, guide, sample, tip, controls, templateName, template, loadContext, check, importRows, columns, cells, words,
  onFinished, onDirtyChange, ready = true,
}) {
  const [file, setFile] = useState(null);
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const [progress, setProgress] = useState(null);
  const [stopped, setStopped] = useState(null);
  const [finished, setFinished] = useState(false);
  const [filter, setFilter] = useState('all');
  const [guideOpen, setGuideOpen] = useState(true);
  const [preparing, setPreparing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setContext(await loadContext());
    } catch (e) {
      setError(e.message);
      setContext(null);
    } finally {
      setLoading(false);
    }
  }, [loadContext]);

  // A file is checked against fresh data.
  useEffect(() => { if (file && ready) reload(); }, [file, ready, reload]);

  const result = useMemo(() => (file && context ? check(file.parsed, context) : null), [file, context, check]);
  const rows = result?.rows || [];
  const counts = tally(rows);
  const running = Boolean(progress) && !finished;
  const dirty = running || (counts.ready > 0 && !finished);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // Open on the rows that need attention, if there are any; fold the column guide away once a file is in.
  useEffect(() => {
    setFilter(counts.error ? 'error' : 'all');
    if (result && !result.problem) setGuideOpen(false);
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    setOutcomes({});
    setProgress(null);
    setStopped(null);
    setFinished(false);
    setContext(null);
    setError(null);
  }

  async function choose(e) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (dirty && !window.confirm(DISCARD)) return;
    reset();
    if (picked.size > MAX_FILE_BYTES) {
      setFile(null);
      setError(`${picked.name} is larger than 2 MB. Split it into smaller files.`);
      return;
    }
    try {
      setFile({ name: picked.name, parsed: parseCsv(await picked.text()) });
    } catch {
      setFile(null);
      setError(`${picked.name} could not be read. Save it as CSV (comma-separated) and choose it again.`);
    }
  }

  async function downloadTemplate() {
    setPreparing(true);
    try {
      download(templateName, await template());
    } catch (e) {
      setError(e.message);
    } finally {
      setPreparing(false);
    }
  }

  function startOver() {
    reset();
    setFile(null);
    setGuideOpen(true);
  }

  async function run() {
    const todo = rows.map((row, index) => ({ row, index })).filter((r) => r.row.status === STATUS.READY);
    const results = {};
    let halted = null;
    let done = 0;
    setStopped(null);
    setProgress({ done: 0, total: todo.length });
    await importRows(todo, {
      report(index, outcome) {
        results[index] = outcome;
        done += 1;
        setProgress({ done, total: todo.length });
        setOutcomes({ ...results });
      },
      halt(message) { halted = halted || message; },
      halted: () => Boolean(halted),
    });
    setStopped(halted);
    setFinished(true);
    await onFinished?.();
  }

  const shown = rows.map((row, index) => ({ row, index, view: shownStatus(row, outcomes[index], words) }));
  const filtered = filter === 'all' ? shown : shown.filter((r) => r.view.key === filter);
  const filterCount = (id) => (id === 'all' ? shown.length : shown.filter((r) => r.view.key === id).length);
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'ready', label: finished ? words.done : 'Ready' },
    { id: 'skip', label: words.skip },
    { id: 'error', label: 'To fix' },
  ];
  const saved = Object.values(outcomes).filter((o) => o.state === 'done').length;
  const failed = Object.values(outcomes).filter((o) => o.state === 'failed').length;
  const notSent = progress ? progress.total - progress.done : 0;
  const lines = file?.parsed.rows.length || 0;

  return (
    <div className="stack">
      <div className="card settings-card">
        <h2>{title}</h2>
        <p className="hint">{intro}</p>
        {controls}
        <div className="row">
          <label className={`btn secondary file-pick${running ? ' disabled' : ''}`}>
            {file ? 'Choose another file' : 'Choose CSV file'}
            <input type="file" accept=".csv,text/csv" className="sr-only" disabled={running || !ready} onChange={choose} />
          </label>
          <button type="button" className="btn link small icon-text" disabled={preparing || !ready} onClick={downloadTemplate}>
            <ActionIcon name="download" /> {preparing ? 'Preparing…' : words.templateButton}
          </button>
          {file && <span className="hint">{file.name}</span>}
        </div>
      </div>

      <ColumnGuide columns={guide} sample={sample} tip={tip} open={guideOpen} onToggle={setGuideOpen} />

      {error && <Notice tone="error">{error}</Notice>}
      {file && loading && <p className="hint" role="status">Checking {file.name}…</p>}
      {result?.problem && <Notice tone="error">{result.problem}</Notice>}

      {result && !result.problem && (
        <>
          {finished && !stopped && (
            <Notice tone={failed ? 'warn' : 'success'}>
              {`${words.done} ${count(saved, words.noun, words.nouns)}.`}
              {counts.skip > 0 && ` Skipped ${count(counts.skip, 'row')} (${words.skip.toLowerCase()}).`}
              {failed > 0 && ` ${count(failed, 'row')} could not be ${words.verb}; the reason is on each row under To fix.`}
            </Notice>
          )}
          {stopped && (
            <Notice tone="error">
              {`The import stopped (${stopped}). ${words.done} ${count(saved, words.noun, words.nouns)}`}
              {notSent > 0 && `; ${count(notSent, 'row')} ${notSent === 1 ? 'was' : 'were'} not sent`}
              . Choose the same file again when you are back online; what was already saved is skipped.
            </Notice>
          )}
          {!finished && result.warnings?.length > 0 && (
            <Notice tone="warn">
              <b>{words.warningTitle}</b>
              <ul className="import-warnings">
                {result.warnings.slice(0, 5).map((w) => <li key={w}>{w}</li>)}
              </ul>
              {result.warnings.length > 5 && <span>and {result.warnings.length - 5} more.</span>}
            </Notice>
          )}

          <div className="card settings-card">
            <div className="settings-section-head">
              <h3>{finished ? 'What was imported' : 'Check before importing'}</h3>
              <span className="hint">
                {count(lines, 'line')} in {file.name}
                {rows.length !== lines && `, ${rows.length.toLocaleString()} rows once forms are split into classes`}
              </span>
            </div>
            <div className="segmented" role="group" aria-label="Show rows">
              {filters.map((f) => (
                <button key={f.id} type="button" className={`seg${filter === f.id ? ' active' : ''}`} aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}>
                  {f.label} <span className="pill neutral">{filterCount(f.id)}</span>
                </button>
              ))}
            </div>
            <div className="table-wrap bordered import-table">
              <table>
                <thead>
                  <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}<th scope="col">Result</th></tr>
                </thead>
                <tbody>
                  {filtered.slice(0, SHOWN).map(({ row, index, view }) => (
                    <tr key={index}>
                      {cells(row).map((c, i) => <td key={i}>{c}</td>)}
                      <td className="import-result">
                        <span className={`pill ${view.pill}`}>{view.icon && <ActionIcon name={view.icon} />}{view.text}</span>
                        {view.message && <span className="hint">{view.message}</span>}
                      </td>
                    </tr>
                  ))}
                  {!filtered.length && (
                    <tr><td className="hint" colSpan={columns.length + 1}>No rows here.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {filtered.length > SHOWN && (
              <p className="hint">Showing the first {SHOWN} of {filtered.length.toLocaleString()}. Use the filters above to narrow the list.</p>
            )}
          </div>

          <div className={`card settings-card save-bar${dirty ? ' dirty' : ''}`}>
            <div className="grow">
              {running && <Progress done={progress.done} total={progress.total} label={`Importing ${progress.done} of ${progress.total}`} />}
              {!running && finished && <div className="hint">Done. Choose another file to import more.</div>}
              {!running && !finished && counts.error > 0 && (
                <div className="warn">
                  {`${count(counts.error, 'row')} ${counts.error === 1 ? 'needs' : 'need'} fixing. Correct ${counts.error === 1 ? 'it' : 'them'} in your file and choose it again; nothing has been imported yet.`}
                </div>
              )}
              {!running && !finished && !counts.error && counts.ready > 0 && (
                <div className="hint">
                  {`${count(counts.ready, words.noun, words.nouns)} ready`}
                  {counts.skip > 0 && `; ${count(counts.skip, 'row')} will be skipped (${words.skip.toLowerCase()})`}.
                </div>
              )}
              {!running && !finished && !counts.error && !counts.ready && <div className="hint">Nothing in this file needs importing.</div>}
            </div>
            {finished ? (
              <button type="button" className="btn secondary" onClick={startOver}>Import another file</button>
            ) : (
              <button type="button" className="btn" disabled={running || loading || counts.error > 0 || !counts.ready} onClick={run}>
                {running ? 'Importing…' : words.button(counts.ready)}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ shared loads

const loadClasses = (schoolId) => gql(LIST_SCHOOL_CLASSES, { school_id: schoolId }).then((d) => d.listSchoolClasses);
const currentOf = (classes) => classes.filter((c) => c.status === 'CURRENT');

async function allAssessments(schoolId, classId, termId) {
  const items = [];
  let nextToken = null;
  do {
    const { listAssessmentsByClass: page } = await gql(LIST_ASSESSMENTS_PAGE, {
      school_id: schoolId, class_id: classId, term_id: termId, limit: 100, nextToken,
    });
    items.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}

/** Every mark saved for a class (all of its assessments), in pages. */
async function allScores(schoolId, classId) {
  const items = [];
  let nextToken = null;
  do {
    const { syncScores: page } = await gql(SYNC_SCORES, { school_id: schoolId, class_id: classId, lastSync: 0, nextToken });
    items.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return items.filter((s) => !s._deleted);
}

/** The school's terms, newest first, with the current one chosen. */
function useTermChoice(schoolId) {
  const [terms, setTerms] = useState([]);
  const [termId, setTermId] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    gql(LIST_TERMS_FULL, { school_id: schoolId }).then(({ listTerms }) => {
      const sorted = [...listTerms].sort((a, b) => (b.academic_year - a.academic_year) || (b.term_number - a.term_number));
      setTerms(sorted);
      setTermId((id) => id || (sorted.find((t) => t.status === 'CURRENT') ?? sorted[0])?.term_id || '');
    }).catch((e) => setError(e.message));
  }, [schoolId]);
  const options = terms.map((t) => ({ value: t.term_id, label: `${t.name}${t.status === 'CURRENT' ? ' (current)' : ''}` }));
  return { termId, setTermId, options, error };
}

/** A choice that asks before throwing away a checked file. */
const guarded = (dirty, setDirty, set) => (v) => {
  if (!dirty || window.confirm(DISCARD)) {
    setDirty(false);
    set(v);
  }
};

// ---------------------------------------------------------------- students

const STUDENT_GUIDE = [
  { name: 'admission_no', needed: true, about: 'The admission number: letters, digits, / and - only, up to 20 characters. Each student has their own.', example: '4512' },
  { name: 'first_name', needed: true, about: 'The student’s first name.', example: 'Amina' },
  { name: 'last_name', needed: true, about: 'The student’s last name.', example: 'Wanjiru' },
  { name: 'class', needed: true, about: 'The name of a current class, as on the Classes page.', example: 'Form 1 East' },
  { name: 'guardian_name', needed: false, about: 'The parent or guardian who receives results by SMS.', example: 'Grace Wanjiru' },
  { name: 'guardian_phone', needed: false, about: 'Their mobile number: 0712 345 678, or +256… for another country. For a student already in ConnectED, this adds or updates the number.', example: '0712 345 678' },
];

const STUDENT_SAMPLE = [
  ['admission_no', 'first_name', 'last_name', 'class', 'guardian_name', 'guardian_phone'],
  ['4512', 'Amina', 'Wanjiru', 'Form 1 East', 'Grace Wanjiru', '0712 345 678'],
  ['4513', 'Brian', 'Otieno', 'Form 1 West', '', ''],
];

function StudentImport({ schoolId, onDirtyChange }) {
  const loadContext = useCallback(async () => {
    const classes = await loadClasses(schoolId);
    // Admission numbers are unique across the school, so every current roster is read, leavers included.
    const rosters = await Promise.all(currentOf(classes).map((c) =>
      gql(LIST_STUDENTS, { school_id: schoolId, class_id: c.class_id, include_inactive: true }).then((d) => d.listStudents)));
    return { classes, students: rosters.flat() };
  }, [schoolId]);

  // A row for a student already there carries student_id: it only adds their parent contact.
  const importRows = useMemo(() => oneByOne((input) => gql(input.student_id ? UPDATE_STUDENT : CREATE_STUDENT, {
    input: { school_id: schoolId, ...input },
  })), [schoolId]);
  const template = useCallback(async () => studentTemplate(await loadClasses(schoolId).catch(() => [])), [schoolId]);
  const refresh = useCallback(() => repository.loadClasses(schoolId).catch(() => {}), [schoolId]);

  return (
    <CsvImporter
      title="Students"
      intro="Add the students of every class at once. Create the classes first, on the Classes page; a student already in ConnectED (same admission number and name) is skipped, unless the file brings a new parent phone number for them."
      guide={STUDENT_GUIDE}
      sample={STUDENT_SAMPLE}
      tip="The template has these columns and two example rows that use one of your classes. Replace the examples with your students; the guardian columns can stay empty."
      templateName="students-template.csv"
      template={template}
      loadContext={loadContext}
      check={checkStudentRows}
      importRows={importRows}
      onFinished={refresh}
      onDirtyChange={onDirtyChange}
      words={{
        noun: 'student', nouns: 'students', verb: 'added', done: 'Added', skip: 'Already there', failed: 'Not added',
        templateButton: 'Download template', warningTitle: 'Worth checking',
        button: (n) => `Import ${count(n, 'student')}`,
      }}
      columns={['Line', 'Admission no.', 'Name', 'Class', 'Guardian phone']}
      cells={(r) => [r.line, r.cells.admission_no, `${r.cells.first_name} ${r.cells.last_name}`.trim(), r.cells.class, r.cells.guardian_phone || '—']}
    />
  );
}

// ------------------------------------------------------------- assessments

const ASSESSMENT_GUIDE = [
  { name: 'class', needed: true, about: 'A current class, or a form to set up the same paper in every class of that form.', example: 'Form 3 East or Form 3' },
  { name: 'subject', needed: true, about: 'One of the school’s subjects (see Subjects).', example: 'Mathematics' },
  { name: 'exam', needed: true, about: 'An exam the chosen term holds, by its name.', example: 'Mid-term' },
  { name: 'component', needed: false, about: 'Paper, CAT, Quiz, Practical or Project. Empty means Paper.', example: 'Paper' },
  { name: 'number', needed: true, about: 'Which paper, CAT and so on: 1 to 8. Numbers start again for each component.', example: '1' },
  { name: 'weight', needed: true, about: 'Its share of the subject’s exam, in percent. The components of one exam add up to 100.', example: '50' },
  { name: 'max_score', needed: true, about: 'The mark it is out of.', example: '100' },
  { name: 'due_date', needed: false, about: 'When marks are due: year-month-day, or day/month/year as Excel shows it.', example: '14/03/2026' },
  { name: 'title', needed: false, about: 'Its name. Empty gives the usual name, such as Mathematics Mid-term Paper 1.', example: '' },
];

const ASSESSMENT_SAMPLE = [
  ['class', 'subject', 'exam', 'component', 'number', 'weight', 'max_score', 'due_date', 'title'],
  ['Form 3', 'Mathematics', 'Mid-term', 'Paper', '1', '50', '100', '', ''],
  ['Form 3', 'Mathematics', 'Mid-term', 'Paper', '2', '50', '100', '', ''],
  ['Form 3 East', 'English', 'End-term', 'CAT', '1', '30', '30', '14/03/2026', 'Composition CAT'],
];

function AssessmentImport({ schoolId, onDirtyChange }) {
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const terms = useTermChoice(schoolId);
  const { termId } = terms;
  const setup = useCheckpointSetup(schoolId, termId);

  const loadContext = useCallback(async () => {
    const classes = await loadClasses(schoolId);
    const current = currentOf(classes);
    const lists = await Promise.all(current.map((c) => allAssessments(schoolId, c.class_id, termId)));
    return { classes, existing: new Map(current.map((c, i) => [c.class_id, lists[i]])) };
  }, [schoolId, termId]);

  const heldKey = setup.checkpoints.join(',');
  const labelsKey = JSON.stringify(setup.labels);
  const check = useCallback(
    (parsed, ctx) => checkAssessmentRows(parsed, { ...ctx, checkpoints: setup.checkpoints, labels: setup.labels }),
    [heldKey, labelsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const importRows = useMemo(() => oneByOne(async (input) => {
    const { createAssessment } = await gql(CREATE_ASSESSMENT, {
      input: { ...input, assessment_id: ulid(), school_id: schoolId, term_id: termId, due_date: input.due_date || null },
    });
    await db().assessments.put(createAssessment); // the Assessments page shows it straight away, offline too
  }), [schoolId, termId]);

  const template = useCallback(async () => assessmentTemplate(await loadClasses(schoolId).catch(() => [])), [schoolId]);
  const exam = (r) => (r.input ? labelOf(r.input.assessment_type, setup.labels) : r.cells.exam);
  const component = (r) => (r.input ? `${COMPONENT_LABEL[componentTypeOf(r.input)]} ${r.input.paper_no}` : `${r.cells.component || 'Paper'} ${r.cells.number}`);

  return (
    <CsvImporter
      key={termId}
      title="Assessments"
      intro="Set up the papers, CATs and other components of a term’s exams for many classes at once. Choose the term first; components already set up are skipped."
      controls={(
        <>
          {terms.error && <Notice tone="error">{terms.error}</Notice>}
          <Field label="Term" htmlFor="import-term" hint={setup.ready && termId ? `Exams this term: ${setup.checkpoints.map((c) => setup.label(c)).join(', ')}` : undefined}>
            <Select id="import-term" value={termId} onChange={guarded(dirty, setDirty, terms.setTermId)} placeholder="Choose a term" options={terms.options} />
          </Field>
        </>
      )}
      guide={ASSESSMENT_GUIDE}
      sample={ASSESSMENT_SAMPLE}
      tip="One row per component. The template sets up Mathematics and English for one form; copy its rows for your other subjects and forms."
      ready={Boolean(termId) && setup.ready}
      templateName="assessments-template.csv"
      template={template}
      loadContext={loadContext}
      check={check}
      importRows={importRows}
      onDirtyChange={setDirty}
      words={{
        noun: 'assessment', nouns: 'assessments', verb: 'created', done: 'Created', skip: 'Already there', failed: 'Not created',
        templateButton: 'Download template', warningTitle: 'Some exams will not add up to 100%. That is allowed, and the rest can be added later, but check it is what you meant:',
        button: (n) => `Import ${count(n, 'assessment')}`,
      }}
      columns={['Line', 'Class', 'Subject', 'Exam', 'Component', 'Weight', 'Out of']}
      cells={(r) => [
        r.line,
        r.className || r.cells.class,
        r.input?.subject || r.cells.subject,
        exam(r),
        component(r),
        r.input ? `${r.input.weight}%` : r.cells.weight && `${r.cells.weight.replace(/%$/, '')}%`,
        r.input ? r.input.max_score : r.cells.max_score,
      ]}
    />
  );
}

// ------------------------------------------------------------------- marks

const MARK_GUIDE = [
  { name: 'admission_no', needed: true, about: 'Finds the student, in whichever current class they are in.', example: '3101' },
  { name: 'name, class', needed: false, about: 'For reading the sheet. A class that is not the student’s own is flagged, so marks never land on the wrong student.', example: 'Brian Otieno, Form 3 East' },
  { name: 'One per paper', literal: false, needed: true, about: 'One column per paper of the chosen exam, named as it is set up, such as Mathematics Paper 1 or English CAT 2. In each cell: the mark, ABS for absent or NA for not assessed. An empty cell leaves the mark as it is.', example: 'Mathematics Paper 1: 45.5' },
];

const MARK_SAMPLE = [
  ['admission_no', 'name', 'class', 'Mathematics Paper 1', 'Mathematics Paper 2', 'English Paper 1'],
  ['3101', 'Brian Otieno', 'Form 3 East', '45', '52.5', 'ABS'],
  ['3102', 'Joy Wambui', 'Form 3 East', '61', '', '58'],
];

/** An import that sends marks the way the mark grid does: per paper, up to MAX_BATCH students at a time. */
const sendMarks = (schoolId) => async (todo, { report, halt, halted }) => {
  const byPaper = new Map();
  const left = new Map();
  const problems = new Map();
  for (const { row, index } of todo) {
    left.set(index, row.input.marks.length);
    for (const mark of row.input.marks) {
      if (!byPaper.has(mark.assessment_id)) byPaper.set(mark.assessment_id, []);
      byPaper.get(mark.assessment_id).push({ index, mark });
    }
  }
  const batches = [...byPaper].flatMap(([assessmentId, list]) =>
    Array.from({ length: Math.ceil(list.length / MAX_BATCH) }, (_, i) => ({ assessmentId, list: list.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH) })));

  const settle = (index, problem) => {
    if (problem && !problems.has(index)) problems.set(index, problem);
    left.set(index, left.get(index) - 1);
    if (left.get(index) > 0) return;
    const p = problems.get(index);
    report(index, !p ? { state: 'done' } : p === UNSURE ? { state: 'unsure', message: UNSURE } : { state: 'failed', message: p });
  };

  await eachLimited(batches, PARALLEL, async ({ assessmentId, list }) => {
    try {
      const { submitScores } = await gql(SUBMIT_SCORES, {
        input: {
          school_id: schoolId,
          assessment_id: assessmentId,
          entries: list.map(({ mark }) => ({ student_id: mark.student_id, raw_score: mark.raw_score, mark_status: mark.mark_status, _version: mark._version })),
        },
      });
      const outcome = new Map(submitScores.results.map((r) => [r.student_id, r]));
      for (const { index, mark } of list) {
        const r = outcome.get(mark.student_id);
        const why = r?.outcome === 'APPLIED' ? null
          : r?.outcome === 'REVIEW' || r?.outcome === 'CONFLICT'
            ? `${mark.column}: someone changed this mark meanwhile; it is waiting for a decision on the mark grid`
            : `${mark.column}: ${r?.reason || 'not saved'}`;
        settle(index, why);
      }
    } catch (e) {
      if (CONNECTION.includes(e.errorType)) halt(e.message);
      for (const { index, mark } of list) settle(index, CONNECTION.includes(e.errorType) ? UNSURE : `${mark.column}: ${e.message}`);
    }
  }, halted);
};

function MarkImport({ schoolId, onDirtyChange }) {
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const terms = useTermChoice(schoolId);
  const { termId } = terms;
  const setup = useCheckpointSetup(schoolId, termId);
  const [checkpoint, setCheckpoint] = useState('');
  const heldKey = setup.checkpoints.join(',');
  useEffect(() => {
    if (setup.ready) setCheckpoint((c) => (setup.checkpoints.includes(c) ? c : setup.checkpoints[0] || ''));
  }, [setup.ready, heldKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const examName = checkpoint ? setup.label(checkpoint) : 'exam';

  const loadContext = useCallback(async () => {
    const classes = await loadClasses(schoolId);
    const current = currentOf(classes);
    const [rosters, papers, saved] = await Promise.all([
      Promise.all(current.map((c) => gql(LIST_STUDENTS, { school_id: schoolId, class_id: c.class_id }).then((d) => d.listStudents))),
      Promise.all(current.map((c) => allAssessments(schoolId, c.class_id, termId))),
      Promise.all(current.map((c) => allScores(schoolId, c.class_id))),
    ]);
    const assessments = new Map(current.map((c, i) => [c.class_id, papers[i].filter((a) => checkpointOf(a.assessment_type) === checkpoint)]));
    const wanted = new Set([...assessments.values()].flat().map((a) => a.assessment_id));
    const scores = new Map();
    for (const s of saved.flat()) {
      if (!wanted.has(s.assessment_id)) continue;
      if (!scores.has(s.assessment_id)) scores.set(s.assessment_id, new Map());
      scores.get(s.assessment_id).set(s.student_id, s);
    }
    return { classes, students: rosters.flat(), assessments, scores };
  }, [schoolId, termId, checkpoint]);

  const check = useCallback((parsed, ctx) => checkScoreRows(parsed, { ...ctx, examName }), [examName]);
  const importRows = useMemo(() => sendMarks(schoolId), [schoolId]);
  const template = useCallback(async () => markSheet(await loadContext()), [loadContext]);
  const fileName = `marks-${(examName || 'exam').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;

  return (
    <CsvImporter
      key={`${termId}:${checkpoint}`}
      title="Marks"
      intro="Enter the marks of one exam for many students at once, for example from another system or a spreadsheet kept during marking. Set up the exam’s papers first, in the Assessments tab or on the Assessments page."
      controls={(
        <>
          {terms.error && <Notice tone="error">{terms.error}</Notice>}
          <div className="two-col">
            <Field label="Term" htmlFor="marks-term">
              <Select id="marks-term" value={termId} onChange={guarded(dirty, setDirty, terms.setTermId)} placeholder="Choose a term" options={terms.options} />
            </Field>
            <Field label="Exam" htmlFor="marks-exam">
              <Select id="marks-exam" value={checkpoint} onChange={guarded(dirty, setDirty, setCheckpoint)} placeholder="Choose an exam"
                disabled={!setup.ready} options={setup.checkpoints.map((c) => ({ value: c, label: setup.label(c) }))} />
            </Field>
          </div>
        </>
      )}
      guide={MARK_GUIDE}
      sample={MARK_SAMPLE}
      tip="The easiest start is the mark sheet: it lists every active student and every paper of this exam, with the marks already saved. Fill in the gaps and import it; marks that have not changed are skipped."
      ready={Boolean(termId && checkpoint) && setup.ready}
      templateName={fileName}
      template={template}
      loadContext={loadContext}
      check={check}
      importRows={importRows}
      onDirtyChange={setDirty}
      words={{
        noun: 'student’s marks', nouns: 'students’ marks', verb: 'saved', done: 'Saved', skip: 'No change', failed: 'Not saved',
        templateButton: 'Download mark sheet', warningTitle: 'Worth checking',
        button: (n) => `Save marks for ${count(n, 'student')}`,
      }}
      columns={['Line', 'Admission no.', 'Name', 'Class', 'Marks to save']}
      cells={(r) => [r.line, r.cells.admission_no, r.cells.name, r.cells.class, r.marks || '—']}
    />
  );
}

// ----------------------------------------------------------------- section

const KINDS = [
  { id: 'students', label: 'Students' },
  { id: 'assessments', label: 'Assessments' },
  { id: 'marks', label: 'Marks' },
];

/** Settings → Import from CSV. */
export default function ImportSettings({ schoolId, onDirtyChange }) {
  const [kind, setKind] = useState('students');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  return (
    <div className="stack">
      <div className="settings-intro">
        <p>
          Set up a school from spreadsheets saved as CSV: students first, then the term’s assessments, then marks. Choosing a
          file changes nothing: every row is checked first and shown with its result. What is already in ConnectED is skipped,
          so the same file can be imported again safely, for example to finish an import that was interrupted.
        </p>
      </div>
      <div className="segmented" role="group" aria-label="What to import">
        {KINDS.map((k) => (
          <button key={k.id} type="button" className={`seg${k.id === kind ? ' active' : ''}`} aria-pressed={k.id === kind}
            onClick={() => k.id !== kind && guarded(dirty, setDirty, setKind)(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      {kind === 'students' && <StudentImport schoolId={schoolId} onDirtyChange={setDirty} />}
      {kind === 'assessments' && <AssessmentImport schoolId={schoolId} onDirtyChange={setDirty} />}
      {kind === 'marks' && <MarkImport schoolId={schoolId} onDirtyChange={setDirty} />}
    </div>
  );
}
