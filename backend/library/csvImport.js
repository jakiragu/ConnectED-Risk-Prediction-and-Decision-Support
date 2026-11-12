/**
 * Setting a school up from CSV files: students, and the assessments of a term.
 *
 * Nothing here writes. The browser parses a file, checks every row against what
 * the school already has, shows the result, and only then creates the ready
 * rows one by one through the same createStudent / createAssessment calls the
 * forms use, so an import can never make anything the forms could not.
 *
 * Every row is recognisable once it exists (a student by admission number, an
 * assessment by class, subject, exam, kind and number), so a row that is
 * already there is skipped. An interrupted import is finished by importing the
 * same file again.
 */
import {
  COMPONENT_LABEL, COMPONENT_TYPES, SUBJECTS, TOTAL_WEIGHT, checkpointOf, componentTypeOf, validateAssessment,
} from './assessment.js';
import { CHECKPOINTS, CHECKPOINT_LABEL, CHECKPOINT_TYPE, labelOf } from './results.js';
import { MARK, cellText, sameMark, tokenStatus, validateEntry } from './score.js';
import { ADMISSION, ADMISSION_MAX, GUARDIAN_NAME_MAX, NAME_MAX, normalisePhone } from './student.js';

/** Rows one file may hold; larger schools import a form at a time. */
export const MAX_ROWS = 3000;

export const STATUS = { READY: 'READY', SKIP: 'SKIP', ERROR: 'ERROR' };

// ------------------------------------------------------------------ parsing

/** "Max score", "max-score" and "MAX_SCORE" are the same column. */
export const headerKey = (h) => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const squash = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lower = (s) => squash(s).toLowerCase();

/**
 * RFC 4180 CSV, as Excel and Google Sheets save it: quoted fields, "" inside
 * quotes, commas and line breaks inside quotes, CRLF, a leading BOM. A file
 * whose first line has semicolons and no commas (Excel in some locales) is read
 * with semicolons.
 * Returns { headers, titles, rows: [{ line, values: { header: text } }] }; titles are the column names as written; blank lines are dropped.
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';

  const records = [];
  let field = '';
  let record = [];
  let line = 1;
  let startLine = 1;
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line += 1; field += ch; }
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      record.push(field);
      records.push({ line: startLine, cells: record });
      field = '';
      record = [];
      line += 1;
      startLine = line;
    } else field += ch;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push({ line: startLine, cells: record });
  }

  const nonBlank = records.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!nonBlank.length) return { headers: [], rows: [] };
  const [head, ...body] = nonBlank;
  const headers = head.cells.map(headerKey);
  const titles = head.cells.map((c) => c.trim());
  const rows = body.map((r) => ({
    line: r.line,
    values: Object.fromEntries(headers.map((h, i) => [h, (r.cells[i] ?? '').trim()])),
  }));
  return { headers, titles, rows };
}

/** A CSV file from rows of values; fields are quoted only when they need it. */
export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Finds each wanted column under its name or an alias.
 * columns: [{ key, aliases?, required? }] → { pick(values, key), missing: [key] }
 */
function columnsOf(headers, columns) {
  const at = {};
  for (const c of columns) {
    const found = [c.key, ...(c.aliases || [])].find((name) => headers.includes(name));
    if (found) at[c.key] = found;
  }
  return {
    pick: (values, key) => (at[key] ? values[at[key]] ?? '' : ''),
    missing: columns.filter((c) => c.required && !at[c.key]).map((c) => c.key),
  };
}

/** A problem with the file as a whole (no rows, a missing column, too many rows), or null. */
function fileProblem(parsed, missing) {
  if (!parsed.headers.length) return 'The file is empty.';
  if (missing.length) {
    return `The file has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}. Start from the template so the first row has the column names.`;
  }
  if (!parsed.rows.length) return 'The file has column names but no rows under them.';
  if (parsed.rows.length > MAX_ROWS) return `The file has ${parsed.rows.length} rows; import at most ${MAX_ROWS} at a time.`;
  return null;
}

