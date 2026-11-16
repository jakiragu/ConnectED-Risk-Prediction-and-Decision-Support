/**
 * Minimal text-only PDF 1.4 writer (Courier, A4). Report cards are tabular
 * plain text, so this avoids a rendering dependency inside the Lambda bundle.
 * Lines: string | { text, bold }.
 */
const esc = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);

const LINES_PER_PAGE = 54;

export function renderPdf(lines, { watermark = null } = {}) {
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // 1 catalog, 2 pages, 3 Courier, 4 Courier-Bold, then (page, content) pairs.
  const objects = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>');

  for (const [i, page] of pages.entries()) {
    const mark = watermark
      ? `q 0.85 g BT /F2 64 Tf 0.7071 0.7071 -0.7071 0.7071 120 230 Tm (${esc(watermark)}) Tj ET Q\n`
      : '';
    const body = page
      .map((l) => {
        const line = typeof l === 'string' ? { text: l } : l;
        return `${line.bold ? '/F2' : '/F1'} 10 Tf (${esc(line.text)}) Tj T*`;
      })
      .join('\n');
    const footer = `BT /F1 8 Tf 50 30 Td (Page ${i + 1} of ${pages.length}${watermark ? ` - ${esc(watermark)}` : ''}) Tj ET`;
    const stream = `${mark}BT 14 TL 50 800 Td\n${body}\nET\n${footer}`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
/* ------------------------------------------------------------------------
 * Drawn documents: boxes, rules, shaded rows and proportional text.
 * Still no dependency: the standard Helvetica fonts every PDF reader has, with
 * their published character widths so text can be right-aligned and fitted.
 * Coordinates are in points from the top-left of an A4 page (595 x 842).
 * ---------------------------------------------------------------------- */

export const PAGE = { width: 595, height: 842 };

// Helvetica and Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126, from the Adobe AFM files.
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Typographic characters the fonts carry in WinAnsiEncoding, by their code there.
const WIN_ANSI = { '–': 150, '—': 151, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '…': 133, '·': 183 };

/** One character's code in the font, or null when it has none (shown as "?"). */
function code(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return c;
  if (WIN_ANSI[ch]) return WIN_ANSI[ch];
  if (c >= 160 && c <= 255) return c; // Latin-1 letters, e.g. é
  return null;
}

export function textWidth(text, { bold = false, size = 10 } = {}) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of String(text)) {
    const c = code(ch) ?? 63;
    w += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (w * size) / 1000;
}

const encode = (text) => [...String(text)].map((ch) => {
  const c = code(ch) ?? 63;
  if (c === 40 || c === 41 || c === 92) return `\\${ch}`;
  return c >= 32 && c <= 126 ? ch : `\\${c.toString(8).padStart(3, '0')}`;
}).join('');

/** Shortens text with "..." until it fits `width`. */
export function fit(text, width, style) {
  let s = String(text ?? '');
  if (textWidth(s, style) <= width) return s;
  while (s.length > 1 && textWidth(`${s}...`, style) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

/** Breaks text into lines no wider than `width`. */
export function wrap(text, width, style) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, style) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const rgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(' ');
};
const pt = (n) => Number(n.toFixed(2));

export class PdfDocument {
  constructor() {
    this.pages = [];
    this.addPage();
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
  }

  text(x, y, text, { bold = false, size = 10, color = '#1F2D2F', align = 'left' } = {}) {
    const w = textWidth(text, { bold, size });
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    // y is the top of the line; PDF places text by its baseline.
    this.ops.push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${pt(left)} ${pt(PAGE.height - y - size * 0.8)} Td (${encode(text)}) Tj ET`);
    return w;
  }

  rect(x, y, w, h, { fill = null, stroke = null, width = 0.75 } = {}) {
    const box = `${pt(x)} ${pt(PAGE.height - y - h)} ${pt(w)} ${pt(h)} re`;
    if (fill && stroke) this.ops.push(`q ${rgb(fill)} rg ${rgb(stroke)} RG ${width} w ${box} B Q`);
    else if (fill) this.ops.push(`q ${rgb(fill)} rg ${box} f Q`);
    else if (stroke) this.ops.push(`q ${rgb(stroke)} RG ${width} w ${box} S Q`);
  }

  line(x1, y1, x2, y2, { color = '#C9DDE0', width = 0.75 } = {}) {
    this.ops.push(`q ${rgb(color)} RG ${width} w ${pt(x1)} ${pt(PAGE.height - y1)} m ${pt(x2)} ${pt(PAGE.height - y2)} l S Q`);
  }

  /** Large see-through diagonal text over every page: shaded rows cannot hide it, and the text under it stays readable. */
  watermark(text) {
    const size = Math.min(80, 640 / Math.max(textWidth(text, { bold: true, size: 1 }), 1));
    for (const ops of this.pages) {
      ops.push(`q /GSw gs 0.55 0.55 0.55 rg BT /F2 ${pt(size)} Tf 0.7071 0.7071 -0.7071 0.7071 120 190 Tm (${encode(text)}) Tj ET Q`);
    }
  }

  toBuffer() {
    const objects = [];
    const kids = this.pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const [i, ops] of this.pages.entries()) {
      const stream = ops.join('\n');
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GSw << /ca 0.13 >> >> >> /Contents ${6 + i * 2} 0 R >>`
      );
      objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    }
    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
