import { formatDaysShort, waitLevel } from '../lib/wait';

const STYLES: Record<string, string> = {
  great: 'bg-emerald-500',
  ok: 'bg-lime-500',
  slow: 'bg-amber-500',
  bad: 'bg-rose-500',
  unknown: 'bg-slate-400',
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
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full font-semibold text-white tabular-nums ${STYLES[level]} ${pad}`}
      title={`Czas oczekiwania: ${LABELS[level]}`}
    >
      {formatDaysShort(days)}
      {size !== 'sm' && <span className="font-normal opacity-90">· {LABELS[level]}</span>}
    </span>
  );
}
