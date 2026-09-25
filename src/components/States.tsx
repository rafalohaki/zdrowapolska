import { displayBenefit } from '../lib/wait';
import { AlertIcon } from './Icons';

export function CardSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
      <div className="flex items-start gap-4">
        <div className="h-8 w-8 shrink-0 rounded-full bg-slate-200 dark:bg-slate-700" />
        <div className="flex-1 space-y-2.5">
          <div className="flex justify-between gap-3">
            <div className="h-4 w-2/3 overflow-hidden rounded bg-slate-200 dark:bg-slate-700" />
            <div className="h-6 w-28 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" />
          </div>
          <div className="h-3 w-1/3 overflow-hidden rounded bg-slate-100 dark:bg-slate-800" />
          <div className="h-3 w-1/2 overflow-hidden rounded bg-slate-100 dark:bg-slate-800" />
          <div className="h-8 w-40 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800" />
        </div>
      </div>
    </div>
  );
}

export function ResultsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Ładowanie wyników">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="animate-fade-up rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center dark:border-rose-800/60 dark:bg-rose-950/40">
      <AlertIcon className="mx-auto h-8 w-8 text-rose-500" />
      <h3 className="mt-3 font-semibold text-rose-900 dark:text-rose-200">Ups, coś poszło nie tak</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-rose-700 dark:text-rose-300">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-xl bg-rose-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-rose-700"
        >
          Spróbuj ponownie
        </button>
      )}
    </div>
  );
}

export function EmptyState({ onPickHint }: { onPickHint: (name: string) => void }) {
  return (
    <div className="animate-fade-up rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center shadow-card">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Brak wyników dla tej frazy</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500 dark:text-slate-400">
        Wystarczy wpisać 3 litery i wybrać z podpowiedzi pod polem wyszukiwania. Popularne frazy:
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {['ODDZIAŁ KARDIOLOGICZNY', 'ODDZIAŁ OKULISTYCZNY', 'ODDZIAŁ CHIRURGII URAZOWO-ORTOPEDYCZNEJ'].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onPickHint(n)}
            className="rounded-full bg-brand-50 px-3.5 py-1.5 min-h-10 text-xs font-medium text-brand-700 transition hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
          >
            {displayBenefit(n)}
          </button>
        ))}
      </div>
    </div>
  );
}
