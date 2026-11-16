import { notFound, validation } from '../../library/errors.js';
import { checkpointsUpTo, reportCardModel } from '../../library/results.js';
import { renderReportCard, reportKindOf } from '../../library/reportCard.js';
import { languageFor } from '../../library/language.js';
import * as languages from '../../library/languageRepo.js';
import { reportKey, store } from '../../library/reportStore.js';
import * as results from '../../library/resultsRepo.js';
import * as platform from '../../library/platformRepo.js';

export async function handler(event) {
  switch (event.action) {
    case 'generate':
      return generateOne(event);
    case 'complete':
      return finish(event, { ok: true });
    case 'fail':
      return finish(event, { ok: false, error: String(event.error ?? 'Report card generation failed').slice(0, 500) });
    default:
      throw validation(`Unknown report-card action ${event.action}`);
  }
}

async function publishedSet(event, checkpoint = event.checkpoint) {
  const set = await results.getSet(event.school_id, { termId: event.term_id, classId: event.class_id, checkpoint });
  if (set?.status !== results.STATUS.PUBLISHED) throw validation(`${checkpoint} results are not published`);
  return set;
}

/**
 * Idempotent per student + checkpoint + calculation: the object key, the
 * ReportCard row and the PDF bytes are fixed by the published calculations,
 * so a retried item rewrites identical content.
 */
export async function generateOne(event) {
  const { school_id, class_id, term_id, checkpoint, student_id, calculation_id } = event;
  const current = await publishedSet(event);
  if (current.calculation_id !== calculation_id) throw validation('These results were superseded');

  const entries = [];
  // Only the checkpoints this term held when the result was calculated: no Opener means the card starts at Mid-term.
  for (const c of checkpointsUpTo(checkpoint, current.basis_opener_enabled ?? true)) {
    const set = c === checkpoint ? current : await publishedSet(event, c);
    const row = await results.getRow(school_id, set, student_id);
    if (row) entries.push({ set, row });
    else if (c === checkpoint) throw notFound(`No published result for ${student_id}`);
  }

  const [student, klass, school, term, rule, languageSettings] = await Promise.all([
    platform.student(school_id, student_id),
    platform.klass(school_id, class_id),
    platform.school(school_id),
    platform.term(school_id, term_id),
    platform.gradeRule(school_id, term_id),
    languages.get(school_id),
  ]);
  const model = reportCardModel({ checkpoint, school, term, klass, student, entries });
  const kind = reportKindOf(model.kind);
  // The term's pass mark cannot change once any of its results are published (setTermGrading), so this is
  // the pass mark these results were published under.
  const pdf = renderReportCard(model, {
    language: languageFor(languageSettings, 'report_card', student),
    passMark: Number.isFinite(rule?.pass_mark) ? rule.pass_mark : null,
  });

  const key = reportKey({ school_id, term_id, class_id, checkpoint, student_id, calculation_id });
  const where = await store(key, pdf);
  await results.putReportCard(school_id, {
    term_id, class_id, checkpoint, student_id, calculation_id, kind,
    checkpoints: entries.map((e) => e.set.checkpoint),
    s3_bucket: where.bucket, s3_key: key, bytes: pdf.length, generated_at: current.published_at,
  });
  await results.markReportCardDone(school_id, current, student_id);
  return { student_id, kind, s3_key: key };
}

async function finish(event, outcome) {
  const set = await publishedSet(event);
  if (set.calculation_id !== event.calculation_id) return { ignored: true };
  const after = await results.markReportsFinished(event.school_id, set, outcome);
  return { status: after.report_cards_status };
}