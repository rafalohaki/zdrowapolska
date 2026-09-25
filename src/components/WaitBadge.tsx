import { formatDaysShort, plural, waitLevel } from '../lib/wait';
import { WAIT_BADGE_CLASSES } from '../lib/waitColors';

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
      className={`inline-flex items-center gap-2 rounded-full font-semibold tabular-nums ${WAIT_BADGE_CLASSES[level]} ${pad}`}
      title={title}
    >
      {formatDaysShort(days)}
      {size !== 'sm' && <span className="font-normal opacity-90">· {LABELS[level]}</span>}
    </span>
  );
}
