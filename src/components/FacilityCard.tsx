import type { CSSProperties } from 'react';
import type { Facility } from '../lib/types';
import { A11Y_FILTERS } from '../lib/types';
import { displayBenefit, formatAwaiting } from '../lib/wait';
import { telHref } from '../lib/html';
import { WaitBadge } from './WaitBadge';
import { PhoneIcon, PinIcon, UsersIcon } from './Icons';

const RANK_STYLES: Record<number, string> = {
  1: 'bg-amber-400 text-amber-950',
  2: 'bg-slate-300 text-slate-800 dark:text-slate-100',
  3: 'bg-orange-300 text-orange-950',
};

export function FacilityCard({
  facility,
  rank,
  style,
  onDetails,
}: {
  facility: Facility;
  rank: number;
  /** np. animationDelay dla kaskady fade-up (stagger z App) */
  style?: CSSProperties;
  onDetails: (f: Facility) => void;
}) {
  const rankStyle = RANK_STYLES[rank] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400';
  const activeFlags = A11Y_FILTERS.filter((f) => facility.flags[f.key]);

  return (
    <article
      style={style}
      onClick={(e) => {
        // karta wygląda klikalnie (hover-lift) → klika też: chyba że trafiono
        // w link/przycisk, który ma własną akcję. Bez tabIndex/onKeyDown —
        // klikalna karta dubluje przycisk „Szczegóły", a bez roli byłaby
        // „tajemniczym" stopem tabulacji; klawiatura i czytniki mają ten przycisk
        if ((e.target as HTMLElement).closest('a,button')) return;
        onDetails(facility);
      }}
      className={`animate-fade-up cursor-pointer rounded-2xl border bg-white dark:bg-slate-900 p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-lift ${
        rank === 1 ? 'border-brand-300 ring-1 ring-brand-200' : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      <div className="flex items-start gap-4">
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums shadow-sm ${rankStyle}`}
        >
          {rank}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold leading-snug text-slate-900 dark:text-white">{facility.provider}</h3>
            <WaitBadge days={facility.days} />
          </div>

          <p className="mt-0.5 truncate text-base leading-snug text-slate-500 dark:text-slate-400" title={facility.benefit}>
            {displayBenefit(facility.benefit)}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base leading-snug text-slate-600 dark:text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <PinIcon className="h-4 w-4 text-slate-400 dark:text-slate-500" />
              {facility.locality}
              {facility.address ? `, ${facility.address}` : ''}
              <span className="text-slate-400 dark:text-slate-500">({facility.provinceName})</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <UsersIcon className="h-4 w-4 text-slate-400 dark:text-slate-500" />
              {facility.awaiting !== null
                ? `${formatAwaiting(facility.awaiting)} w kolejce`
                : 'NFZ nie podał liczby oczekujących'}
            </span>
          </div>

          {activeFlags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {activeFlags.map((f) => (
                <span
                  key={f.key}
                  className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                >
                  {f.label}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onDetails(facility)}
              className="rounded-lg bg-slate-900 px-3.5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              Szczegóły
            </button>
            {facility.phone && (
              <a
                href={`tel:${telHref(facility.phone)}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 text-sm font-medium text-slate-700 dark:text-slate-200 transition hover:border-brand-300 hover:text-brand-700 dark:hover:border-brand-500 dark:hover:text-brand-300"
              >
                <PhoneIcon className="h-4 w-4" />
                {facility.phone}
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
