import { useEffect, useRef, useState } from 'react';
import { AlertIcon, PinIcon } from './Icons';
import { API_BASE } from '../lib/api';
import { plural } from '../lib/wait';

type AirPollutant = { wskaznik: string; kategoria: string | null; wartosc: number | null };
type AirStation = { id: number; name: string; city: string; street: string | null };
type CommunityAir = {
  count: number;
  pm25: number | null;
  pm10: number | null;
  nearestKm: number | null;
  kategoria: string | null;
  measuredAt: string | null;
  radiusKm: number;
};
type AirlyAir = {
  pm25: number | null;
  pm10: number | null;
  caqi: number | null;
  kategoria: string | null;
  level: string | null;
};
type AirAlternative = {
  id: number;
  name: string;
  city: string;
  kategoria: string | null;
  distanceKm: number | null;
};
type AirSources = {
  gios: 'ok' | 'error';
  community: 'ok' | 'empty' | 'error';
  airly: 'off' | 'ok' | 'error';
};
type AirData = {
  station: AirStation | null;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  pollutants: AirPollutant[];
  advice: string;
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
  // pola nowszych backendów — opcjonalne, by nie wywalać UI na starszej odpowiedzi
  alternatives?: AirAlternative[];
  sources?: AirSources;
  geoError?: boolean;
  /** kategoria z pierwszego źródła, które ją zna (GIOŚ → czujniki → Airly) */
  kategoriaEfektywna?: string | null;
  /** skąd pochodzi kategoriaEfektywna */
  zrodloKategorii?: 'gios' | 'community' | 'airly' | null;
  /** fallback podmienił miejscową stację manualną na dalszą z żywym indeksem */
  miejscowaStacjaManualna?: boolean;
};

const KAT_BG: Record<string, string> = {
  'Bardzo dobry': 'bg-emerald-500',
  Dobry: 'bg-lime-500',
  Umiarkowany: 'bg-yellow-400',
  Dostateczny: 'bg-orange-500',
  'Zły': 'bg-red-500',
  'Bardzo zły': 'bg-red-800',
};

// miękkie pigułki jak WaitBadge.STYLES — biały tekst na lime/yellow miał
// kontrast ~2:1, poniżej progu AA
const KAT_PILL: Record<string, string> = {
  'Bardzo dobry': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  Dobry: 'bg-lime-100 text-lime-800 dark:bg-lime-500/15 dark:text-lime-300',
  Umiarkowany: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-300',
  Dostateczny: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  'Zły': 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  'Bardzo zły': 'bg-red-200 text-red-900 dark:bg-red-500/20 dark:text-red-200',
};

function katDot(kat: string | null): string {
  return KAT_BG[kat ?? ''] ?? 'bg-slate-400';
}

function katPill(kat: string | null): string {
  return KAT_PILL[kat ?? ''] ?? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

/** Wiersze z pomiarami okolicznymi — używane w karcie stacji i w karcie „brak stacji". */
function SourceRows({ community, airly }: { community: CommunityAir | null; airly: AirlyAir | null }) {
  return (
    <>
      {community && (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${katDot(community.kategoria)}`} />
          <span className="font-medium">Czujniki obywatelskie (Sensor.Community)</span>
          <span className="text-slate-500 dark:text-slate-400">
            — PM2.5: <strong>{community.pm25 ?? '—'}</strong> µg/m³, PM10:{' '}
            <strong>{community.pm10 ?? '—'}</strong> µg/m³ · {community.count}{' '}
            {plural(community.count, 'czujnik', 'czujniki', 'czujników')} w {community.radiusKm} km
            {community.nearestKm !== null && community.nearestKm > 0 &&
              ` (najbliższy ~${community.nearestKm} km)`}
          </span>
        </li>
      )}
      {airly && (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${katDot(airly.kategoria)}`} />
          <span className="font-medium">Airly (m.in. czujniki na paczkomatach)</span>
          <span className="text-slate-500 dark:text-slate-400">
            — PM2.5: <strong>{airly.pm25 ?? '—'}</strong> µg/m³, PM10:{' '}
            <strong>{airly.pm10 ?? '—'}</strong> µg/m³
            {airly.caqi !== null && ` · CAQI ${Math.round(airly.caqi)}`}
          </span>
        </li>
      )}
    </>
  );
}