/** Current classes by name, case and spacing ignored. */
const classesByName = (classes) =>
  new Map(classes.filter((c) => c.status === 'CURRENT').map((c) => [lower(c.name), c]));

// ----------------------------------------------------------------- students

export const STUDENT_COLUMNS = [
  { key: 'admission_no', aliases: ['admission_number', 'adm_no', 'admission'], required: true },
  { key: 'first_name', aliases: ['firstname', 'first'], required: true },
  { key: 'last_name', aliases: ['lastname', 'surname', 'last'], required: true },
  { key: 'class', aliases: ['class_name'], required: true },
  { key: 'guardian_name', aliases: ['parent_name', 'guardian', 'parent'] },
  { key: 'guardian_phone', aliases: ['parent_phone', 'phone', 'guardian_mobile', 'parent_mobile', 'mobile'] },
];

export function studentTemplate(classes = []) {
  const name = classes.find((c) => c.status === 'CURRENT')?.name || 'Form 1 East';
  return toCsv([
    STUDENT_COLUMNS.map((c) => c.key),
    ['4512', 'Amina', 'Wanjiru', name, 'Grace Wanjiru', '0712 345 678'],
    ['4513', 'Brian', 'Otieno', name, '', ''],
  ]);
}

/**
 * Checks a parsed students file.
 *   classes   the school's classes (only CURRENT ones can take students)
 *   students  students already in the school: { student_id, admission_no, first_name, last_name, class_id,
 *             status, guardian_name, guardian_phone, _version }
 * Returns { problem, rows: [{ line, status, message, cells, input }] }; input is the
 * createStudent input (without school_id) for READY rows, or, for a student already
 * there whose file row brings a new guardian contact, the updateStudent input
 * (with student_id and _version). An empty guardian cell never clears a saved one.
 */
export function checkStudentRows(parsed, { classes = [], students = [] } = {}) {
  const cols = columnsOf(parsed.headers, STUDENT_COLUMNS);
  const problem = fileProblem(parsed, cols.missing);
  if (problem) return { problem, rows: [] };

  const byName = classesByName(classes);
  const className = new Map(classes.map((c) => [c.class_id, c.name]));
  const existing = new Map(students.map((s) => [s.admission_no, s]));
  const firstLineOf = new Map();

  const rows = parsed.rows.map(({ line, values }) => {
    const cells = {
      admission_no: squash(cols.pick(values, 'admission_no')),
      first_name: squash(cols.pick(values, 'first_name')),
      last_name: squash(cols.pick(values, 'last_name')),
      class: squash(cols.pick(values, 'class')),
      guardian_name: squash(cols.pick(values, 'guardian_name')),
      guardian_phone: squash(cols.pick(values, 'guardian_phone')),
    };
    const out = (status, message, input = null) => ({ line, status, message, cells, input });
    const error = (message) => out(STATUS.ERROR, message);

    if (!cells.admission_no) return error('Enter the admission number');
    if (cells.admission_no.length > ADMISSION_MAX) return error(`Admission numbers are at most ${ADMISSION_MAX} characters`);
    if (!ADMISSION.test(cells.admission_no)) return error('Admission numbers use letters, digits, / and - only');
    if (!cells.first_name) return error('Enter the first name');
    if (!cells.last_name) return error('Enter the last name');
    if (cells.first_name.length > NAME_MAX || cells.last_name.length > NAME_MAX) return error(`Names are at most ${NAME_MAX} characters`);
    if (!cells.class) return error('Enter the class');
    if (cells.guardian_name.length > GUARDIAN_NAME_MAX) return error(`Guardian names are at most ${GUARDIAN_NAME_MAX} characters`);
    let phone = null;
    try {
      phone = normalisePhone(cells.guardian_phone);
    } catch (e) {
      return error(e.message);
    }

    const earlier = firstLineOf.get(cells.admission_no);
    if (earlier) return error(`Admission number ${cells.admission_no} is also on line ${earlier}`);
    firstLineOf.set(cells.admission_no, line);

    const holder = existing.get(cells.admission_no);
    if (holder) {
      const same = lower(holder.first_name) === lower(cells.first_name) && lower(holder.last_name) === lower(cells.last_name);
      if (!same) return error(`Admission number ${cells.admission_no} already belongs to ${holder.first_name} ${holder.last_name}`);
      const where = className.get(holder.class_id);
      const newName = cells.guardian_name && cells.guardian_name !== (holder.guardian_name || '');
      const newPhone = phone && phone !== holder.guardian_phone;
      if ((newName || newPhone) && holder.status !== 'GRADUATED' && holder.student_id) {
        return out(STATUS.READY, `Already in ${where || 'ConnectED'}; parent contact ${holder.guardian_phone ? 'updated' : 'added'}`, {
          student_id: holder.student_id,
          _version: holder._version,
          ...(newName ? { guardian_name: cells.guardian_name } : {}),
          ...(newPhone ? { guardian_phone: phone } : {}),
        });
      }
      return out(STATUS.SKIP, where ? `Already in ${where}` : 'Already in ConnectED');
    }

    const klass = byName.get(lower(cells.class));
    if (!klass) return error(`No current class is called ${cells.class}. Create it on the Classes page first.`);
    return out(STATUS.READY, null, {
      class_id: klass.class_id, first_name: cells.first_name, last_name: cells.last_name, admission_no: cells.admission_no,
      ...(cells.guardian_name ? { guardian_name: cells.guardian_name } : {}),
      ...(phone ? { guardian_phone: phone } : {}),
    });
  });
  return { problem: null, rows };
}

