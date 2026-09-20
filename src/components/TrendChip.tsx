import { useEffect, useState } from 'react';
import { fetchTrend, type TrendResponse } from '../lib/api';

/** Pasek trendu kolejki: sparkline sumy oczekujących + delta pierwszy↔ostatni pomiar. */
export function TrendChip({
  benefit,
  kase,
  locality,
}: {
  benefit: string;
  kase: number;
  locality: string;
}) {
  const [trend, setTrend] = useState<TrendResponse | null>(null);

  useEffect(() => {
    setTrend(null); // bez tego pod nową frazą wisiałby sparkline z poprzedniego świadczenia
    const ctrl = new AbortController();
    fetchTrend(benefit, kase, locality, ctrl.signal)
      .then(setTrend)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [benefit, kase, locality]);

  const pts = trend?.points ?? [];
  if (pts.length === 0) return null;

  const W = 72;
  const H = 22;
  const max = Math.max(...pts.map((p) => p.total), 1);
  const xy = pts.map(
    (p, i) => [pts.length > 1 ? (i / (pts.length - 1)) * W : W / 2, H - (p.total / max) * (H - 3) - 1.5] as const,
  );
  const up = (trend?.deltaTotal ?? 0) > 0;
  const hasDelta = trend?.deltaPct !== null && trend?.deltaPct !== undefined && pts.length > 1;

  return (
    <div
      className="mt-1 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"
      title={`Historia sumy oczekujących${trend?.from ? ` od ${trend.from}` : ''} — pomiar dzienny z synchronizacji NFZ`}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="shrink-0">
        {pts.length > 1 ? (
          <polyline
            points={xy.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="none"
            stroke={up ? '#f43f5e' : '#059669'}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        ) : (
          <circle cx={xy[0]?.[0] ?? W / 2} cy={xy[0]?.[1] ?? H / 2} r="2.5" fill="#059669" />
        )}
        <circle
          cx={xy[xy.length - 1]?.[0] ?? W / 2}
          cy={xy[xy.length - 1]?.[1] ?? H / 2}
          r="2"
          fill={up ? '#f43f5e' : '#059669'}
        />
      </svg>
      {hasDelta ? (
        trend!.deltaTotal === 0 ? (
          <span>kolejka stabilna od {trend!.from}</span>
        ) : (
          <span>
            kolejka {up ? 'rośnie' : 'maleje'}{' '}
            <strong className={up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
              {up ? '+' : ''}
              {trend!.deltaPct}%
            </strong>{' '}
            od {trend!.from}
          </span>
        )
      ) : (
        <span>trend: pierwszy pomiar — historia narasta z każdą synchronizacją</span>
      )}
    </div>
  );
}
