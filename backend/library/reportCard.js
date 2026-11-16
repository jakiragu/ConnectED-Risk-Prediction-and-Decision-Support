import { CHECKPOINT_LABEL, CHECKPOINTS, RESULT_KIND } from './results.js';
import { componentTypeOf } from './assessment.js';
import { PAGE, PdfDocument, fit, textWidth, wrap } from './pdf.js';
import { examName, t } from './language.js';

export const REPORT_KIND = { OFFICIAL: 'OFFICIAL', PROVISIONAL: 'PROVISIONAL' };
export const reportKindOf = (resultKind) =>
  resultKind === RESULT_KIND.FINAL ? REPORT_KIND.OFFICIAL : REPORT_KIND.PROVISIONAL;

/**
 * Whether the term result reaches the pass mark: the same test promotion uses
 * to decide who repeats (term mean below the pass mark). null when either is unknown.
 */
export function passVerdict(termAverage, passMark) {
  if (!Number.isFinite(termAverage) || !Number.isFinite(passMark)) return null;
  return termAverage >= passMark;
}

const C = {
  ink: '#0A4C55', body: '#1F2D2F', muted: '#5B6B6E', line: '#C9DDE0', pale: '#E4F6FA', zebra: '#F3FAFC', white: '#FFFFFF',
  pass: '#1E6B43', passBg: '#E2F3E8', below: '#9A4A0B', belowBg: '#FCEBD9', note: '#FFF4E0', noteLine: '#E8B86A',
};
const M = 40; // page margin
const W = PAGE.width - 2 * M;
const FOOTER = 800; // content stops above the footer

const one = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '-' : (Math.round(Number(n) * 10) / 10).toFixed(1));
const two = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '-' : Number(n).toFixed(2));
const MARK_TEXT = { ABSENT: 'ABS', NOT_ASSESSED: 'N/A', MISSING: '-' };
const markText = (p) => (p.mark_status === 'SCORED' ? `${p.raw_score}/${p.max_score}` : MARK_TEXT[p.mark_status] || '-');

/**
 * The report card as a PDF.
 * @param {object} model     from reportCardModel()
 * @param {object} options
 * @param {string} options.language  'en' | 'sw'
 * @param {number} [options.passMark] the term's pass mark (final report only)
 */
