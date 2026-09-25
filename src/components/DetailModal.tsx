import { useEffect, useRef } from 'react';
import type { Facility } from '../lib/types';
import { A11Y_FILTERS } from '../lib/types';
import { displayBenefit, formatAwaiting, formatDaysLong } from '../lib/wait';
import { CloseIcon, PhoneIcon, PinIcon } from './Icons';
import { telHref } from '../lib/html';
import { WaitBadge } from './WaitBadge';

export function DetailModal({ facility, onClose }: { facility: Facility; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // onClose przychodzi jako inline-fn z App → trzymamy w ref, żeby efekt
  // nie odpalał się przy każdym renderze (progresywne ładowanie wymuszało
  // focus na „Zamknij" co rundę setProvinces)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && dialogRef.current) {
        // focus nie może uciec do tła — dialog modalny
        const els = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const focusables = [...els].filter((el) => !el.hasAttribute('disabled'));
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // focus wchodzi do dialogu (a11y), tło nie scrolluje pod otwartym modalem;
    // po zamknięciu focus i scroll wracają tam, gdzie były
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    closeRef.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus();
    };
    // tylko przy zmianie placówki — nie przy każdym renderze App
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facility]);

  const flags = A11Y_FILTERS.filter((f) => facility.flags[f.key]);

  // „Wyznacz trasę": współrzędne z geokodowania → OSM directions;
  // bez koordynatów → wyszukiwanie adresu na OSM
  const routeUrl =
    facility.lat !== null && facility.lon !== null
      ? `https://www.openstreetmap.org/directions?to=${facility.lat}%2C${facility.lon}`
      // filter(Boolean): puste locality/address nie zostawiają wiszącego „, "
      : `https://www.openstreetmap.org/search?query=${encodeURIComponent(
          [facility.address, facility.locality].filter(Boolean).join(', '),
        )}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Szczegóły placówki ${facility.provider}`}
    >
      <div
        ref={dialogRef}
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-t-2xl bg-white dark:bg-slate-900 p-6 shadow-lift sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">{facility.provider}</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{displayBenefit(facility.benefit)}</p>
          </div>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            aria-label="Zamknij"
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:hover:text-slate-300"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <WaitBadge days={facility.days} size="lg" />
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {facility.waitLabel ? `PCUS wg NFZ: ${facility.waitLabel}` : 'brak prognozy PCUS'}
          </span>
        </div>

        <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">Adres</dt>
            <dd className="mt-1 flex items-start gap-1.5 text-sm text-slate-800 dark:text-slate-100">
              <PinIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
              <span>
                {facility.address || '—'}
                <br />
                {facility.locality && <>{facility.locality}, </>}woj. {facility.provinceName}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">Telefon</dt>
            <dd className="mt-1 text-sm">
              {facility.phone ? (
                <a
                  href={`tel:${telHref(facility.phone)}`}
                  className="inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline"
                >
                  <PhoneIcon className="h-4 w-4" /> {facility.phone}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">Osoby w kolejce</dt>
            <dd className="mt-1 text-sm text-slate-800 dark:text-slate-100">{formatAwaiting(facility.awaiting)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">
              Szacowany czas oczekiwania
            </dt>
            <dd className="mt-1 text-sm text-slate-800 dark:text-slate-100">
              {facility.days === null ? 'brak danych' : formatDaysLong(facility.days)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">
              Statystyki placówki zgłoszone do NFZ
            </dt>
            <dd className="mt-1 text-sm text-slate-800 dark:text-slate-100">{facility.statsUpdate ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-slate-600 dark:text-slate-400 uppercase">
              Stan danych NFZ na dzień
            </dt>
            <dd className="mt-1 text-sm text-slate-800 dark:text-slate-100">{facility.situationAsAt ?? '—'}</dd>
          </div>
        </dl>

        <h3 className="mt-6 text-sm font-semibold text-slate-900 dark:text-white">Dostępność architektoniczna</h3>
        {flags.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {flags.map((f) => (
              <li key={f.key} className="rounded-md bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                {f.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Brak zadeklarowanych udogodnień w bazie NFZ.</p>
        )}

        <a
          href={routeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 transition hover:border-brand-300 hover:text-brand-700"
        >
          <PinIcon className="h-4 w-4" /> Wyznacz trasę (OpenStreetMap) ↗
        </a>

        <div className="mt-6 rounded-xl bg-slate-50 dark:bg-slate-800/50 p-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Dane pochodzą z oficjalnego API NFZ „Terminy Leczenia” i są aktualizowane miesięcznie — przed
          wizytą potwierdź dostępność telefonicznie. Aplikacja nie stanowi porady medycznej.
        </div>
      </div>
    </div>
  );
}
