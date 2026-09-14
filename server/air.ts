/**
 * Jakość powietrza — GIOŚ PJP API v1 (publiczne, bez klucza).
 *
 * UWAGA: GIOŚ v1 zwraca 406 na „Accept: application/json" (negocjacja JSON-LD) —
 * fetch bez nagłówka Accept. Pacing 1 req/s zgodnie z dobrymi praktykami GIOŚ.
 */

import { Data, Effect, Semaphore, Schedule } from 'effect';
import { cached } from './cache';

const BASE = 'https://api.gios.gov.pl/pjp-api/v1/rest';

export class GiosError extends Data.TaggedError('GiosError')<{ readonly cause: string }> {}

const semaphore = Effect.runSync(Semaphore.make(1));

function giosJson<T>(path: string) {
  return Effect.gen(function* () {
    yield* Effect.sleep('150 millis');
    return yield* semaphore.withPermits(1)(
      Effect.tryPromise({
        try: (signal) =>
          fetch(`${BASE}${path}`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: (cause) => new GiosError({ cause: String(cause) }),
      }).pipe(
        Effect.flatMap((res) =>
          res.ok
            ? Effect.tryPromise({
                try: () => res.json() as Promise<T>,
                catch: (cause) => new GiosError({ cause: String(cause) }),
              })
            : Effect.fail(new GiosError({ cause: `GIOŚ ${res.status} dla ${path}` })),
        ),
        Effect.retry({ times: 2, schedule: Schedule.spaced('2 seconds') }),
      ),
    );
  });
}

export type GiosStation = {
  id: number;
  code: string;
  name: string;
  city: string;
  street: string | null;
  lat: number | null;
  lon: number | null;
};

type RawStation = Record<string, unknown>;

function toStation(raw: RawStation): GiosStation | null {
  const id = raw['Identyfikator stacji'];
  const city = raw['Nazwa miasta'];
  if (typeof id !== 'number' || typeof city !== 'string') return null;
  const lat = parseFloat(String(raw['WGS84 φ N'] ?? ''));
  const lon = parseFloat(String(raw['WGS84 λ E'] ?? ''));
  return {
    id,
    code: String(raw['Kod stacji'] ?? ''),
    name: String(raw['Nazwa stacji'] ?? city),
    city,
    street: typeof raw['Ulica'] === 'string' ? (raw['Ulica'] as string) : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

let stationsCache: { at: number; list: GiosStation[] } | null = null;

/** Indeks + porada dla KONKRETNEJ stacji (po id z autouzupełniania). */
export async function airForStation(stationId: number): Promise<{
  station: GiosStation | null;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
}> {
  const stations = await allStations();
  const station = stations.find((st) => st.id === stationId) ?? null;
  if (!station) {
    return { station: null, kategoria: null, wartosc: null, dataObliczen: null, dataZrodlowa: null, pollutants: [], advice: 'Nie znaleziono stacji.' };
  }
  const idx = await Effect.runPromise(
    giosJson<{ AqIndex?: Record<string, unknown> }>(`/aqindex/getIndex/${stationId}`),
  ).catch(() => ({}) as AqIndexResponse);
  const a = idx.AqIndex ?? {};
  const pollutants: AirPollutant[] = [];
  for (const [key, kategoria] of Object.entries(a)) {
    if (!key.startsWith('Nazwa kategorii indeksu dla wskażnika ') || typeof kategoria !== 'string') continue;
    const wskaznik = key.replace('Nazwa kategorii indeksu dla wskażnika ', '');
    const wartosc = a[`Wartość indeksu dla wskaźnika ${wskaznik}`];
    pollutants.push({ wskaznik, kategoria: typeof kategoria === 'string' ? kategoria : null, wartosc: typeof wartosc === 'number' ? wartosc : null });
  }
  const wartosc = typeof a['Wartość indeksu'] === 'number' ? (a['Wartość indeksu'] as number) : null;
  const kategoria = typeof a['Nazwa kategorii indeksu'] === 'string' ? (a['Nazwa kategorii indeksu'] as string) : null;
  return {
    station,
    kategoria,
    wartosc,
    dataObliczen: typeof a['Data wykonania obliczeń indeksu'] === 'string' ? (a['Data wykonania obliczeń indeksu'] as string) : null,
    dataZrodlowa: typeof a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] === 'string' ? (a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] as string) : null,
    pollutants,
    advice: adviceFor(kategoria),
  };
}

/** Cała lista stacji — cache 24 h (Redis + pamięć procesu), przeżywa restart kontenera. */
export async function allStations(): Promise<GiosStation[]> {
  if (stationsCache && Date.now() - stationsCache.at < 24 * 60 * 60 * 1000) {
    return stationsCache.list;
  }
  const list = await cached('gios:stations:all', 24 * 60 * 60 * 1000, fetchStationsFromGios);
  stationsCache = { at: Date.now(), list };
  return list;
}

async function fetchStationsFromGios(): Promise<GiosStation[]> {
  const pages = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* giosJson<{ ['Lista stacji pomiarowych']: RawStation[]; totalPages: number }>(
        '/station/findAll',
      );
      const totalPages = Math.min(Number(first.totalPages) || 1, 20);
      const rest = yield* Effect.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          giosJson<{ ['Lista stacji pomiarowych']: RawStation[] }>(`/station/findAll?page=${i + 2}`),
        ),
        { concurrency: 4 },
      );
      return [first['Lista stacji pomiarowych'] ?? [], ...rest.map((r) => r['Lista stacji pomiarowych'] ?? [])];
    }),
  );
  const list = pages
    .flat()
    .map(toStation)
    .filter((s): s is GiosStation => s !== null);
  stationsCache = { at: Date.now(), list };
  return list;
}