// -------------------------------------------------------------- assessments

export const ASSESSMENT_COLUMNS = [
  { key: 'class', aliases: ['class_name', 'form'], required: true },
  { key: 'subject', required: true },
  { key: 'exam', aliases: ['checkpoint', 'assessment_type'], required: true },
  { key: 'component', aliases: ['kind', 'component_type'] },
  { key: 'number', aliases: ['no', 'paper_no', 'component_no'], required: true },
  { key: 'weight', aliases: ['weight_percent'], required: true },
  { key: 'max_score', aliases: ['out_of', 'max', 'maximum'], required: true },
  { key: 'due_date', aliases: ['due'] },
  { key: 'title', aliases: ['name'] },
];

export function assessmentTemplate(classes = []) {
  const grade = classes.find((c) => c.status === 'CURRENT')?.grade || 'Form 1';
  return toCsv([
    ASSESSMENT_COLUMNS.map((c) => c.key),
    [grade, 'Mathematics', 'Mid-term', 'Paper', 1, 50, 100, '', ''],
    [grade, 'Mathematics', 'Mid-term', 'Paper', 2, 50, 100, '', ''],
    [grade, 'English', 'End-term', 'Paper', 1, 70, 80, '', ''],
    [grade, 'English', 'End-term', 'CAT', 1, 30, 30, '', ''],
  ]);
}

/** The title the assessment form suggests: "Mathematics Mid-term Paper 1". */
export const suggestedTitle = (a, labels) =>
  `${a.subject} ${labelOf(checkpointOf(a.assessment_type), labels)} ${COMPONENT_LABEL[componentTypeOf(a)]} ${a.paper_no}`;

