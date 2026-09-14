import { useEffect, useRef, useState } from 'react';
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

type Suggestion = { id: number; name: string; city: string };

async function fetchAirStations(q: string, signal: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(`${API_BASE}/api/air-stations?locality=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { items: Suggestion[] }).items ?? [];
}

async function fetchAirByStation(id: number): Promise<AirData> {
  const res = await fetch(`${API_BASE}/api/air?station=${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AirData;
}

export function AirView() {
  const [query, setQuery] = useState('Kraków');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [data, setData] = useState<AirData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const loadStation = (st: Suggestion) => {
    setShowSug(false);
    setQuery(st.name);
    setLoading(true);
    setError(null);
    fetchAirByStation(st.id)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Nieznany błąd'))
      .finally(() => setLoading(false));
  };

  // domyślnie Kraków — pierwszy ekran z danymi bez klikania
  useEffect(() => {
    loadStation({ id: 400, name: 'Kraków, Aleja Krasińskiego', city: 'Kraków' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autouzupełnianie z debounce (stacje GIOŚ po mieście)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetchAirStations(q, ctrl.signal)
        .then((r) => setShowSug(r.length > 0))
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setShowSug(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <section className="mx-auto max-w-4xl px-4 pt-8 pb-4">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Jakość powietrza — czy dziś bezpieczny trening?
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Oficjalny indeks jakości powietrza GIOŚ dla Twojej miejscowości + rekomendacja treningowa.
        Dane odświeżane co godzinę.
      </p>

      <div
        ref={boxRef}
        className="relative mt-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card"
      >
        <label
          htmlFor="air-input"
          className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500"
        >
          Miejscowość
        </label>
        <input
          id="air-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShowSug(true);
          }}
          onFocus={() => setShowSug(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowSug(false);
          }}
          placeholder="Miejscowość, np. Kraków…"
          aria-label="Miejscowość"
          autoComplete="off"
          className="mt-2 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm shadow-card outline-none transition placeholder:text-slate-400 focus:border-brand-400"
        />
        {showSug && query.trim().length >= 3 && suggestions.length > 0 && (
          <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lift">
            {suggestions.map((st) => (
              <li key={st.id}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(st.name);
                    loadStation(st);
                  }}
                  className="block w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-brand-50 dark:hover:bg-brand-900/30"
                >
                  {st.name}
                </button>
              </li>
            ))}
          </ul>
        )}
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

      {!loading && !error && data?.station && (
        <div className="animate-fade-up mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
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

          <div className="mt-4 rounded-xl border border-brand-200 dark:border-brand-800 bg-brand-50 p-4 text-sm leading-relaxed text-brand-900 dark:border-brand-800 dark:bg-brand-900/30 dark:text-brand-100">
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
