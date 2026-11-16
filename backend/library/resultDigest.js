/**
 * A published result set in brief: per student, the numbers the class page
 * charts and compares, without the paper-by-paper detail of the full rows.
 *
 * Why it exists: the class page compares a class with the whole school at
 * every published exam of the year. Read from the full rows (every paper of
 * every subject, about 5 KB a student), that is the whole school's results
 * for the year on each visit, thousands of read units against a table
 * provisioned for 5 a second. The digest of a class's exam is a few KB, so
 * the same comparison costs about one read unit per class and exam.
 *
 * A published set never changes (publishing is final, and a set is only
 * recalculated before it is published), so its digest is written once and
 * never goes stale. It is keyed by the calculation it summarises.
 *
 * rowsOf() turns a digest back into rows with the fields classProfile.js
 * reads (checkpoint_average, term_average, and each subject's score,
 * term.term_score and whether marks were missing), so the class page works
 * the same on either.
 */

const missingMarks = (s) => (s.absent_count || 0) + (s.missing_count || 0) + (s.not_assessed_count || 0) > 0;
const num = (v) => (Number.isFinite(v) ? v : null);

/** The digest of a published set from its full rows. */
export function digestOf(set, rows) {
  const subjects = [...new Set(rows.flatMap((r) => (r.subjects || []).map((s) => s.subject)))].sort((a, b) => a.localeCompare(b));
  const final = rows.some((r) => (r.subjects || []).some((s) => s.term));
  return {
    term_id: set.term_id,
    class_id: set.class_id,
    checkpoint: set.checkpoint,
    calculation_id: set.calculation_id,
    kind: set.kind ?? null,
    subjects,
    students: rows.map((r) => {
      const bySubject = new Map((r.subjects || []).map((s) => [s.subject, s]));
      const student = {
        id: r.student_id,
        avg: num(r.checkpoint_average),
        term_avg: num(r.term_average),
        scores: subjects.map((name) => num(bySubject.get(name)?.score)),
      };
      if (final) student.term_scores = subjects.map((name) => num(bySubject.get(name)?.term?.term_score));
      // Indexes into `subjects`: marks missing (absent, not assessed, no mark), and subjects not on this row at all.
      const incomplete = subjects.flatMap((name, i) => (bySubject.has(name) && missingMarks(bySubject.get(name)) ? [i] : []));
      const absent = subjects.flatMap((name, i) => (bySubject.has(name) ? [] : [i]));
      if (incomplete.length) student.incomplete = incomplete;
      if (absent.length) student.not_on_row = absent;
      return student;
    }),
  };
}

/** Rows rebuilt from a digest, shaped like result rows for classProfile.js. New objects on every call. */
export function rowsOf(digest) {
  const subjects = digest.subjects || [];
  return (digest.students || []).map((s) => {
    const incomplete = new Set(s.incomplete || []);
    const absent = new Set(s.not_on_row || []);
    return {
      student_id: s.id,
      checkpoint_average: s.avg ?? null,
      term_average: s.term_avg ?? null,
      subjects: subjects.flatMap((subject, i) => (absent.has(i) ? [] : [{
        subject,
        score: s.scores?.[i] ?? null,
        term: s.term_scores ? { term_score: s.term_scores[i] ?? null } : null,
        incomplete: incomplete.has(i),
      }])),
    };
  });
}
