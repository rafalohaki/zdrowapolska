/**
 * Jakość powietrza — GIOŚ PJP API v1 (publiczne, bez klucza).
 *
 * UWAGA: GIOŚ v1 zwraca 406 na „Accept: application/json" (negocjacja JSON-LD) —
 * fetch bez nagłówka Accept. Pacing 1 req/s zgodnie z dobrymi praktykami GIOŚ.
 */

import { Data, Effect, Semaphore, Schedule } from 'effect';
import { cached } from './cache';
import { geocodeBatch } from './geocode';

const BASE = 'https://api.gios.gov.pl/pjp-api/v1/rest';

export class GiosError extends Data.TaggedError('GiosError')<{ readonly cause: string }> {}

const semaphore = Effect.runSync(Semaphore.make(1));

function giosJson<T>(path: string) {
  return semaphore.withPermits(1)(
    Effect.gen(function* () {
      // sleep wewnątrz semafora — realny odstęp między żądaniami (wcześniej
      // równoległe sleep'y przy concurrency:4 nie dawały żadnego pacingu)
      yield* Effect.sleep('150 millis');
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${BASE}${path}`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: (cause) => new GiosError({ cause: String(cause) }),
      });
      if (!res.ok) return yield* Effect.fail(new GiosError({ cause: `GIOŚ ${res.status} dla ${path}` }));
      return yield* Effect.tryPromise({
        try: () => res.json() as Promise<T>,
        catch: (cause) => new GiosError({ cause: String(cause) }),
      });
    }).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced('2 seconds') }),
    ),
  );
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

/** Pomiary okoliczne (czujniki obywatelskie + Airly) wokół punktu odniesienia. */
async function sourcesNear(refPoint: { lat: number; lon: number } | null): Promise<{
  community: CommunityAir | null;
  airly: AirlyAir | null;
}> {
  if (!refPoint) return { community: null, airly: null };
  const [community, airly] = await Promise.all([
    communityAirNear(refPoint.lat, refPoint.lon).catch(() => null),
    airlyNear(refPoint.lat, refPoint.lon).catch(() => null),
  ]);
  return { community, airly };
}

/** Indeks + porada dla KONKRETNEJ stacji (po id z autouzupełniania). */
export async function airForStation(stationId: number): Promise<{
  station: GiosStation | null;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
}> {
  const stations = await allStations();
  const station = stations.find((st) => st.id === stationId) ?? null;
  if (!station) {
    return { station: null, kategoria: null, wartosc: null, dataObliczen: null, dataZrodlowa: null, pollutants: [], advice: 'Nie znaleziono stacji.', distanceKm: null, community: null, airly: null };
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
  const refPoint =
    station.lat !== null && station.lon !== null ? { lat: station.lat, lon: station.lon } : null;
  const { community, airly } = await sourcesNear(refPoint);
  // gdy GIOŚ nie ma indeksu dla stacji — porada z innych źródeł, nie „brak danych"
  const effectiveKategoria = kategoria ?? community?.kategoria ?? airly?.kategoria ?? null;
  return {
    station,
    kategoria,
    wartosc,
    dataObliczen: typeof a['Data wykonania obliczeń indeksu'] === 'string' ? (a['Data wykonania obliczeń indeksu'] as string) : null,
    dataZrodlowa: typeof a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] === 'string' ? (a['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] as string) : null,
    pollutants,
    advice: adviceFor(effectiveKategoria),
    distanceKm: 0,
    community,
    airly,
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

// --- Geografia i progi -------------------------------------------------------

/** Odległość haversine w km — dobor najbliższej stacji/czujnika do punktu. */
export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const KATEGORIA_ORDER = [
  'Bardzo dobry',
  'Dobry',
  'Umiarkowany',
  'Dostateczny',
  'Zły',
  'Bardzo zły',
] as const;

/** Oficjalne progi polskiego indeksu jakości powietrza (µg/m³, średnie dobowe). */
const PM_THRESHOLDS: Record<'PM25' | 'PM10', number[]> = {
  PM25: [13, 35, 55, 75, 110],
  PM10: [20, 50, 80, 110, 150],
};

export function pmCategory(pollutant: 'PM25' | 'PM10', value: number): string {
  const t = PM_THRESHOLDS[pollutant];
  for (let i = 0; i < t.length; i++) if (value <= t[i]) return KATEGORIA_ORDER[i];
  return 'Bardzo zły';
}

export function worstCategory(cats: (string | null)[]): string | null {
  let worst: string | null = null;
  for (const c of cats) {
    if (!c) continue;
    if (!worst || KATEGORIA_ORDER.indexOf(c as never) > KATEGORIA_ORDER.indexOf(worst as never)) worst = c;
  }
  return worst;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- Sensor.Community (czujniki obywatelskie, bez klucza) ---------------------

export type CommunityAir = {
  count: number;
  pm25: number | null; // mediana µg/m³
  pm10: number | null;
  nearestKm: number;
  kategoria: string | null;
  measuredAt: string | null;
};

const SC_BASE = 'https://data.sensor.community/airrohr/v1';

/** Czujniki PM (SDS011 itp.) w promieniu ~12 km — mediana P1/P2 + najbliższy dystans. */
export async function communityAirNear(lat: number, lon: number): Promise<CommunityAir | null> {
  // klucz per ~0.1° — obce miejscowości w okolicy dzielą cache
  const key = `airsc:${lat.toFixed(1)}:${lon.toFixed(1)}`;
  return cached(
    key,
    15 * 60 * 1000,
    async () => {
      const res = await fetch(`${SC_BASE}/filter/area=${lat.toFixed(4)},${lon.toFixed(4)},12`, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'User-Agent': 'ZdrowaPolska/1.0 (hackathon)' },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(rows)) return null;

      const seen = new Set<number>();
      const pm25s: number[] = [];
      const pm10s: number[] = [];
      let nearestKm = Infinity;
      let measuredAt: string | null = null;
      for (const s of rows) {
        const sensor = s['sensor'] as Record<string, unknown> | undefined;
        const sid = typeof sensor?.['id'] === 'number' ? (sensor['id'] as number) : null;
        if (sid === null || seen.has(sid)) continue;
        const vals = s['sensordatavalues'];
        if (!Array.isArray(vals)) continue;
        let pm10: number | null = null;
        let pm25: number | null = null;
        for (const v of vals as Record<string, unknown>[]) {
          const num = Number(v?.['value']);
          if (!Number.isFinite(num)) continue;
          if (v['value_type'] === 'P1') pm10 = num;
          else if (v['value_type'] === 'P2') pm25 = num;
        }
        if (pm10 === null && pm25 === null) continue;
        seen.add(sid);
        const loc = s['location'] as Record<string, unknown> | undefined;
        const slat = Number(loc?.['latitude']);
        const slon = Number(loc?.['longitude']);
        if (Number.isFinite(slat) && Number.isFinite(slon)) {
          nearestKm = Math.min(nearestKm, distKm(lat, lon, slat, slon));
        }
        if (pm25 !== null) pm25s.push(pm25);
        if (pm10 !== null) pm10s.push(pm10);
        const ts = typeof s['timestamp'] === 'string' ? (s['timestamp'] as string) : null;
        if (ts && (!measuredAt || ts > measuredAt)) measuredAt = ts;
      }
      if (seen.size === 0) return null;
      const m25 = median(pm25s);
      const m10 = median(pm10s);
      return {
        count: seen.size,
        pm25: m25 !== null ? Math.round(m25 * 10) / 10 : null,
        pm10: m10 !== null ? Math.round(m10 * 10) / 10 : null,
        nearestKm: Number.isFinite(nearestKm) ? Math.round(nearestKm * 10) / 10 : 0,
        kategoria: worstCategory([
          m25 !== null ? pmCategory('PM25', m25) : null,
          m10 !== null ? pmCategory('PM10', m10) : null,
        ]),
        measuredAt,
      };
    },
    (r) => r !== null,
  );
}

// --- Airly (czujniki partnerskie, m.in. na paczkomatach InPost) ---------------

export type AirlyAir = {
  pm25: number | null;
  pm10: number | null;
  caqi: number | null;
  kategoria: string | null;
  level: string | null;
};

const AIRLY_LEVEL_TO_KAT: Record<string, string> = {
  VERY_LOW: 'Bardzo dobry',
  LOW: 'Dobry',
  MEDIUM: 'Umiarkowany',
  HIGH: 'Zły',
  VERY_HIGH: 'Bardzo zły',
  EXTREME: 'Bardzo zły',
};

/** Najbliższy punkt pomiarowy Airly (do 3 km). Wymaga AIRLY_API_KEY — bez klucza pomijamy. */
export async function airlyNear(lat: number, lon: number): Promise<AirlyAir | null> {
  const key = process.env.AIRLY_API_KEY;
  if (!key) return null;
  return cached(
    `airly:${lat.toFixed(2)}:${lon.toFixed(2)}`,
    15 * 60 * 1000,
    async () => {
      const res = await fetch(
        `https://airapi.airly.com/v2/measurements/nearest?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&maxDistanceKM=3`,
        {
          headers: { Accept: 'application/json', apikey: key },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as {
        current?: {
          values?: { name?: string; value?: number }[];
          indexes?: { name?: string; value?: number; level?: string }[];
        };
      };
      const values = j.current?.values ?? [];
      const idx = (j.current?.indexes ?? []).find((i) => i.name === 'AIRLY_CAQI');
      const val = (name: string) => {
        const v = values.find((x) => x.name === name)?.value;
        return typeof v === 'number' ? v : null;
      };
      const level = idx?.level ?? null;
      return {
        pm25: val('PM25'),
        pm10: val('PM10'),
        caqi: typeof idx?.value === 'number' ? idx.value : null,
        kategoria: level ? (AIRLY_LEVEL_TO_KAT[level] ?? null) : null,
        level,
      };
    },
    (r) => r !== null,
  );
}

/** Stacja GIOŚ najbliższa punktu (gdy miejscowość nie ma własnej stacji). */
export function nearestStation(
  stations: GiosStation[],
  lat: number,
  lon: number,
): { station: GiosStation; distanceKm: number } | null {
  let best: { station: GiosStation; distanceKm: number } | null = null;
  for (const st of stations) {
    if (st.lat === null || st.lon === null) continue;
    const d = distKm(lat, lon, st.lat, st.lon);
    if (!best || d < best.distanceKm) best = { station: st, distanceKm: d };
  }
  return best;
}

export type AirResult = {
  station: GiosStation;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: { id: number; name: string; city: string }[];
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
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
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
}> {
  const locality = normCity(localityRaw);
  const stations = await allStations();
  // pusta fraza po normalizacji ("!!!" → "") NIE może dopasować niczego —
  // ''.includes() zawsze prawdziwe i zwróciłoby pierwszą stację z listy
  const matches =
    locality.length === 0
      ? []
      : stations.filter((st) => {
          const c = normCity(st.city);
          const n = normCity(st.name);
          // puste miasto stacji (c='') też łapało wszystko przez includes('')
          return c.includes(locality) || (c.length > 0 && locality.includes(c)) || n.includes(locality);
        });

  // kandydaci na stację urzędową: dopasowanie po nazwie, a gdy miejscowość nie ma
  // stacji — najbliższa GIOŚ po współrzędnych (geokodowanie z cache)
  let candidates: { station: GiosStation; distanceKm: number | null }[] = matches
    .slice(0, 3)
    .map((s) => ({ station: s, distanceKm: null }));
  let refPoint: { lat: number; lon: number } | null = null;
  if (candidates.length > 0) {
    const st = candidates[0].station;
    refPoint = st.lat !== null && st.lon !== null ? { lat: st.lat, lon: st.lon } : null;
  }
  if (candidates.length === 0) {
    const [geo] = await geocodeBatch([localityRaw]).catch((): [null] => [null]);
    if (geo) {
      refPoint = { lat: geo.lat, lon: geo.lon };
      const near = nearestStation(stations, geo.lat, geo.lon);
      if (near && near.distanceKm <= 80) {
        candidates = [
          { station: near.station, distanceKm: Math.round(near.distanceKm * 10) / 10 },
        ];
      }
    }
  }
  // punkt odniesienia dla czujników: koordynaty stacji albo geokodowana miejscowość
  if (!refPoint) {
    const [geo] = await geocodeBatch([localityRaw]).catch((): [null] => [null]);
    if (geo) refPoint = { lat: geo.lat, lon: geo.lon };
  }

  // pierwsza stacja bez indeksu nie blokuje — próbujemy kolejnych kandydatów,
  // aż znajdziemy stację z policzoną kategorią indeksu
  let station: GiosStation | null = null;
  let distanceKm: number | null = null;
  let a: AqIndexResponse['AqIndex'] = {};
  for (const cand of candidates) {
    station = cand.station;
    distanceKm = cand.distanceKm;
    const idx = await Effect.runPromise(
      giosJson<{ AqIndex?: Record<string, unknown> }>(`/aqindex/getIndex/${cand.station.id}`),
    ).catch(() => ({}) as AqIndexResponse);
    a = idx.AqIndex ?? {};
    if (a['Nazwa kategorii indeksu']) break;
  }

  const { community, airly } = await sourcesNear(refPoint);

  if (!station) {
    // brak stacji urzędowej — pokazujemy choćby czujniki obywatelskie/Airly
    const kat = community?.kategoria ?? airly?.kategoria ?? null;
    return {
      query: localityRaw,
      matches: [],
      station: null,
      kategoria: null,
      wartosc: null,
      dataObliczen: null,
      dataZrodlowa: null,
      pollutants: [],
      advice: kat
        ? adviceFor(kat)
        : `Nie znaleziono stacji GIOŚ dla „${localityRaw}" — wybierz pobliskie miasto.`,
      alternatives: [],
      distanceKm: null,
      community,
      airly,
    };
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

  // pozostałe dopasowane stacje (bez wybranej) — jedna lista dla matches i alternatives
  const others = matches
    .filter((m) => m.id !== station!.id)
    .slice(0, 4)
    .map((m) => ({ id: m.id, name: m.name, city: m.city }));

  // porada z pierwszego źródła, które zna kategorię — stacja urzędowa może
  // nie mieć policzonego indeksu, a czujniki obywatelskie mają dane
  const effectiveKategoria = kategoria ?? community?.kategoria ?? airly?.kategoria ?? null;

  return {
    query: localityRaw,
    matches: others,
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
    advice: adviceFor(effectiveKategoria),
    alternatives: others,
    distanceKm,
    community,
    airly,
  };
}