export function renderReportCard(model, { language = 'en', passMark = null } = {}) {
  const official = model.kind === RESULT_KIND.FINAL;
  const L = (key, vars) => t(language, key, vars);
  const exam = (c) => examName(language, c, model.labels && model.labels[c] !== CHECKPOINT_LABEL[c] ? model.labels : null);
  const doc = new PdfDocument();
  let y = 0;

  // ---- Header band
  doc.rect(0, 0, PAGE.width, 84, { fill: C.ink });
  doc.text(M, 22, fit(model.school_name, W, { bold: true, size: 18 }), { bold: true, size: 18, color: C.white });
  const title = official ? L('card.final') : L('card.provisional', { label: exam(model.checkpoint) });
  doc.text(M, 50, title.toUpperCase(), { bold: true, size: 10.5, color: '#BFE6EE' });
  y = 100;

  // ---- Who and when
  const cells = [
    [L('card.student'), model.student_name, 205],
    [L('card.admission'), model.admission_no ?? '-', 100],
    [L('card.class'), model.class_name, 100],
    [L('card.term'), model.term_name, W - 405],
  ];
  doc.rect(M, y, W, 44, { stroke: C.line });
  let x = M;
  for (const [i, [label, value, w]] of cells.entries()) {
    if (i) doc.line(x, y + 8, x, y + 36);
    doc.text(x + 10, y + 9, label, { size: 7.5, color: C.muted });
    doc.text(x + 10, y + 21, fit(value, w - 18, { bold: true, size: 11 }), { bold: true, size: 11, color: C.body });
    x += w;
  }
  y += 50;
  const published = model.published_at ? model.published_at.slice(0, 10) : '-';
  doc.text(M, y, `${L('card.published', { date: published })}   ·   ${L('card.ref', { ref: model.calculation_id })}`, { size: 7.5, color: C.muted });
  y += 20;

  // ---- Summary: what a parent looks for first
  if (official) {
    const passed = passVerdict(model.term_average, passMark);
    const tile = (W - 20) / 3;
    const tiles = [
      [L('card.mean'), one(model.term_average)],
      [L('card.overallGrade'), model.term_grade ?? '-'],
    ];
    tiles.forEach(([label, value], i) => {
      const tx = M + i * (tile + 10);
      doc.rect(tx, y, tile, 58, { fill: C.pale });
      doc.text(tx + 14, y + 11, label, { size: 8, color: C.muted });
      doc.text(tx + 14, y + 25, value, { bold: true, size: 22, color: C.ink });
    });
    const tx = M + 2 * (tile + 10);
    const verdict = passed === null ? '-' : passed ? L('card.passed') : L('card.below', { mark: passMark });
    const tone = passed === false ? [C.below, C.belowBg] : passed ? [C.pass, C.passBg] : [C.muted, C.pale];
    doc.rect(tx, y, tile, 58, { fill: tone[1] });
    doc.rect(tx, y, 4, 58, { fill: tone[0] });
    doc.text(tx + 14, y + 11, L('card.result'), { size: 8, color: C.muted });
    let size = 16;
    while (size > 9 && textWidth(verdict, { bold: true, size }) > tile - 24) size -= 0.5;
    doc.text(tx + 14, y + 25, verdict, { bold: true, size, color: tone[0] });
    if (Number.isFinite(passMark)) doc.text(tx + 14, y + 44, L('card.passMark', { mark: passMark }), { size: 7.5, color: C.muted });
    y += 74;
  } else {
    const lines = wrap(L('card.provisionalNote'), W - 28, { bold: true, size: 9 });
    const h = 14 + lines.length * 12;
    doc.rect(M, y, W, h, { fill: C.note });
    doc.rect(M, y, 4, h, { fill: C.noteLine });
    lines.forEach((l, i) => doc.text(M + 14, y + 8 + i * 12, l, { bold: true, size: 9, color: '#6B4A12' }));
    y += h + 10;
    doc.rect(M, y, 200, 50, { fill: C.pale });
    doc.text(M + 14, y + 10, L('card.examMean', { label: exam(model.checkpoint) }), { size: 8, color: C.muted });
    doc.text(M + 14, y + 22, `${one(model.checkpoint_average)}%`, { bold: true, size: 20, color: C.ink });
    y += 66;
  }

  // ---- Subjects table: one row per subject
  const shown = model.subjects[0]?.checkpoints.map((c) => c.checkpoint) ?? [];
  const cols = [{ head: L('card.subject'), w: 0, align: 'left' }];
  for (const c of shown) cols.push({ head: exam(c), w: 78, align: 'center' });
  if (official) cols.push({ head: L('card.termScore'), w: 78, align: 'center', strong: true }, { head: L('card.grade'), w: 52, align: 'center', strong: true });
  cols[0].w = W - cols.slice(1).reduce((a, c) => a + c.w, 0);

  const row = (values, { head = false, bold = false, fill = null, h = 20 } = {}) => {
    if (fill) doc.rect(M, y, W, h, { fill });
    let cx = M;
    values.forEach((v, i) => {
      const col = cols[i];
      const style = { bold: head || bold || col.strong, size: head ? 8 : 9.5 };
      const color = head ? C.white : col.strong || bold ? C.ink : C.body;
      // Column titles may take two lines (long exam names, Kiswahili); values are shortened to fit.
      const lines = head ? wrap(v, col.w - 10, style).slice(0, 2) : [fit(v, col.w - 12, style)];
      lines.forEach((text, n) => {
        const ty = y + (h - lines.length * (style.size + 2)) / 2 + n * (style.size + 2) + 1;
        if (col.align === 'left') doc.text(cx + 8, ty, text, { ...style, color });
        else doc.text(cx + col.w / 2, ty, text, { ...style, color, align: 'center' });
      });
      cx += col.w;
    });
    y += h;
  };

  const twoLine = cols.some((c) => wrap(c.head, c.w - 10, { bold: true, size: 8 }).length > 1);
  const headH = twoLine ? 30 : 24;
  row(cols.map((c) => c.head), { head: true, fill: C.ink, h: headH });
  model.subjects.forEach((s, i) => {
    const values = [s.subject, ...s.checkpoints.map((c) => one(c.score))];
    if (official) values.push(one(s.term_score), s.grade ?? '-');
    row(values, { fill: i % 2 ? C.zebra : null });
  });
  doc.line(M, y, M + W, y, { color: C.ink, width: 1 });
  const averages = model.checkpoint_averages || {};
  const meanRow = [L('card.meanRow'), ...shown.map((c) => one(averages[c] ?? (c === model.checkpoint ? model.checkpoint_average : null)))];
  if (official) meanRow.push(one(model.term_average), model.term_grade ?? '-');
  row(meanRow, { bold: true, fill: C.pale, h: 22 });
  doc.rect(M, y - 22 - headH - model.subjects.length * 20, W, headH + model.subjects.length * 20 + 22, { stroke: C.line });

  if (official) {
    const w = model.checkpoint_weights || {};
    const held = model.held || CHECKPOINTS;
    y += 8;
    doc.text(M, y, L('card.weights', { parts: held.map((c) => `${exam(c)} ${w[c] ?? '-'}%`).join(' + ') }), { size: 8, color: C.muted });
    y += 12;
  }
  y += 18;

  // ---- Breakdown: each subject's components, two cards per row
  const ensure = (h) => {
    if (y + h <= FOOTER) return;
    doc.addPage();
    doc.text(M, 32, L('card.continued', { name: model.student_name }), { size: 8, color: C.muted });
    doc.text(PAGE.width - M, 32, `${model.school_name} · ${model.term_name}`, { size: 8, color: C.muted, align: 'right' });
    doc.line(M, 46, M + W, 46);
    y = 60;
  };

  const note = wrap(L('card.breakdownNote'), W, { size: 8 });
  ensure(30 + note.length * 10 + 120);
  doc.text(M, y, L('card.breakdown'), { bold: true, size: 13, color: C.ink });
  y += 20;
  note.forEach((l) => { doc.text(M, y, l, { size: 8, color: C.muted }); y += 10; });
  y += 8;

  const GAP = 12;
  const CW = (W - GAP) / 2;
  const cc = [{ w: CW - 170, align: 'left' }, { w: 55 }, { w: 45 }, { w: 50 }];
  const cardHeight = (s) => 22 + 15 + s.checkpoints.reduce((h, c) => h + 17 + Math.max(c.papers.length, 1) * 14, 0) + 4;

  const drawCard = (s, x0, y0) => {
    const h = cardHeight(s);
    doc.rect(x0, y0, CW, h, { stroke: C.line });
    doc.rect(x0, y0, CW, 22, { fill: C.pale });
    doc.text(x0 + 10, y0 + 6, fit(s.subject, CW - 20, { bold: true, size: 10 }), { bold: true, size: 10, color: C.ink });
    let cy = y0 + 26;
    const cells = (values, { bold = false, color = C.body, size = 8.5 } = {}) => {
      let cx = x0 + 10;
      values.forEach((v, i) => {
        const col = cc[i];
        if (col.align === 'left') doc.text(cx, cy, fit(v, col.w - 6, { bold, size }), { bold, size, color });
        else doc.text(cx + col.w - 4, cy, v, { bold, size, color, align: 'right' });
        cx += col.w;
      });
    };
    cells([L('card.component'), L('card.score'), L('card.share'), L('card.points')], { size: 7, color: C.muted });
    cy += 13;
    for (const c of s.checkpoints) {
      doc.line(x0 + 8, cy - 2, x0 + CW - 8, cy - 2);
      const label = exam(c.checkpoint);
      doc.text(x0 + 10, cy + 2, label, { bold: true, size: 8.5, color: C.ink });
      doc.text(x0 + CW - 14, cy + 2, `${one(c.score)}%`, { bold: true, size: 8.5, color: C.ink, align: 'right' });
      cy += 15;
      if (!c.papers.length) { cells(['-', '-', '-', '-'], { color: C.muted }); cy += 14; continue; }
      for (const p of c.papers) {
        const type = componentTypeOf(p);
        cells([`${t(language, `component.${type}`)} ${p.paper_no ?? ''}`.trim(), markText(p), `${p.weight}%`, two(p.contribution)],
          { color: p.mark_status === 'SCORED' ? C.body : C.muted });
        cy += 14;
      }
    }
  };

  for (let i = 0; i < model.subjects.length; i += 2) {
    const pair = model.subjects.slice(i, i + 2);
    const h = Math.max(...pair.map(cardHeight));
    ensure(h);
    pair.forEach((s, j) => drawCard(s, M + j * (CW + GAP), y));
    y += h + GAP;
  }

  // ---- Footer on every page
  const pages = doc.pages.length;
  doc.pages.forEach((ops, i) => {
    doc.ops = ops;
    doc.line(M, 812, M + W, 812);
    doc.text(M, 818, L('card.key'), { size: 7, color: C.muted });
    doc.text(PAGE.width - M, 818, L('card.page', { n: i + 1, of: pages }), { size: 7, color: C.muted, align: 'right' });
  });
  if (!official) doc.watermark(L('card.watermark'));
  return doc.toBuffer();
}
