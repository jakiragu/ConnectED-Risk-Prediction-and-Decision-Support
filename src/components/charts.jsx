import { useEffect, useRef, useState } from 'react';

/*
 * Charts for the class page and Settings, drawn like LineChart: at the measured
 * width of their container, so text stays the same readable size in a narrow
 * or a wide card. Each chart sits in a ChartCard that says what it shows.
 */

/** The width of an element, kept up to date as the layout changes. */
export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * A chart's frame: title, one line saying what it shows, the chart, and its legend.
 * actions (optional) sits at the right of the title, for a chart's own controls.
 */
export function ChartCard({ title, subtitle, legend, actions = null, children, className = '' }) {
  return (
    <section className={`chart-card ${className}`}>
      <header className={actions ? 'with-actions' : undefined}>
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="chart-sub">{subtitle}</p>}
        </div>
        {actions && <div className="chart-actions">{actions}</div>}
      </header>
      <div className="chart-body">{children}</div>
      {legend?.length > 0 && (
        <ul className="chart-legend" aria-label="Legend">
          {legend.map((l) => (
            <li key={l.label}><span className={`swatch ${l.kind || ''}`} style={l.color ? { background: l.color, borderColor: l.color } : undefined} />{l.label}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const SERIES_COLORS = ['#0a4c55', '#14b4c8', '#7a5c9e'];

/** Rounds a maximum up to a tidy scale with whole-number ticks. */
function niceScale(max) {
  const top = Math.max(4, max);
  const step = top <= 8 ? 2 : top <= 20 ? 5 : top <= 50 ? 10 : 20;
  const ceil = Math.ceil(top / step) * step;
  return { max: ceil, ticks: Array.from({ length: ceil / step + 1 }, (_, i) => i * step) };
}

const PAD = { t: 14, r: 16, b: 42, l: 48 };

/**
 * Counts across ordered ranges, one translucent area per series, overlaid so
 * two exams can be compared at a glance (the wireframe's distribution charts).
 * Hover or focus a range for the exact numbers.
 *
 * @param {{ ranges: string[], series: {label:string, counts:number[]}[], xLabel: string, yLabel?: string,
 *   marker?: {index:number, label:string}, height?: number, title: string }} props
 *   marker draws a dashed vertical line at the start of range `index` (e.g. the risk threshold).
 */
export function AreaChart({ ranges, series, xLabel, yLabel = 'No. of students', marker = null, height = 260, title }) {
  const [box, width] = useWidth();
  const [focus, setFocus] = useState(null);
  const n = ranges.length;
  const plotW = Math.max(width - PAD.l - PAD.r, 80);
  const plotH = height - PAD.t - PAD.b;
  const { max, ticks } = niceScale(Math.max(0, ...series.flatMap((s) => s.counts)));
  const x = (i) => PAD.l + (n < 2 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v) => PAD.t + (1 - v / max) * plotH;
  const base = y(0);
  const every = width && width < 520 ? 2 : 1;   // fewer range labels in a narrow card

  return (
    <div className="areachart" ref={box}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${title}: ${series.map((s) => `${s.label} ${s.counts.join(', ')}`).join('; ')}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.l} x2={PAD.l + plotW} y1={y(t)} y2={y(t)} />
              <text className="tick" x={PAD.l - 8} y={y(t) + 4} textAnchor="end">{t}</text>
            </g>
          ))}
          <text className="axis-label" transform={`translate(14 ${PAD.t + plotH / 2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
          {/* Counted from the last range, so the last label always shows and none overlap. */}
          {ranges.map((r, i) => (n - 1 - i) % every === 0 && (
            <text key={r} className="tick" x={x(i)} y={base + 16} textAnchor="middle">{r}</text>
          ))}
          <text className="axis-label" x={PAD.l + plotW / 2} y={height - 4} textAnchor="middle">{xLabel}</text>

          {marker && (
            <g className="marker">
              <line x1={x(marker.index)} x2={x(marker.index)} y1={PAD.t} y2={base} />
              <text x={x(marker.index) + 6} y={PAD.t + 10}>{marker.label}</text>
            </g>
          )}

          {series.map((s, k) => {
            const pts = s.counts.map((c, i) => [x(i), y(c)]);
            const color = s.color || SERIES_COLORS[k % SERIES_COLORS.length];
            const area = `M${x(0)},${base} ${pts.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${x(n - 1)},${base} Z`;
            return (
              <g key={s.label}>
                <path d={area} fill={color} fillOpacity={series.length > 1 ? 0.45 : 0.6} />
                <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth="2" />
                {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={focus === i ? 4.5 : 3} fill={color} />)}
              </g>
            );
          })}

          {focus !== null && <line className="focus-line" x1={x(focus)} x2={x(focus)} y1={PAD.t} y2={base} />}

          {/* One invisible column per range picks up hover and keyboard focus for the tooltip. */}
          {ranges.map((r, i) => {
            const half = n < 2 ? plotW / 2 : plotW / (n - 1) / 2;
            return (
              <rect key={r} x={x(i) - half} y={PAD.t} width={half * 2} height={plotH} fill="transparent"
                tabIndex={0} aria-label={`${r}: ${series.map((s) => `${s.label} ${s.counts[i]}`).join(', ')}`}
                onMouseEnter={() => setFocus(i)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(i)} onBlur={() => setFocus(null)} />
            );
          })}

          {focus !== null && (() => {
            const w = 150;
            const h = 26 + series.length * 18;
            const left = Math.min(Math.max(x(focus) - w / 2, PAD.l), PAD.l + plotW - w);
            return (
              <g pointerEvents="none">
                <rect className="tip" x={left} y={PAD.t} width={w} height={h} rx="6" />
                <text className="tip-text strong" x={left + 10} y={PAD.t + 18}>{ranges[focus]}</text>
                {series.map((s, k) => (
                  <text key={s.label} className="tip-text" x={left + 10} y={PAD.t + 36 + k * 18}>
                    {s.label}: {s.counts[focus]} student{s.counts[focus] === 1 ? '' : 's'}
                  </text>
                ))}
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

/** The grading scale as one bar from 0 to 100, each grade labelled in its segment. */
export function ScaleBar({ bands, passMark = null }) {
  const [box, width] = useWidth();
  const sorted = [...(bands || [])].sort((a, b) => a.min_score - b.min_score);
  if (!sorted.length) return null;
  const H = 54;
  const x = (v) => 4 + (v / 101) * (width - 8);
  return (
    <div className="scalebar" ref={box}>
      {width > 0 && (
        <svg width={width} height={H} role="img"
          aria-label={`Grading scale: ${[...sorted].reverse().map((b) => `${b.grade} from ${b.min_score} to ${b.max_score}`).join(', ')}`}
        >
          {sorted.map((b, i) => {
            const x1 = x(b.min_score);
            const x2 = x(b.max_score + 1);
            return (
              <g key={b.grade}>
                <rect className={`segment s${i % 2}`} x={x1} width={Math.max(1, x2 - x1 - 1)} y={4} height={26} rx="3" />
                {x2 - x1 > 22 && <text className="segment-label" x={(x1 + x2) / 2} y={22} textAnchor="middle">{b.grade}</text>}
                <text className="segment-tick" x={x1} y={46} textAnchor={i === 0 ? 'start' : 'middle'}>{b.min_score}</text>
              </g>
            );
          })}
          <text className="segment-tick" x={x(101)} y={46} textAnchor="end">100</text>
          {Number.isFinite(passMark) && <line className="pass-tick" x1={x(passMark)} x2={x(passMark)} y1={0} y2={34} />}
        </svg>
      )}
    </div>
  );
}
