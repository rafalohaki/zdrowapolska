import { formatDaysShort, plural, waitLevel } from '../lib/wait';

// miękkie pigułki (jak WAIT_PILL w FacilitiesView) — biały tekst na lime-500
// miał kontrast ~2:1, poniżej progu AA
const STYLES: Record<string, string> = {
  great: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  ok: 'bg-lime-100 text-lime-800 dark:bg-lime-500/15 dark:text-lime-300',
  slow: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  bad: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  unknown: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const LABELS: Record<string, string> = {
  great: 'szybko',
  ok: 'w miarę szybko',
  slow: 'dłuższa kolejka',
  bad: 'długa kolejka',
  unknown: 'brak danych',
};

export function WaitBadge({ days, size = 'md' }: { days: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const level = waitLevel(days);
  const pad = size === 'lg' ? 'px-4 py-2 text-xl' : size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  // tooltip dokłada dokładną liczbę dni — badge zaokrągla („~3 mies."),
  // więc samo powtórzenie etykiety nic by nie wnosiło
  const title =
    days === null
      ? 'Czas oczekiwania: brak danych'
      : `Czas oczekiwania: ${days} ${plural(days, 'dzień', 'dni', 'dni')} (${LABELS[level]})`;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full font-semibold tabular-nums ${STYLES[level]} ${pad}`}
      title={title}
    >
      {formatDaysShort(days)}
      {size !== 'sm' && <span className="font-normal opacity-90">· {LABELS[level]}</span>}
    </span>
  );
}
