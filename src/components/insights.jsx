/*
 * Small pieces shared by the dashboard and the Insights pages (Risk prediction,
 * School risk), so every number tile, share bar and loading placeholder looks
 * the same as the class page they sit beside.
 */

/**
 * One figure in a row of `.stats` tiles. Every tile's value is the same size;
 * a change is drawn as an arrow and a number at that size, never as small text.
 *
 * @param {{ value?: import('react').ReactNode, of?: number|null, label: string, tone?: 'risk'|'',
 *   delta?: number|null, lowerIsBetter?: boolean, sub?: string|null }} props
 *   delta: a change since the last checkpoint (replaces value); lowerIsBetter colours a rise as risk.
 */
export function StatTile({ value, of = null, label, tone = '', delta, lowerIsBetter = true, sub = null }) {
  if (delta !== undefined) {
    const d = delta;
    const dir = d == null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down';
    const worse = dir === 'flat' ? null : (dir === 'up') === lowerIsBetter;
    const words = d == null ? 'no earlier checkpoint' : d === 0 ? 'no change' : `${dir === 'up' ? 'up' : 'down'} ${Math.abs(d)}`;
    return (
      <div className="stat">
        <b className={`stat-delta ${dir}${worse === true ? ' worse' : worse === false ? ' better' : ''}`} aria-label={words}>
          {dir === 'up' && <Arrow up />}
          {dir === 'down' && <Arrow />}
          {d == null ? '—' : dir === 'flat' ? '0' : Math.abs(d)}
        </b>
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div className={`stat${tone ? ` ${tone}` : ''}`}>
      <b>{value}{of != null && <small>/{of}</small>}</b>
      <span>{label}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function Arrow({ up = false }) {
  return (
    <svg className="arrow" viewBox="0 0 16 16" aria-hidden="true">
      <path d={up ? 'M8 3 L13 9 H9.5 V13 H6.5 V9 H3 Z' : 'M8 13 L3 7 H6.5 V3 H9.5 V7 H13 Z'} />
    </svg>
  );
}

/** A 0-100% bar, as on the class page. */
export function Meter({ value, max = 1, mark = null, tone = '' }) {
  const width = Math.max(0, Math.min(100, ((value ?? 0) / (max || 1)) * 100));
  return (
    <span className={`meter ${tone}`} aria-hidden="true">
      <span className="fill" style={{ width: `${width}%` }} />
      {Number.isFinite(mark) && <span className="mark" style={{ left: `${Math.min(100, Math.max(0, mark))}%` }} />}
    </span>
  );
}

/**
 * Each factor's share of what moved the estimates (mean |SHAP|), as the class
 * page's "Top risk factors": name, bar, percentage. Bars are scaled to the
 * largest factor so differences are visible; the number is the true share.
 */
export function ShareBars({ items, limit = 9, label = 'Share of influence' }) {
  if (!items?.length) return <p className="hint">Nothing to show yet.</p>;
  const total = items.reduce((s, i) => s + i.importance, 0) || 1;
  const top = items.slice(0, limit);
  const max = Math.max(...top.map((i) => i.importance)) || 1;
  return (
    <ol className="factor-list share-bars" aria-label={label}>
      {top.map((i) => {
        const share = Math.round((i.importance / total) * 100);
        return (
          <li key={i.name} aria-label={`${i.label}: ${share}%`}>
            <span className="s-name" title={i.label}>{i.label}</span>
            <Meter value={i.importance} max={max} />
            <span className="s-value">{share}%</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Grey placeholder blocks shown while a page's first data loads, in the shape of what will arrive. */
export function Skeleton({ lines = 3, tiles = 0, label = 'Loading', bare = false }) {
  return (
    <div className="skeleton-wrap" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      {tiles > 0 && (
        <div className="stats" aria-hidden="true">
          {Array.from({ length: tiles }, (_, i) => <div key={i} className="stat"><span className="skeleton tile" /></div>)}
        </div>
      )}
      <div className={bare ? 'stack' : 'card stack'} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton line" style={{ width: `${92 - (i % 3) * 14}%` }} />)}
      </div>
    </div>
  );
}