type Suggestion = { id: number; name: string; city: string; brakNaZywo?: boolean };

// błędy API pokazujemy po polsku — surowe „HTTP 500" wpadało do UI 1:1.
// Status doklejony: loadStation NIE pogania 5xx w drugie pełne żądanie locality (d5b).
async function apiError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return Object.assign(
    new Error(body?.error ?? 'Nie udało się pobrać danych — spróbuj ponownie za chwilę.'),
    { status: res.status },
  );
}

async function fetchAirStations(q: string, signal: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(`${API_BASE}/api/air-stations?locality=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw await apiError(res);
  return ((await res.json()) as { items: Suggestion[] }).items ?? [];
}

// Twardy limit 45 s: zimna ścieżka serwera (GIOŚ 10 s/próba ×3 + geokoder 8 s +
// Sensor.Community 12 s) potrafi trwać dłużej (mierzone ~35 s na zimnej frazie) —
// 45 s wygrywa wyścig z serwerem zamiast kończyć się mylącym błędem pierwszemu
// użytkownikowi; wciąż mieści się pod idleTimeout Buna (255 s). Abort to UX.
const AIR_FETCH_TIMEOUT_MS = 45_000;

/** user-signal + twardy timeout; AbortSignal.any/timeout nie istnieją w starszych
 *  Safari — wtedy fallback: bez timeoutu (gorzej bez komunikatu niż bez loadera). */
function combineSignals(user: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (user && typeof AbortSignal.any === 'function') return AbortSignal.any([user, timeout]);
    return user ?? timeout;
  } catch {
    return user;
  }
}

function isAbortLike(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** abort/timeout → czytelny polski komunikat z sugestią retry (nie surowy DOMException). */
function airRequestError(err: unknown): Error {
  if (isAbortLike(err))
    return new Error(`Serwer nie odpowiedział w ${AIR_FETCH_TIMEOUT_MS / 1000} s — spróbuj ponownie za chwilę.`);
  return err instanceof Error ? err : new Error('Nie udało się pobrać danych — spróbuj ponownie za chwilę.');
}

async function fetchAirByStation(id: number, signal?: AbortSignal): Promise<AirData> {
  const res = await fetch(`${API_BASE}/api/air?station=${id}`, {
    signal: combineSignals(signal, AIR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as AirData;
}

/** Fallback: wyszukiwanie po miejscowości — dla backendów bez obsługi station=. */
async function fetchAirByLocality(loc: string, signal?: AbortSignal): Promise<AirData> {
  const res = await fetch(`${API_BASE}/api/air?locality=${encodeURIComponent(loc)}`, {
    signal: combineSignals(signal, AIR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as AirData;
}

export function AirView() {
  const [query, setQuery] = useState('Kraków');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [data, setData] = useState<AirData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // id stacji wybranej z podpowiedzi (null przy szukaniu po miejscowości) —
  // pozwala odróżnić „stacja spoza miejscowości” od „wybrana stacja bez danych,
  // backend podmienił na najbliższą z indeksem”
  const [pickedId, setPickedId] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // nazwa właśnie wybranej stacji (nie jest nowym zapytaniem autouzupełniania)
  const pickedRef = useRef<string | null>(null);
  // numer ostatniego żądania — spóźniona odpowiedź nie nadpisze nowszej
  const loadSeqRef = useRef(0);
  // kontroler AKTUALNEGO żądania — nowo zapytanie przerywa poprzednie (uzupełnia seq)
  const abortRef = useRef<AbortController | null>(null);
  // ostatnie żądanie z pełnym kontekstem — „Spróbuj ponownie” je ponawia
  // (podpowiedzi znikają przez setSuggestions([]), więc retry musi pamiętać tryb)
  const lastRequestRef = useRef<
    { kind: 'station'; st: Suggestion } | { kind: 'locality'; q: string } | null
  >(null);

  const loadStation = (st: Suggestion) => {
    setShowSug(false);
    setSuggestions([]);
    pickedRef.current = st.name;
    lastRequestRef.current = { kind: 'station', st };
    setPickedId(st.id);
    setQuery(st.name);
    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const seq = ++loadSeqRef.current;
    // stacja dokładna; gdy backend nie zna parametru station= albo id stacji jest
    // nieaktualne (odpowiedź 200 ze station:null) — fallback na miejscowość.
    // Timeout/abort NIE przechodzi w fallback (młócenie drugi raz 45 s) — komunikat.
    fetchAirByStation(st.id, ctrl.signal)
      .then((d) => (d.station ? d : fetchAirByLocality(st.city, ctrl.signal)))
      .catch((err: unknown) => {
        if (isAbortLike(err)) throw err;
        // 5xx z /api/air?station= (np. 502 GIOŚ) — drugie pełne żądanie locality
        // tylko wydłuży czekanie; krótko pokaż banner z „Spróbuj ponownie”.
        // 4xx i 200 ze station:null zachowują fallback na miejscowość.
        const status = (err as { status?: number }).status;
        if (status !== undefined && status >= 500) throw err;
        return fetchAirByLocality(st.city, ctrl.signal);
      })
      .then((d) => {
        if (loadSeqRef.current === seq) setData(d);
      })
      .catch((err: unknown) => {
        if (loadSeqRef.current === seq) setError(airRequestError(err).message);
      })
      .finally(() => {
        if (loadSeqRef.current === seq) setLoading(false);
      });
  };

  // wyszukiwanie po wpisanej miejscowości — droga awaryjna, gdy autouzupełnianie
  // nie ma stacji (lub się wywaliło), a backend potrafi zgeokodować nazwę
  const loadLocality = (loc: string) => {
    const q = loc.trim();
    if (q.length < 3) return;
    setShowSug(false);
    setSuggestions([]);
    pickedRef.current = q;
    lastRequestRef.current = { kind: 'locality', q };
    setPickedId(null);
    setLoading(true);
    setError(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const seq = ++loadSeqRef.current;
    fetchAirByLocality(q, ctrl.signal)
      .then((d) => {
        if (loadSeqRef.current === seq) setData(d);
      })
      .catch((err: unknown) => {
        if (loadSeqRef.current === seq) setError(airRequestError(err).message);
      })
      .finally(() => {
        if (loadSeqRef.current === seq) setLoading(false);
      });
  };

  // przycisk „Spróbuj ponownie” — ponawia ostatnie żądanie w oryginalnym trybie
  const retryLast = () => {
    const last = lastRequestRef.current;
    if (!last) return;
    if (last.kind === 'station') loadStation(last.st);
    else loadLocality(last.q);
  };

  // domyślnie Kraków — pierwszy ekran z danymi bez klikania
  useEffect(() => {
    loadStation({ id: 400, name: 'Kraków, Aleja Krasińskiego', city: 'Kraków' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autouzupełnianie z debounce (stacje GIOŚ po mieście)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || q === pickedRef.current) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetchAirStations(q, ctrl.signal)
        .then((r) => {
          setSuggestions(r);
          setHighlight(-1); // nowa lista — stary indeks mógłby wskazywać poza zakres
          if (r.length > 0) setShowSug(true);
        })
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
        Dane odświeżane co ~30 minut.
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
            setHighlight(-1);
          }}
          onFocus={() => setShowSug(true)}
          onKeyDown={(e) => {
            const open = showSug && suggestions.length > 0;
            if (e.key === 'Escape') {
              setShowSug(false);
            } else if (open && e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => (h + 1) % suggestions.length);
            } else if (open && e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open) {
                const pick =
                  highlight >= 0 && highlight < suggestions.length
                    ? suggestions[highlight]!
                    : suggestions[0]!;
                loadStation(pick);
              } else {
                // brak/zamknięte podpowiedzi — szukaj po samej miejscowości
                loadLocality(query);
              }
            }
          }}
          placeholder="Miejscowość, np. Kraków…"
          aria-label="Miejscowość"
          role="combobox"
          aria-expanded={showSug && suggestions.length > 0}
          aria-controls="air-listbox"
          aria-activedescendant={highlight >= 0 ? `air-opt-${suggestions[highlight]?.id}` : undefined}
          autoComplete="off"
          className="mt-2 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-base shadow-card outline-none transition placeholder:text-slate-400 focus:border-brand-400"
        />
        <button
          type="button"
          onClick={() => loadLocality(query)}
          disabled={loading || query.trim().length < 3}
          className="mt-2 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-6"
        >
          Sprawdź powietrze
        </button>
        {showSug && query.trim().length >= 3 && suggestions.length > 0 && (
          <ul
            id="air-listbox"
            role="listbox"
            className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 py-1 shadow-lift"
          >
            {suggestions.map((st, i) => (
              <li key={st.id} role="presentation">
                <button
                  type="button"
                  id={`air-opt-${st.id}`}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => {
                    setQuery(st.name);
                    loadStation(st);
                  }}
                  className={`block w-full px-4 py-2.5 text-left text-sm text-slate-700 dark:text-slate-200 ${
                    i === highlight
                      ? 'bg-brand-50 dark:bg-brand-900/30'
                      : 'hover:bg-brand-50 dark:hover:bg-brand-900/30'
                  }`}
                >
                  {st.name}
                  {st.brakNaZywo && (
                    <span className="text-slate-400 dark:text-slate-500"> · brak danych na żywo</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {loading && (
        <div className="mt-6 space-y-3" role="status" aria-live="polite" aria-busy="true">
          {/* d5c: role/aria-live — senior/czytnik ekranu nie widzi 45 s „zamrożonej” strony */}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Pierwsze wyszukiwanie może potrwać do minuty — pobieramy dane z GIOŚ…
          </p>
          <div className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
          <div className="h-20 animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        </div>
      )}

      {!loading && error && (
        <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertIcon className="h-5 w-5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {/* d5d: retry pamięta kontekst (tryb stacja/miejscowość) — podpowiedzi już zniknęły */}
          {lastRequestRef.current && (
            <button
              type="button"
              onClick={retryLast}
              className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-100 dark:border-amber-700 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-900/60"
            >
              Spróbuj ponownie
            </button>
          )}
        </div>
      )}

      {!loading && !error && data?.station && (
        <div className="animate-fade-up mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
          <div className="flex items-start gap-3">
            <span className={`mt-1 h-4 w-4 shrink-0 rounded-full ${katDot(data.kategoria)}`} />
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
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

          {/* d4: pigułka z kategorii efektywnej; podpis „indeks GIOŚ” tylko, gdy
              kategoria pochodzi z indeksu — inaczej wskazujemy źródło szacunku */}
          {(data.kategoria ?? data.kategoriaEfektywna) && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span
                className={`rounded-xl px-4 py-2 text-lg font-bold ${katPill(data.kategoria ?? data.kategoriaEfektywna ?? null)}`}
              >
                {data.kategoria ?? data.kategoriaEfektywna}
              </span>
              {data.kategoria ? (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  indeks GIOŚ: {data.wartosc ?? '—'} · obliczono:{' '}
                  {data.dataObliczen?.slice(0, 16).replace('T', ' ')}
                </span>
              ) : (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {data.zrodloKategorii === 'airly'
                    ? 'szacunek z czujników Airly'
                    : `szacunek z czujników obywatelskich${
                        data.community?.nearestKm != null
                          ? ` (najbliższy ~${data.community.nearestKm} km)`
                          : ''
                      }`}
                </span>
              )}
            </div>
          )}

          <div className="mt-4 rounded-xl border border-brand-200 dark:border-brand-800 bg-brand-50 p-4 text-sm leading-relaxed text-brand-900 dark:border-brand-800 dark:bg-brand-900/30 dark:text-brand-100">
            <strong>Trening:</strong> {data.advice}
          </div>

          {data.distanceKm !== null && data.distanceKm > 1 && data.station && (
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              {pickedId !== null && data.station.id !== pickedId
                ? `Wybrana stacja nie ma aktualnego indeksu — najbliższa stacja z danymi: ${data.station.name} (~${data.distanceKm} km).`
                : data.miejscowaStacjaManualna && pickedId === null
                  ? `Stacja w tej miejscowości nie publikuje danych na żywo — najbliższa stacja z danymi: ${data.station.name} (~${data.distanceKm} km).`
                  : `W tej miejscowości nie ma stacji GIOŚ — najbliższa stacja: ${data.station.name} (~${data.distanceKm} km).`}
            </p>
          )}

          {/* uczciwy stan braku danych: stacja jest, ale nie publikuje indeksu na żywo */}
          {!data.kategoria && data.pollutants.length === 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              {data.community || data.airly
                ? 'Ta stacja nie publikuje danych na żywo (pomiar ręczny — wyniki po 4–8 tyg.) — poniżej pomiary czujników w okolicy.'
                : 'Ta stacja nie publikuje danych na żywo (pomiar ręczny — wyniki po 4–8 tyg.).'}
            </p>
          )}

          {data.alternatives && data.alternatives.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Inne stacje w okolicy
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.alternatives.map((alt) => (
                  <button
                    key={alt.id}
                    type="button"
                    onClick={() => loadStation({ id: alt.id, name: alt.name, city: alt.city })}
                    title={`${alt.name} — sprawdź jakość powietrza`}
                    className="inline-flex max-w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-brand-300 hover:bg-brand-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-brand-900/30"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${katDot(alt.kategoria)}`} />
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200">
                      {alt.name}
                    </span>
                    {alt.distanceKm !== null && (
                      <span className="shrink-0 text-slate-400 dark:text-slate-500">~{alt.distanceKm} km</span>
                    )}
                    {alt.kategoria && (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${katPill(alt.kategoria)}`}>
                        {alt.kategoria}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${katPill(p.kategoria)}`}
                    >
                      {p.wskaznik}: {p.kategoria}
                    </span>
                  ))}
              </div>
            </div>
          )}

          {(data.community || data.airly) && (
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Inne pomiary w okolicy
              </p>
              <ul className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                <SourceRows community={data.community} airly={data.airly} />
              </ul>
            </div>
          )}
        </div>
      )}

      {!loading && !error && data && !data.station && (data.community || data.airly) && (
        <div className="animate-fade-up mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            Brak stacji urzędowej — ale są pomiary w okolicy
          </h2>
          <div className="mt-3 rounded-xl border border-brand-200 dark:border-brand-800 bg-brand-50 p-4 text-sm leading-relaxed text-brand-900 dark:bg-brand-900/30 dark:text-brand-100">
            <strong>Trening:</strong> {data.advice}
          </div>
          <ul className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <SourceRows community={data.community} airly={data.airly} />
          </ul>
          <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
            Pomiary obywatelskie mogą odbiegać od stacji referencyjnych — traktuj je orientacyjnie.
          </p>
        </div>
      )}

      {/* żadna stacja ani czujnik w okolicy — bez tego byłby po prostu pusty ekran */}
      {!loading && !error && data && !data.station && !data.community && !data.airly && (
        <div className="animate-fade-up mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center shadow-card">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Brak pomiarów dla tej miejscowości
          </p>
          {data.geoError ? (
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              Geokodowanie chwilowo niedostępne — spróbuj za chwilę.
            </p>
          ) : (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              GIOŚ nie ma tu stacji i w okolicy nie ma czujników obywatelskich — spróbuj większej
              miejscowości w pobliżu (np. Kraków, Warszawa).
            </p>
          )}
          {/* uczciwie: co sprawdzono — gios 'ok' znaczy „lista stacji pobrana”,
              NIE „wybrana stacja ma indeks” */}
          {data.sources && (
            <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
              Sprawdzone źródła: stacje GIOŚ{' '}
              {data.sources.gios === 'ok' ? '— lista pobrana' : '— nieosiągalne'}; czujniki
              obywatelskie{' '}
              {data.sources.community === 'ok'
                ? '— są dane'
                : data.sources.community === 'empty'
                  ? '— sprawdzone, brak czujników'
                  : '— nie odpowiedziały'}
              ; Airly{' '}
              {data.sources.airly === 'off'
                ? '— wyłączone (brak klucza API)'
                : data.sources.airly === 'ok'
                  ? '— są dane'
                  : data.sources.airly === 'error'
                    ? '— nie odpowiedziały'
                    : '— brak danych'}
              .
            </p>
          )}
        </div>
      )}
    </section>
  );
}
