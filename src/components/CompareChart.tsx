import type { Facility } from '../lib/types';
import { formatDaysShort, plural, waitLevel } from '../lib/wait';

// kolory słupków = te same poziomy co WaitBadge (spójny język „jak długo czeka")
const BAR_COLOR: Record<string, string> = {
  great: 'bg-emerald-500',
  ok: 'bg-lime-500',
  slow: 'bg-amber-400',
  bad: 'bg-rose-500',
  unknown: 'bg-slate-300 dark:bg-slate-600',
};

export type ProvinceStat = {
  code: string;
  name: string;
  bestDays: number | null;
  facilities: number;
};

/** Statystyki per województwo: najkrótszy czas oczekiwania (z już przefiltrowanych placówek). */
export function provinceStats(facilities: Facility[]): ProvinceStat[] {
  const map = new Map<string, { name: string; best: number | null; count: number }>();
  for (const f of facilities) {
    const cur = map.get(f.province) ?? { name: f.provinceName, best: null, count: 0 };
    cur.count++;
    if (f.days !== null && (cur.best === null || f.days < cur.best)) cur.best = f.days;
    map.set(f.province, cur);
  }
  return [...map.entries()]
    .map(([code, v]) => ({ code, name: v.name, bestDays: v.best, facilities: v.count }))
    .sort((a, b) => (a.bestDays ?? 9_999_999) - (b.bestDays ?? 9_999_999));
}

export function CompareChart({
  stats,
  selected,
  onSelect,
  loadingProgress,
  reference,
}: {
  stats: ProvinceStat[];
  selected: string;
  onSelect: (code: string | null) => void;
  loadingProgress?: string;
  /** mediana dni oczekiwania wszystkich pobranych placówek — linia odniesienia */
  reference?: number | null;
}) {
  const max = Math.max(...stats.map((s) => s.bestDays ?? 0), reference ?? 0, 1);
  const refPct = reference != null ? Math.min((reference / max) * 100, 100) : null;

  return (
    <div className="animate-fade-up rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          Najkrótsza kolejka w województwie
          {loadingProgress && (
            <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 align-middle text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              {loadingProgress}
            </span>
          )}
        </h2>
        {selected !== 'all' && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            ← pokaż całą Polskę
          </button>
        )}
      </div>

      <ul className="space-y-2.5">
        {stats.map((s) => {
          const days = s.bestDays;
          const width = days === null ? 0 : days === 0 ? 5 : Math.max((days / max) * 100, 4);
          const color = BAR_COLOR[waitLevel(days)];
          const isSel = selected === s.code;
          return (
            <li key={s.code}>
              <button
                type="button"
                onClick={() => onSelect(isSel ? null : s.code)}
                className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1 text-left transition ${
                  isSel
                    ? 'bg-brand-50 dark:bg-brand-900/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 dark:bg-slate-800/50'
                }`}
                title={`Filtruj: ${s.name}`}
              >
                <span className="w-28 shrink-0 truncate text-sm text-slate-600 dark:text-slate-300 sm:w-44">{s.name}</span>
                <span className="relative h-6 flex-1 overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
                  <span
                    className={`absolute inset-y-0 left-0 rounded-md transition-all ${color} ${
                      isSel ? 'opacity-100' : 'opacity-85 group-hover:opacity-100'
                    }`}
                    style={{ width: `${width}%` }}
                  />
                  {refPct !== null && (
                    <span
                      className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-rose-400/90"
                      style={{ left: `${refPct}%` }}
                      title={`Mediana PL: ${formatDaysShort(reference!)}`}
                    />
                  )}
                </span>
                <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100 sm:w-24">
                  {formatDaysShort(s.bestDays)}
                </span>
                <span className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400 sm:block">
                  {s.facilities} {plural(s.facilities, 'placówka', 'placówki', 'placówek')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Wartość = najkrótszy czas oczekiwania spośród pobranych placówek w województwie. Kliknij, aby
        przefiltrować ranking.
        {refPct !== null && (
          <>
            {' '}
            <span className="text-rose-500 dark:text-rose-400">┆</span> przerywana linia = mediana
            wszystkich pobranych placówek ({formatDaysShort(reference!)}).
          </>
        )}
      </p>
    </div>
  );
}
