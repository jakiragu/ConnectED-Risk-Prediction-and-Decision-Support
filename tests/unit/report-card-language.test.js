import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LANGUAGES, LANGUAGES, examName, languageFor, t, wordKeys } from '../../backend/library/language.js';
import { passVerdict, renderReportCard } from '../../backend/library/reportCard.js';
import { resultsSmsText } from '../../backend/library/resultsSms.js';
import { textWidth } from '../../backend/library/pdf.js';

// ------------------------------------------------------------------ language choice

test('language: every phrase exists in every language', () => {
  for (const code of LANGUAGES) assert.deepEqual(wordKeys(code).sort(), wordKeys('en').sort(), code);
});

test('language: school setting per channel, English when unset or unknown', () => {
  assert.equal(languageFor(null, 'sms'), 'en');
  assert.equal(languageFor(DEFAULT_LANGUAGES, 'report_card'), 'en');
  const settings = { report_card_language: 'en', sms_language: 'sw' };
  assert.equal(languageFor(settings, 'report_card'), 'en');
  assert.equal(languageFor(settings, 'sms'), 'sw');
  assert.equal(languageFor({ sms_language: 'fr' }, 'sms'), 'en');
});

test('language: a guardian’s own choice, when recorded, comes before the school’s', () => {
  const settings = { report_card_language: 'en', sms_language: 'en' };
  assert.equal(languageFor(settings, 'sms', { guardian_language: 'sw' }), 'sw');
  assert.equal(languageFor(settings, 'sms', { guardian_language: 'xx' }), 'en');
  assert.equal(languageFor(settings, 'sms', {}), 'en');
});

test('language: exam names the school renamed stay as typed; default names are translated', () => {
  assert.equal(examName('sw', 'MIDTERM'), 'Katikati ya muhula');
  assert.equal(examName('sw', 'MIDTERM', { MIDTERM: 'Mid-term' }), 'Katikati ya muhula');
  assert.equal(examName('sw', 'MIDTERM', { MIDTERM: 'CAT 2' }), 'CAT 2');
  assert.equal(t('sw', 'card.below', { mark: 50 }), 'Chini ya alama ya kufaulu (50%)');
});

// ------------------------------------------------------------------ pass verdict

test('pass: term mean at or above the pass mark passes; unknown stays unknown', () => {
  assert.equal(passVerdict(50, 50), true);
  assert.equal(passVerdict(49.99, 50), false);
  assert.equal(passVerdict(null, 50), null);
  assert.equal(passVerdict(60, null), null);
});

// ------------------------------------------------------------------ report card PDF

const paper = (n, raw, max, weight) => ({ component_type: 'PAPER', paper_no: n, raw_score: raw, max_score: max, weight, mark_status: 'SCORED', contribution: (raw / max) * weight });
const model = (kind) => ({
  kind, checkpoint: kind === 'FINAL' ? 'ENDTERM' : 'MIDTERM', school_name: 'Saint Innocent High School', term_name: 'Term 1 2026',
  class_name: 'Form 2 East', student_name: 'Wanjiru Morning', admission_no: '17024', published_at: '2026-04-04T10:00:00Z',
  calculation_id: 'CALC1', labels: { OPENER: 'Opener', MIDTERM: 'Mid-term', ENDTERM: 'End of term' }, held: ['OPENER', 'MIDTERM', 'ENDTERM'],
  checkpoint_weights: { OPENER: 10, MIDTERM: 30, ENDTERM: 60 },
  subjects: ['English', 'Mathematics'].map((subject) => ({
    subject,
    checkpoints: (kind === 'FINAL' ? ['OPENER', 'MIDTERM', 'ENDTERM'] : ['OPENER', 'MIDTERM']).map((checkpoint) => ({
      checkpoint, papers: [paper(1, 40, 80, 60), { component_type: 'PAPER', paper_no: 2, max_score: 80, weight: 40, mark_status: 'ABSENT', contribution: 0 }], score: 30,
    })),
    term_score: 30, grade: 'D',
  })),
  checkpoint_average: 30, checkpoint_averages: { OPENER: 30, MIDTERM: 30, ENDTERM: 30 },
  term_average: kind === 'FINAL' ? 30 : null, term_grade: kind === 'FINAL' ? 'D' : null,
});

/** The text drawn on the pages: what a reader of the PDF sees. */
const shown = (pdf) => [...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('\n');

test('report card: final card shows grade, verdict and the pass mark', () => {
  const text = shown(renderReportCard(model('FINAL'), { language: 'en', passMark: 50 }));
  assert.match(text, /END OF TERM REPORT CARD/);
  assert.match(text, /Below pass mark \(50%\)/);
  assert.match(text, /Pass mark 50%/);
  assert.match(text, /Overall grade/);
  assert.match(text, /ABS/);
  assert.doesNotMatch(text, /PROVISIONAL/);
});

test('report card: Kiswahili wording, names and subjects untouched', () => {
  const text = shown(renderReportCard(model('FINAL'), { language: 'sw', passMark: 25 }));
  assert.match(text, /RIPOTI YA MWISHO WA MUHULA/);
  assert.match(text, /Amefaulu/);
  assert.match(text, /Wanjiru Morning/);
  assert.match(text, /Mathematics/);
});

test('report card: provisional card has no grade or verdict and is watermarked', () => {
  const text = shown(renderReportCard(model('INTERIM'), { language: 'en', passMark: 50 }));
  assert.match(text, /PROVISIONAL MID-TERM REPORT/);
  assert.doesNotMatch(text, /Pass mark|Passed|Below pass mark|Overall grade/);
  assert.match(text, /PROVISIONAL/);
});

test('report card: a valid PDF; text widths follow Helvetica metrics', () => {
  const pdf = renderReportCard(model('FINAL'), { language: 'en', passMark: 50 });
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /%%EOF\n$/);
  assert.equal(textWidth('0000', { size: 10 }), 22.24);
});

// ------------------------------------------------------------------ SMS wording

test('sms: Kiswahili wording for the same result; English unchanged by default', () => {
  const set = { kind: 'INTERIM', checkpoint: 'MIDTERM', basis_labels: null };
  const row = { checkpoint_average: 58.4, subjects: [{ subject: 'English', score: 60, papers: [{}] }] };
  const student = { first_name: 'Amina', last_name: 'Achieng', admission_no: '17073' };
  const names = { schoolName: 'Saint Innocent', className: 'Form 2 West', termName: 'Term 1 2026' };
  assert.equal(resultsSmsText({ set, row, student, ...names }),
    'Saint Innocent: Term 1 2026 Mid-term exam results for Amina Achieng (17073), Form 2 West. Mean 58.4%. English 60%. Full report card from the school.');
  assert.equal(resultsSmsText({ set, row, student, ...names, language: 'sw' }),
    'Saint Innocent: Matokeo ya mtihani wa Katikati ya muhula, Term 1 2026, ya Amina Achieng (17073), Form 2 West. Wastani 58.4%. English 60%. Ripoti kamili inapatikana shuleni.');
});