/** A date as YYYY-MM-DD, from YYYY-MM-DD or day-first D/M/YYYY (how Excel shows dates in Kenya); null if not a real date. */
export function readDate(text) {
  const s = squash(text);
  let y; let m; let d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = match.map(Number);
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** A number from "50", "50%" or " 50.5 "; NaN when it is not one. */
const readNumber = (text) => {
  const s = squash(text).replace(/%$/, '').trim();
  return s === '' ? NaN : Number(s);
};

/** Exam names the file may use for each checkpoint: its key, the standard names and the school's own name. */
function examReader(labels) {
  const names = new Map();
  for (const c of CHECKPOINTS) {
    for (const n of [c, CHECKPOINT_LABEL[c], CHECKPOINT_TYPE[c], labels?.[c]]) if (n) names.set(checkpointOf(n), c);
  }
  return (text) => names.get(checkpointOf(text)) || null;
}

const componentReader = (text) => {
  const s = lower(text);
  if (!s) return 'PAPER';
  return COMPONENT_TYPES.find((t) => t.toLowerCase() === s || COMPONENT_LABEL[t].toLowerCase() === s) || null;
};

const subjectReader = (text) => SUBJECTS.find((s) => s.toLowerCase() === lower(text)) || null;

const examKey = (a) => `${a.class_id}|${a.subject}|${checkpointOf(a.assessment_type)}`;
const componentKey = (a) => `${examKey(a)}|${componentTypeOf(a)}|${Number(a.paper_no)}`;

/**
 * Checks a parsed assessments file for one term.
 *   classes      the school's classes; a row's class is a current class's name, or a form
 *                ("Form 3"), which means every current class in that form
 *   existing     Map class_id → that class's assessments in the term
 *   checkpoints  the exams the term holds, e.g. ['MIDTERM', 'ENDTERM']
 *   labels       the school's names for exams
 * Returns { problem, rows, warnings }. A file row naming a form becomes one row per class.
 * Each row is checked against the class's assessments and the rows above it, so two
 * rows that together pass 100% of an exam are caught here.
 */
export function checkAssessmentRows(parsed, { classes = [], existing = new Map(), checkpoints = [], labels = null } = {}) {
  const cols = columnsOf(parsed.headers, ASSESSMENT_COLUMNS);
  const problem = fileProblem(parsed, cols.missing);
  if (problem) return { problem, rows: [], warnings: [] };

  const byName = classesByName(classes);
  const current = classes.filter((c) => c.status === 'CURRENT');
  const readExam = examReader(labels);
  const label = (c) => labelOf(c, labels);
  const siblings = new Map([...existing].map(([id, list]) => [id, list.filter((a) => !a._deleted)]));
  const touched = new Set();
  const rows = [];

  for (const { line, values } of parsed.rows) {
    const cells = Object.fromEntries(ASSESSMENT_COLUMNS.map((c) => [c.key, squash(cols.pick(values, c.key))]));
    const fileError = (message, className = cells.class) =>
      rows.push({ line, status: STATUS.ERROR, message, cells, className, input: null });

    // Problems with the row itself, before it is matched to classes.
    const subject = subjectReader(cells.subject);
    const checkpoint = readExam(cells.exam);
    const component = componentReader(cells.component);
    const number = readNumber(cells.number);
    const weight = readNumber(cells.weight);
    const maxScore = readNumber(cells.max_score);
    const dueDate = cells.due_date ? readDate(cells.due_date) : null;

    if (!cells.class) { fileError('Enter a class or a form'); continue; }
    if (!subject) { fileError(cells.subject ? `${cells.subject} is not one of the school’s subjects` : 'Enter the subject'); continue; }
    if (!checkpoint) { fileError(cells.exam ? `${cells.exam} is not an exam name` : 'Enter the exam'); continue; }
    if (!checkpoints.includes(checkpoint)) { fileError(`This term has no ${label(checkpoint)}`); continue; }
    if (!component) { fileError(`Component is one of ${COMPONENT_TYPES.map((t) => COMPONENT_LABEL[t]).join(', ')}`); continue; }
    if (!Number.isInteger(number)) { fileError('Number is a whole number, such as 1 for Paper 1'); continue; }
    if (Number.isNaN(weight)) { fileError('Weight is a number, such as 50'); continue; }
    if (Number.isNaN(maxScore)) { fileError('Max score is a number, such as 100'); continue; }
    if (cells.due_date && !dueDate) { fileError('Due date is a date such as 2026-03-14 or 14/03/2026'); continue; }

    const named = byName.get(lower(cells.class));
    const targets = named ? [named] : current.filter((c) => lower(c.grade) === lower(cells.class));
    if (!targets.length) { fileError(`No current class or form is called ${cells.class}`); continue; }

    for (const klass of targets) {
      const candidate = {
        class_id: klass.class_id,
        subject,
        assessment_type: checkpoint,
        component_type: component,
        paper_no: number,
        weight,
        max_score: maxScore,
        due_date: dueDate,
      };
      candidate.title = cells.title || suggestedTitle(candidate, labels);
      const base = { line, cells, className: klass.name, fromForm: !named };
      const list = siblings.get(klass.class_id) || [];

      const already = list.find((a) => componentKey(a) === componentKey(candidate));
      if (already) {
        const fromFile = already._fromFile;
        rows.push({
          ...base,
          status: fromFile ? STATUS.ERROR : STATUS.SKIP,
          message: fromFile
            ? `${klass.name} ${subject} ${label(checkpoint)} ${COMPONENT_LABEL[component]} ${number} is also on line ${already._line}`
            : `Already set up${already.weight !== weight || already.max_score !== maxScore ? ' (with different values; edit it on the Assessments page)' : ''}`,
          input: null,
        });
        continue;
      }

      const errors = validateAssessment(candidate, { siblings: list, assessmentTypes: checkpoints, typeLabels: labels });
      if (errors.length) {
        rows.push({ ...base, status: STATUS.ERROR, message: errors[0].message, input: null });
        continue;
      }
      siblings.set(klass.class_id, [...list, { ...candidate, _fromFile: true, _line: line }]);
      touched.add(examKey(candidate));
      rows.push({ ...base, status: STATUS.READY, message: null, input: candidate });
    }
  }

  // An exam's components make up 100%. A partial exam is allowed (the rest can be added later),
  // but it is usually a slip in the file, so it is pointed out.
  const warnings = [];
  const nameOf = new Map(classes.map((c) => [c.class_id, c.name]));
  for (const key of touched) {
    const [classId, subject, checkpoint] = key.split('|');
    const total = (siblings.get(classId) || [])
      .filter((a) => examKey(a) === key)
      .reduce((sum, a) => sum + Number(a.weight || 0), 0);
    if (total !== TOTAL_WEIGHT) {
      warnings.push(`${nameOf.get(classId)} ${subject} ${label(checkpoint)} adds up to ${total}%, not ${TOTAL_WEIGHT}%`);
    }
  }
  return { problem: null, rows, warnings };
}

// ------------------------------------------------------------------ marks

/**
 * Marks come as a mark sheet: one row per student, one column per paper of one
 * exam (chosen on the page), named "<Subject> <Component> <Number>", such as
 * "Mathematics Paper 1" or "English CAT 2". A student is found by admission
 * number, so a file can hold several classes; each mark goes to that paper in
 * the student's own class.
 */
export const markColumn = (a) => `${a.subject} ${COMPONENT_LABEL[componentTypeOf(a)]} ${a.paper_no}`;

/** "Mathematics P1" is accepted for "Mathematics Paper 1". */
const markKeys = (a) => {
  const keys = [headerKey(markColumn(a))];
  if (componentTypeOf(a) === 'PAPER') keys.push(headerKey(`${a.subject} P${a.paper_no}`));
  return keys;
};

const REFERENCE_COLUMNS = ['admission_no', 'admission_number', 'adm_no', 'admission', 'name', 'student', 'student_name',
  'first_name', 'last_name', 'class', 'class_name'];
const nameOfStudent = (s) => `${s.first_name} ${s.last_name}`;
const naturalOrder = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

/** The papers of an exam in the order the mark sheet lists them: by subject list, then papers, CATs and so on. */
function orderedColumns(assessments) {
  const byColumn = new Map();
  for (const a of assessments) if (!byColumn.has(markColumn(a))) byColumn.set(markColumn(a), a);
  return [...byColumn.values()]
    .sort((x, y) => (SUBJECTS.indexOf(x.subject) - SUBJECTS.indexOf(y.subject))
      || (COMPONENT_TYPES.indexOf(componentTypeOf(x)) - COMPONENT_TYPES.indexOf(componentTypeOf(y)))
      || (x.paper_no - y.paper_no))
    .map(markColumn);
}

/**
 * The mark sheet for one exam, filled with the marks already saved, so it can be
 * completed in a spreadsheet and imported back. Rows: every active student in a
 * current class that has papers in the exam, by class then admission number.
 *   assessments  Map class_id → that class's papers in the exam
 *   scores       Map assessment_id → Map student_id → saved mark
 */
export function markSheet({ classes = [], students = [], assessments = new Map(), scores = new Map() } = {}) {
  const current = classes.filter((c) => c.status === 'CURRENT').sort((a, b) => naturalOrder(a.name, b.name));
  const columns = orderedColumns([...assessments.values()].flat());
  const rows = [['admission_no', 'name', 'class', ...columns]];
  for (const klass of current) {
    const papers = new Map((assessments.get(klass.class_id) || []).map((a) => [markColumn(a), a]));
    if (!papers.size) continue; // a class with no papers in this exam has nothing to fill in
    const members = students.filter((s) => s.class_id === klass.class_id && (s.status || 'ACTIVE') === 'ACTIVE')
      .sort((a, b) => naturalOrder(a.admission_no, b.admission_no));
    for (const s of members) {
      rows.push([s.admission_no, nameOfStudent(s), klass.name, ...columns.map((col) => {
        const a = papers.get(col);
        return a ? cellText(scores.get(a.assessment_id)?.get(s.student_id)) : '';
      })]);
    }
  }
  return toCsv(rows);
}

/**
 * Checks a parsed mark sheet against one exam.
 *   classes, students   the school's classes and its active students
 *   assessments         Map class_id → the class's papers in this exam
 *   scores              Map assessment_id → Map student_id → saved mark (with _version)
 *   examName            the exam's name, for messages
 * Returns { problem, rows, warnings }. A READY row's input is { marks: [ScoreEntry + assessment_id] }
 * holding only the marks that differ from what is saved; empty cells change nothing.
 */
export function checkScoreRows(parsed, { classes = [], students = [], assessments = new Map(), scores = new Map(), examName = 'exam' } = {}) {
  if (!parsed.headers.length) return { problem: 'The file is empty.', rows: [], warnings: [] };
  const admissionAt = ['admission_no', 'admission_number', 'adm_no', 'admission'].find((h) => parsed.headers.includes(h));
  if (!admissionAt) {
    return { problem: 'The file has no admission_no column. Start from the mark sheet so the first row has the column names.', rows: [], warnings: [] };
  }
  if (!parsed.rows.length) return { problem: 'The file has column names but no rows under them.', rows: [], warnings: [] };
  if (parsed.rows.length > MAX_ROWS) return { problem: `The file has ${parsed.rows.length} rows; import at most ${MAX_ROWS} at a time.`, rows: [], warnings: [] };

  // Which column is which paper, by name; the same name can be a different paper in each class.
  const known = new Set();
  for (const list of assessments.values()) for (const a of list) markKeys(a).forEach((k) => known.add(k));
  const markHeaders = parsed.headers.map((h, i) => ({ key: h, title: parsed.titles?.[i] || h }))
    .filter((h) => h.key && known.has(h.key));
  const ignored = parsed.headers.map((h, i) => ({ key: h, title: parsed.titles?.[i] || h }))
    .filter((h) => h.key && !known.has(h.key) && !REFERENCE_COLUMNS.includes(h.key));
  if (!markHeaders.length) {
    return {
      problem: `No column matches a paper in the ${examName}. Columns are named like Mathematics Paper 1; download the mark sheet to see the names for this exam.`,
      rows: [],
      warnings: [],
    };
  }

  const classById = new Map(classes.map((c) => [c.class_id, c]));
  const byAdmission = new Map(students.filter((s) => (s.status || 'ACTIVE') === 'ACTIVE' && classById.get(s.class_id)?.status === 'CURRENT')
    .map((s) => [s.admission_no, s]));
  const paperIn = new Map([...assessments].map(([classId, list]) =>
    [classId, new Map(list.flatMap((a) => markKeys(a).map((k) => [k, a])))]));
  const classAt = ['class', 'class_name'].find((h) => parsed.headers.includes(h));
  const firstLineOf = new Map();
  let replaced = 0;

  const rows = parsed.rows.map(({ line, values }) => {
    const admission = squash(values[admissionAt]);
    const cells = { admission_no: admission, name: squash(values.name ?? values.student_name ?? values.student ?? ''), class: classAt ? squash(values[classAt]) : '' };
    const out = (status, message, input = null, marks = 0) => ({ line, status, message, cells, input, marks });
    if (!admission) return out(STATUS.ERROR, 'Enter the admission number');
    const earlier = firstLineOf.get(admission);
    if (earlier) return out(STATUS.ERROR, `Admission number ${admission} is also on line ${earlier}`);
    firstLineOf.set(admission, line);
    const student = byAdmission.get(admission);
    if (!student) return out(STATUS.ERROR, `No active student in a current class has admission number ${admission}`);
    const klass = classById.get(student.class_id);
    cells.name = nameOfStudent(student);
    if (cells.class && lower(cells.class) !== lower(klass.name)) {
      return out(STATUS.ERROR, `${cells.name} is in ${klass.name}, not ${cells.class}`);
    }
    cells.class = klass.name;

    const problems = [];
    const marks = [];
    let changesSaved = 0;
    let filled = 0;
    for (const { key, title } of markHeaders) {
      const text = squash(values[key]);
      if (!text) continue;
      filled += 1;
      const a = paperIn.get(student.class_id)?.get(key);
      if (!a) { problems.push(`${klass.name} has no ${title} in the ${examName}`); continue; }
      if (a.status === 'LOCKED') { problems.push(`${title} is locked`); continue; }
      const status = tokenStatus(text);
      const entry = status ? { student_id: student.student_id, raw_score: null, mark_status: status }
        : { student_id: student.student_id, raw_score: text, mark_status: MARK.SCORED };
      const verdict = validateEntry(entry, { assessment: a, roster: { has: () => true } });
      if (!verdict.ok) {
        problems.push(`${title}: ${verdict.reason.charAt(0).toLowerCase()}${verdict.reason.slice(1)}, not ${text}`);
        continue;
      }
      const mark = status ? { raw_score: null, mark_status: status } : { raw_score: verdict.value, mark_status: MARK.SCORED };
      const saved = scores.get(a.assessment_id)?.get(student.student_id) || null;
      if (saved && sameMark(saved, mark)) continue;
      if (saved && cellText(saved) !== '') changesSaved += 1;
      marks.push({ assessment_id: a.assessment_id, column: title, student_id: student.student_id, ...mark, _version: saved?._version ?? null });
    }
    if (problems.length) {
      return out(STATUS.ERROR, problems.length > 1 ? `${problems[0]} (and ${problems.length - 1} more)` : problems[0]);
    }
    if (!marks.length) return out(STATUS.SKIP, filled ? 'Marks match what is saved' : 'No marks in this row');
    replaced += changesSaved;
    const message = changesSaved ? `Replaces ${changesSaved === 1 ? '1 saved mark' : `${changesSaved} saved marks`}` : null;
    return out(STATUS.READY, message, { marks }, marks.length);
  });

  const warnings = [];
  if (ignored.length) {
    const names = ignored.map((h) => h.title).join(', ');
    warnings.push(ignored.length === 1
      ? `The column ${names} matches no paper in the ${examName}, so it is ignored`
      : `The columns ${names} match no paper in the ${examName}, so they are ignored`);
  }
  if (replaced) warnings.push(`${replaced === 1 ? '1 mark already saved' : `${replaced} marks already saved`} will be replaced with the value in the file`);
  return { problem: null, rows, warnings };
}

/** Counts by status, for the summary line. */
export const tally = (rows) => ({
  ready: rows.filter((r) => r.status === STATUS.READY).length,
  skip: rows.filter((r) => r.status === STATUS.SKIP).length,
  error: rows.filter((r) => r.status === STATUS.ERROR).length,
});
