import { RESULT_KIND, labelOf } from './results.js';

/**
 * The text of the SMS that tells a parent a student's published result.
 * Pure: the results service gathers the data, this only words it.
 *
 * What it carries, on purpose: the school, the student, the class, which
 * result it is, the mean, and each subject. End of term adds the grades. An
 * interim exam (Opener, Mid-term) has no grades, exactly as on the Results page
 * and the report card. It never carries risk estimates: those are a decision
 * aid for teachers, not something to text home.
 */

/** Characters outside the GSM 7-bit alphabet make a message Unicode, which halves what one SMS holds. */
const REPLACE = [
  [/[\u2018\u2019\u201A\u2032]/g, "'"], [/[\u201C\u201D\u201E\u2033]/g, '"'],
  [/[\u2013\u2014\u2212]/g, '-'], [/\u2026/g, '...'], [/[\u00A0\u2009\u202F]/g, ' '],
];
const GSM = /[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n^{}\\[~\]|€]/;
const EXTENDED = /[\^{}\\[~\]|€]/g;

export function toGsm(text) {
  let out = String(text ?? '');
  for (const [from, to] of REPLACE) out = out.replace(from, to);
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return [...out].map((ch) => (GSM.test(ch) ? ch : '?')).join('');
}

/** How many SMS a GSM-7 text costs: 160 characters alone, 153 each once split. */
export function segments(text) {
  const length = String(text).length + (String(text).match(EXTENDED) || []).length;
  return length <= 160 ? 1 : Math.ceil(length / 153);
}

const num = (x) => {
  const r = Math.round(Number(x) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

/** Short subject names when the full ones would make the message too long: ENG, KIS, MAT… unique per message. */
export function subjectCodes(subjects) {
  const codes = new Map();
  const taken = new Set();
  for (const s of subjects) {
    const letters = s.replace(/[^A-Za-z]/g, '').toUpperCase();
    let code = letters.slice(0, 3) || 'SUB';
    for (let n = 4; taken.has(code) && n <= letters.length; n++) code = letters.slice(0, n);
    for (let i = 2; taken.has(code); i++) code = `${letters.slice(0, 3)}${i}`;
    taken.add(code);
    codes.set(s, code);
  }
  return codes;
}

/** A message longer than this many SMS switches to short subject names. */
const MAX_SEGMENTS = 2;

/**
 * @param {object} p
 * @param {object} p.set      the published result set
 * @param {object} p.row      the student's row in that set
 * @param {object} p.student  { first_name, last_name, admission_no }
 * @param {string} p.schoolName
 * @param {string} p.className
 * @param {string} p.termName
 */
export function resultsSmsText({ set, row, student, schoolName, className, termName }) {
  const final = set.kind === RESULT_KIND.FINAL;
  const label = labelOf(set.checkpoint, set.basis_labels || null);

  const subjects = (row.subjects || [])
    .filter((s) => (final ? s.term?.term_score != null || s.papers?.length : s.papers?.length))
    .map((s) => ({
      subject: s.subject,
      value: final
        ? (s.term?.term_score == null ? '-' : `${num(s.term.term_score)}${s.term.grade ? ` ${s.term.grade}` : ''}`)
        : (s.score == null ? '-' : `${num(s.score)}%`),
    }));

  const mean = final
    ? (row.term_average == null ? null : `${num(row.term_average)}${row.term_grade ? ` ${row.term_grade}` : ''}`)
    : (row.checkpoint_average == null ? null : `${num(row.checkpoint_average)}%`);

  const head = `${schoolName}: ${termName} ${label} ${final ? 'results' : 'exam results'} for `
    + `${student.first_name} ${student.last_name} (${student.admission_no}), ${className}.`;
  const tail = 'Full report card from the school.';
  const build = (name) => [
    head,
    mean ? `Mean ${mean}.` : null,
    subjects.length ? `${subjects.map((s) => `${name(s.subject)} ${s.value}`).join(', ')}.` : null,
    tail,
  ].filter(Boolean).join(' ');

  let text = toGsm(build((s) => s));
  if (segments(text) > MAX_SEGMENTS) {
    const codes = subjectCodes(subjects.map((s) => s.subject));
    text = toGsm(build((s) => codes.get(s)));
  }
  return text;
}

/** …678: enough to tell which number a message went to without showing the number. */
export const phoneHint = (phone) => (phone ? `…${String(phone).slice(-3)}` : null);