export function normCity(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type AirPollutant = { wskaznik: string; kategoria: string | null; wartosc: number | null };

export type AirResult = {
  station: GiosStation;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: { id: number; name: string; city: string }[];
};

const KATEGORIA_ADVICE: Record<string, string> = {
  'Bardzo dobry': 'Idealne warunki do aktywności na zewnątrz — biegaj, jeździj, trenuj bez ograniczeń.',
  Dobry: 'Dobre warunki do treningu na świeżym powietrzu — pełna intensywność dla większości osób.',
  Umiarkowany: 'Możesz trenować na zewnątrz, ale osoby wrażliwe (astma, alergie) niech ograniczą intensywny wysiłek.',
  Dostateczny: 'Rozważ lżejszy trening lub salę — intensywny wysiłek na zewnątrz niewskazany.',
  Zły: 'Trenuj w pomieszczeniu. Unikaj intensywnego wysiłku na zewnątrz, szczególnie przy drogach.',
  'Bardzo zły': 'Zostań w pomieszczeniu. Intensywny wysiłek na zewnątrz grozi zdrowiu.',
};

export function adviceFor(kategoria: string | null): string {
  if (!kategoria) return 'Brak indeksu jakości powietrza dla tej stacji — sprawdź inne stacje w okolicy.';
  return KATEGORIA_ADVICE[kategoria] ?? 'Sprawdź szczegóły jakości powietrza na stronie GIOŚ.';
}

type AqIndexResponse = { AqIndex?: Record<string, unknown> };

/** Stacje pasujące do miejscowości (do autouzupełniania) — z cache stacji. */
export async function airStationsByLocality(localityRaw: string): Promise<
  { id: number; name: string; city: string }[]
> {
  const q = normCity(localityRaw);
  if (q.length < 3) return [];
  const stations = await allStations();
  return stations
    .filter((st) => normCity(st.city).includes(q) || normCity(st.name).includes(q))
    .slice(0, 8)
    .map((st) => ({ id: st.id, name: st.name, city: st.city }));
}

export async function airForLocality(localityRaw: string): Promise<{
  query: string;
  matches: { id: number; name: string; city: string }[];
  station: GiosStation | null;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: { id: number; name: string; city: string }[];
}> {
  const locality = normCity(localityRaw);
  const stations = await allStations();
  const matches = stations.filter((st) => {
    const c = normCity(st.city);
    const n = normCity(st.name);
    return c.includes(locality) || locality.includes(c) || n.includes(locality);
  });
  if (matches.length === 0) {
    return {
      query: localityRaw,
      matches: [],
      station: null,
      kategoria: null,
      wartosc: null,
      dataObliczen: null,
      dataZrodlowa: null,
      pollutants: [],
      advice: `Nie znaleziono stacji GIOŚ dla „${localityRaw}" — wybierz pobliskie miasto.`,
      alternatives: [],
    };
  }

  // pierwsza stacja bez indeksu nie blokuje — próbujemy kolejne (max 3),
  // aż znajdziemy stację z policzoną kategorią indeksu
  let station = matches[0];
  let a: AqIndexResponse['AqIndex'] = {};
  for (const cand of matches.slice(0, 3)) {
    station = cand;
    const idx = await Effect.runPromise(
      giosJson<{ AqIndex?: Record<string, unknown> }>(`/aqindex/getIndex/${cand.id}`),
    ).catch(() => ({}) as AqIndexResponse);
    a = idx.AqIndex ?? {};
    if (a['Nazwa kategorii indeksu']) break;
  }

  const pollutants: AirPollutant[] = [];
  for (const [key, kategoria] of Object.entries(a)) {
    if (!key.startsWith('Nazwa kategorii indeksu dla wskażnika ') || typeof kategoria !== 'string') continue;
    const wskaznik = key.replace('Nazwa kategorii indeksu dla wskażnika ', '');
    const wartosc = a[`Wartość indeksu dla wskaźnika ${wskaznik}`];
    pollutants.push({
      wskaznik,
      kategoria: typeof kategoria === 'string' ? kategoria : null,
      wartosc: typeof wartosc === 'number' ? wartosc : null,
    });
  }

  const wartosc = typeof a['Wartość indeksu'] === 'number' ? (a['Wartość indeksu'] as number) : null;
  const kategoria = typeof a['Nazwa kategorii indeksu'] === 'string' ? (a['Nazwa kategorii indeksu'] as string) : null;

  return {
    query: localityRaw,
    matches: stations
      .filter((st) => normCity(st.city).includes(locality))
      .slice(1, 4)
      .map((m) => ({ id: m.id, name: m.name, city: m.city })),
    station,
    kategoria,
    wartosc,
    dataObliczen:
      typeof a['Data wykonania obliczeń indeksu'] === 'string'
        ? (a['Data wykonania obliczeń indeksu'] as string)
        : null,
    dataZrodlowa:
      typeof a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] === 'string'
        ? (a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] as string)
        : null,
    pollutants,
    advice: adviceFor(kategoria),
    alternatives: matches.slice(1, 4).map((m) => ({ id: m.id, name: m.name, city: m.city })),
  };
}
