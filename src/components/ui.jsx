import { useEffect, useRef, useState } from 'react';

/**
 * Small shared building blocks. Every page uses these rather than its own
 * markup, so a notice, an empty page, a checkbox or a risk figure looks and
 * reads the same everywhere. Styles live in styles/global.css.
 */

/** A message about the page. tone: info (default) | warn | error | success. */
export function Notice({ tone = 'info', children }) {
  return <div className={`notice${tone === 'info' ? '' : ` ${tone}`}`} role={tone === 'error' ? 'alert' : undefined}>{children}</div>;
}

/** What a page shows when it has nothing to show yet, with the next step. */
export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** The page shown when an action needs the server and there is no saved copy. */
export const Offline = ({ what }) => (
  <EmptyState title="You are offline">{what} needs a connection. Anything you have entered is kept on this device.</EmptyState>
);

/** Small inline SVG icons for table actions. Icons inherit their colour from the surrounding button or link. */
export function ActionIcon({ name }) {
  const paths = {
    archive: (
      <>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v11h14V9M10 13h4" />
      </>
    ),
    check: (
      <path d="m5 12 4 4L19 6" />
    ),
    clipboard: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4.5V3h6v1.5" />
        <path d="M9 10h6M9 14h6M9 18h4" />
      </>
    ),
    download: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5M12 15V3" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    loader: (
      <>
        <path d="M12 2v4" />
        <path d="M12 18v4" />
        <path d="m4.93 4.93 2.83 2.83" />
        <path d="m16.24 16.24 2.83 2.83" />
        <path d="M2 12h4" />
        <path d="M18 12h4" />
        <path d="m4.93 19.07 2.83-2.83" />
        <path d="m16.24 7.76 2.83-2.83" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    plus: (
      <path d="M12 5v14M5 12h14" />
    ),
    restore: (
      <>
        <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    stop: (
      <>
        <circle cx="12" cy="12" r="9" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M8 6V4h8v2" />
        <path d="m19 6-1 14H6L5 6" />
        <path d="M10 11v5M14 11v5" />
      </>
    ),
    unlock: (
      <>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 7.5-2" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="10" cy="7" r="4" />
        <path d="M20 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    x: (
      <path d="m18 6-12 12M6 6l12 12" />
    ),
  };

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

/**
 * A destructive action (delete, deactivate, remove). The only red button in the
 * app: red is reserved for actions that cannot easily be undone. Takes the
 * same props as <button>; type defaults to "button" so it never submits a form.
 */
export function DangerButton({ children, type = 'button', className = '', ...rest }) {
  return (
    <button type={type} className={`btn danger ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** A checkbox that can also show "some selected". */
export function Checkbox({ checked, indeterminate = false, onChange, label }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

/** An "i" that opens a short explanation, so the page itself stays brief. */
export function Info({ label = 'More information', children }) {
  return (
    <details className="info">
      <summary aria-label={label} title={label}>i</summary>
      <div>{children}</div>
    </details>
  );
}

/** A confirmation that disappears by itself. Returns [element, show]. */
export function useToast(ms = 3500) {
  const [text, setText] = useState(null);
  useEffect(() => {
    if (!text) return undefined;
    const t = setTimeout(() => setText(null), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return [text ? <div className="toast" role="status">{text}</div> : null, setText];
}

/** Progress of a background job, such as producing report cards. */
export function Progress({ done = 0, total = 0, label, failed = false }) {
  const share = total ? Math.min(done / total, 1) : 0;
  return (
    <span className={`progress${failed ? ' failed' : ''}`}>
      <span className="track" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span>
      {label ?? `${done} of ${total}`}
    </span>
  );
}

/** An estimated risk as a short bar with its percentage; the mark is the model's threshold. */
export function RiskBar({ probability, threshold, atRisk }) {
  if (probability == null) return <span className="hint">—</span>;
  return (
    <span className={`riskbar${atRisk ? ' at-risk' : ''}`} title={`Flagged at ${Math.round(threshold * 100)}% or more`}>
      <span className="track" aria-hidden="true">
        <i style={{ width: `${probability * 100}%` }} />
        {threshold != null && <span className="tick" style={{ left: `${threshold * 100}%` }} />}
      </span>
      <b className={atRisk ? 'risk' : ''}>{Math.round(probability * 100)}%</b>
    </span>
  );
}

/**
 * What moved an estimate (SHAP), as bars either side of a centre line: right
 * raised the risk, left lowered it. Bar length is each factor's share of the
 * total effect, so the bars add up to the whole explanation.
 * items: [{ key, label, share, direction: 'RAISES'|'LOWERS'|'NONE', note }]
 */
export function InfluenceChart({ items, limit = 5 }) {
  const [all, setAll] = useState(false);
  if (!items?.length) return <span className="hint">No explanation for this estimate.</span>;
  const shown = all ? items : items.slice(0, limit);
  const max = Math.max(...items.map((i) => i.share), 0.0001);
  return (
    <div className="influence">
      <div className="influence-head"><span /><span className="sides"><span>← lowered risk</span><span>raised risk →</span></span><span /></div>
      {shown.map((i) => {
        const width = (i.share / max) * 50;
        const side = i.direction === 'LOWERS' ? 'lowers' : 'raises';
        return (
          <div key={i.key} className="influence-row">
            <span className="name">{i.label}{i.note && <small> · {i.note}</small>}</span>
            <span className="lane" aria-hidden="true">
              {i.direction !== 'NONE' && <i className={`${side}${i.missing ? ' missing' : ''}`} style={{ width: `${width}%` }} />}
            </span>
            <span className={`val ${side}`}>
              {i.direction === 'RAISES' ? '+' : i.direction === 'LOWERS' ? '−' : ''}
              {Math.round(i.share * 100)}%
            </span>
          </div>
        );
      })}
      {items.length > limit && (
        <button type="button" className="btn link" onClick={() => setAll(!all)}>
          {all ? 'Show the main ones' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

/** Average influence (mean absolute SHAP), one-sided: how much each factor moves estimates, in either direction. */
export function ImportanceChart({ items, limit = 9 }) {
  if (!items?.length) return <span className="hint">Nothing to show yet.</span>;
  const total = items.reduce((s, i) => s + i.importance, 0) || 1;
  const max = Math.max(...items.map((i) => i.importance)) || 1;
  return (
    <div className="influence one-sided">
      {items.slice(0, limit).map((i) => (
        <div key={i.name} className="influence-row">
          <span className="name">{i.label}</span>
          <span className="lane" aria-hidden="true"><i style={{ width: `${(i.importance / max) * 100}%` }} /></span>
          <span className="val">{Math.round((i.importance / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A student's estimates through the year as a tiny line, for cards. Drawn at a
 * fixed size, with the threshold dotted and the last point marked.
 * points: [{ prediction_point, probability, threshold }] in checkpoint order
 */
export function Sparkline({ points, width = 120, height = 32 }) {
  if (!points?.length) return null;
  const pad = 4;
  const last = points[points.length - 1];
  // Scaled to this student's estimates and the threshold, not 0-100%, so a rise of a few points is
  // visible at this size; a span of at least 20 points keeps small wobbles looking small.
  const values = [...points.map((p) => p.probability), last.threshold];
  let lo = Math.max(0, Math.min(...values) - 0.05);
  let hi = Math.min(1, Math.max(...values) + 0.05);
  if (hi - lo < 0.2) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(mid - 0.1, 0.8));
    hi = lo + 0.2;
  }
  const x = (i) => (points.length < 2 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1));
  const y = (v) => pad + ((hi - v) / (hi - lo)) * (height - 2 * pad);
  const words = points.map((p) => `${p.prediction_point} ${Math.round(p.probability * 100)}%`).join(', ');
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label={`Estimated risk through the year: ${words}`}>
      <title>{words}</title>
      <line x1={pad} x2={width - pad} y1={y(last.threshold)} y2={y(last.threshold)} className="spark-threshold" />
      <polyline points={points.map((p, i) => `${x(i)},${y(p.probability)}`).join(' ')} fill="none" className="spark-line" />
      <circle cx={x(points.length - 1)} cy={y(last.probability)} r="3" className={last.probability >= last.threshold ? 'spark-dot risk' : 'spark-dot'} />
    </svg>
  );
}

/**
 * A modal question that needs an answer before the page carries on (suspend a
 * school, reset a password). Focus moves into it and stays there, Escape or the
 * backdrop closes it (unless it is busy), and focus returns to whatever opened it.
 */
export function Dialog({ open, title, children, onClose, busy = false, labelId = 'dialog-title' }) {
  const box = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const first = box.current?.querySelector('[data-autofocus], input, textarea, select, button');
    first?.focus();
    return () => opener.current?.focus?.();
  }, [open]);

  if (!open) return null;

  function onKeyDown(e) {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      onClose();
    }
    if (e.key !== 'Tab') return;
    const items = [...box.current.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')];
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div className="backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelId} ref={box} onKeyDown={onKeyDown}>
        <h2 id={labelId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
