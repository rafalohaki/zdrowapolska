import { useEffect, useState } from 'react';
import { API_BASE } from '../lib/api';
import { formatDaysShort } from '../lib/wait';
import { AlertIcon } from './Icons';

type InsightItem = {
  benefit: string;
  label: string;
  facilities: number;
  awaitingTotal: number;
  avgDays: number | null;
  minDays: number | null;
  maxDays: number | null;
  zeroShare: number | null;
  worstProvince: string | null;
};

type Report = { generatedAt: string; items: InsightItem[] };

function barColor(avg: number | null): string {
  if (avg === null) return 'bg-slate-300 dark:bg-slate-700';
  if (avg <= 14) return 'bg-emerald-500';
  if (avg <= 45) return 'bg-lime-500';
  if (avg <= 120) return 'bg-amber-500';
  return 'bg-rose-500';
}

function fmtAwaiting(n: number): string {
  return n.toLocaleString('pl-PL');
}

export function ReportView() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const load = (attempt = 0) => {
      setLoading(true);
      fetch(`${API_BASE}/api/insights`)
        .then(async (res) => {
          if (res.status === 202) {
            // raport w trakcie generowania — sprawdzaj co 4 s (do ~2 min)
            if (alive && attempt < 30) {
              timer = setTimeout(() => load(attempt + 1), 4000);
            } else if (alive) {
              setError('Raport jest wciąż generowany — odśwież stronę za chwilę.');
              setLoading(false);
            }
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const r = (await res.json()) as Report;
          if (!alive) return;
          setReport(r);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (attempt < 5) {
            timer = setTimeout(() => load(attempt + 1), 3000);
          } else {
            setError(err instanceof Error ? err.message : 'Błąd');
            setLoading(false);
          }
        });
    };

    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const maxAvg = report ? Math.max(...report.items.map((i) => i.avgDays ?? 0), 1) : 1;
  const totalAwaiting = report?.items.reduce((s, i) => s + i.awaitingTotal, 0) ?? 0;
  const totalFacilities = report?.items.reduce((s, i) => s + i.facilities, 0) ?? 0;

  return (
    <section className="mx-auto max-w-4xl px-4 pt-8 pb-4">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Raport ogólnopolski
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Agregat oficjalnych statystyk NFZ z naszej bazy — gdzie kolejki są najdłuższe i ile osób
        czeka. Dane aktualizowane cyklicznie przez synchronizację.
      </p>

      {loading && (
        <div className="mt-6 space-y-3" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
          ))}
        </div>
      )}

      {!loading && error && (
        <p className="mt-6 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertIcon className="h-5 w-5" /> {error}
        </p>
      )}

      {!loading && report && report.items.length > 0 && (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Specjalizacje w raporcie</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{report.items.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Placówki w analizie</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{fmtAwaiting(totalFacilities)}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500 dark:text-slate-400">Osób w kolejkach</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-white">{fmtAwaiting(totalAwaiting)}</p>
            </div>
          </div>

          <ul className="mt-4 space-y-2.5">
            {[...report.items]
              .sort((a, b) => (b.avgDays ?? -1) - (a.avgDays ?? -1))
              .map((item) => {
                const width = item.avgDays === null ? 0 : Math.max((item.avgDays / maxAvg) * 100, 3);
                return (
                  <li
                    key={item.benefit}
                    className="animate-fade-up rounded-2xl border border-slate-200 bg-white p-4 shadow-card dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="font-semibold text-slate-900 dark:text-white">{item.label}</h3>
                      <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                        {item.avgDays === null ? 'bd' : `śr. ${item.avgDays} dni`}
                      </span>
                    </div>
                    <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div
                        className={`h-full rounded-full ${barColor(item.avgDays)}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                      <span>{fmtAwaiting(item.awaitingTotal)} w kolejkach</span>
                      <span>{item.facilities} placówek</span>
                      <span>najszybciej: {formatDaysShort(item.minDays)}</span>
                      <span>najdłużej: {formatDaysShort(item.maxDays)}</span>
                      {item.zeroShare !== null && (
                        <span>{Math.round(item.zeroShare * 100)}% bez kolejki</span>
                      )}
                      {item.worstProvince && <span>najdłużej w: {item.worstProvince}</span>}
                    </div>
                  </li>
                );
              })}
          </ul>

          <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
            Raport wygenerowano: {new Date(report.generatedAt).toLocaleString('pl-PL')} · średnia
            liczona z placówek z danymi · statystyki NFZ aktualizowane miesięcznie.
          </p>
        </>
      )}
    </section>
  );
}
