import { useState } from 'react';
import { AlertIcon, PinIcon } from './Icons';

const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  (import.meta.env?.DEV ? 'http://localhost:2363' : 'https://yeapi.wpme.pl');

type AirPollutant = { wskaznik: string; kategoria: string | null; wartosc: number | null };
type AirStation = { id: number; name: string; city: string; street: string | null };
type AirData = {
  station: AirStation | null;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  pollutants: AirPollutant[];
  advice: string;
};

const KAT_BG: Record<string, string> = {
  'Bardzo dobry': 'bg-emerald-500',
  Dobry: 'bg-lime-500',
  Umiarkowany: 'bg-yellow-400',
  Dostateczny: 'bg-orange-500',
  'Zły': 'bg-red-500',
  'Bardzo zły': 'bg-red-800',
};

function katDot(kat: string | null): string {
  return KAT_BG[kat ?? ''] ?? 'bg-slate-400';
}

export function AirView() {
  const [locality, setLocality] = useState('Kraków');
  const [data, setData] = useState<AirData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const run = (loc: string) => {
    const q = loc.trim();
    if (q.length < 3) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    fetch(`${API_BASE}/api/air?locality=${encodeURIComponent(q)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
        return (await res.json()) as AirData;
      })
      .then((d) => setData(d))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Nieznany błąd'))
      .finally(() => setLoading(false));
  };

  // pierwsze dane od razu po wejściu
  useState(() => {
    run('Kraków');
  });

  return (
    <section className="mx-auto max-w-4xl px-4 pt-8 pb-4">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Jakość powietrza — czy dziś bezpieczny trening?
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Oficjalny indeks jakości powietrza GIOŚ dla Twojej miejscowości + rekomendacja treningowa.
        Dane odświeżane co godzinę.
      </p>

      <div className="mt-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <input
            value={locality}
            onChange={(e) => setLocality(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run(locality);
            }}
            placeholder="Miejscowość, np. Kraków…"
            aria-label="Miejscowość"
            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm shadow-card outline-none transition placeholder:text-slate-400 focus:border-brand-400"
          />
          <button
            type="button"
            onClick={() => run(locality)}
            className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-card transition hover:bg-brand-700"
          >
            Sprawdź
          </button>
        </div>
      </div>

      {loading && (
        <div className="mt-6 space-y-3" aria-busy="true">
          <div className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        </div>
      )}

      {!loading && error && (
        <p className="mt-6 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertIcon className="h-5 w-5" /> {error}
        </p>
      )}

      {!loading && !error && searched && data && !data.station && (
        <p className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-500 dark:text-slate-400 shadow-card">
          Nie znaleziono stacji GIOŚ dla tej miejscowości — spróbuj większego miasta w okolicy.
        </p>
      )}

      {!loading && !error && data?.station && (
        <div className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
          <div className="flex items-start gap-3">
            <span className={`mt-1 h-4 w-4 shrink-0 rounded-full ${katDot(data.kategoria)}`} />
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Stacja pomiarowa
              </p>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                {data.station.name}
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
                <PinIcon className="h-4 w-4" />
                {data.station.city}
                {data.station.street ? `, ${data.station.street}` : ''}
              </p>
            </div>
          </div>

          {data.kategoria && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className={`rounded-xl px-4 py-2 text-lg font-bold text-white ${katDot(data.kategoria)}`}>
                {data.kategoria}
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                indeks GIOŚ: {data.wartosc ?? 'bd'} · obliczono:{' '}
                {data.dataObliczen?.slice(0, 16).replace('T', ' ')}
              </span>
            </div>
          )}

          <div className="mt-4 rounded-xl border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/30 p-4 text-sm leading-relaxed text-brand-900 dark:text-brand-100">
            <strong>Trening:</strong> {data.advice}
          </div>

          {data.pollutants.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Wskaźniki
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.pollutants
                  .filter((p) => p.kategoria)
                  .map((p) => (
                    <span
                      key={p.wskaznik}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white ${katDot(p.kategoria)}`}
                    >
                      {p.wskaznik}: {p.kategoria}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
