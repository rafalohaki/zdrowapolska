/**
 * Jakość powietrza — GIOŚ PJP API v1 (publiczne, bez klucza).
 *
 * UWAGA: GIOŚ v1 zwraca 406 na „Accept: application/json" (negocjacja JSON-LD) —
 * fetch bez nagłówka Accept. Pacing 1 req/s zgodnie z dobrymi praktykami GIOŚ.
 */

import { Data, Effect, Semaphore, Schedule } from 'effect';
import { cached } from './cache';
import { geocodeBatchWithStatus, type GeoResult } from './geocode';

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
      if (!res.ok) {
        // 429 = GIOŚ nas dławi (potwierdzona ściana 429 już przy tempie >1 req/s):
        // honoruj nagłówek Retry-After (sekundy; bez nagłówka 5 s, cap 20 s).
        // Sleep trwa w semaforze, więc i pozostałe żądania odczekają zamiast
        // dokładać wolumenu do dławiącego upstreamu.
        if (res.status === 429) {
          const ra = Number(res.headers.get('Retry-After'));
          const waitS = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) : 5;
          yield* Effect.sleep(`${waitS} seconds`);
        }
        return yield* Effect.fail(new GiosError({ cause: `GIOŚ ${res.status} dla ${path}` }));
      }
      return yield* Effect.tryPromise({
        try: () => res.json() as Promise<T>,
        catch: (cause) => new GiosError({ cause: String(cause) }),
      });
    }).pipe(
      // wykładniczy backoff (2 s → 4 s) zamiast stałego — kolejne podejścia
      // coraz rzadziej, mniej wolumenu na dławiący upstream
      Effect.retry({ times: 2, schedule: Schedule.exponential('2 seconds', 2) }),
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

/** Statusy źródeł do uczciwego UI: co sprawdzono, a co nie odpowiedziało.
 *  gios 'ok' znaczy „lista stacji pobrana”, NIE „wybrana stacja ma indeks”. */
export type AirSources = {
  gios: 'ok' | 'error';
  community: 'ok' | 'empty' | 'error';
  airly: 'off' | 'ok' | 'error'; // 'off' = brak klucza AIRLY_API_KEY
};

/** Pomiary okoliczne (czujniki obywatelskie + Airly) wokół punktu odniesienia.
 *  Błędy źródeł NIE są cicho zamieniane na null — status wraca w body /api/air. */
async function sourcesNear(refPoint: { lat: number; lon: number } | null): Promise<{
  community: CommunityAir | null;
  airly: AirlyAir | null;
  probed: { community: AirSources['community']; airly: AirSources['airly'] };
}> {
  if (!refPoint) {
    // brak współrzędnych (geokoder padł/ nie znaleziono) — nie udajemy „sprawdzone”
    return { community: null, airly: null, probed: { community: 'empty', airly: 'off' } };
  }
  const airlyKey = !!process.env.AIRLY_API_KEY;
  const [communityRes, airlyRes] = await Promise.all([
    communityAirNear(refPoint.lat, refPoint.lon).then(
      (c): { c: CommunityAir | null; st: AirSources['community'] } => ({ c, st: c ? 'ok' : 'empty' }),
      (): { c: CommunityAir | null; st: AirSources['community'] } => ({ c: null, st: 'error' }),
    ),
    airlyKey
      ? airlyNear(refPoint.lat, refPoint.lon).then(
          (a): { a: AirlyAir | null; st: AirSources['airly'] } => ({ a, st: 'ok' }),
          (): { a: AirlyAir | null; st: AirSources['airly'] } => ({ a: null, st: 'error' }),
        )
      : Promise.resolve({ a: null, st: 'off' as const }),
  ]);
  return {
    community: communityRes.c,
    airly: airlyRes.a,
    probed: { community: communityRes.st, airly: airlyRes.st },
  };
}

/** Skąd pochodzi efektywna kategoria (UI pokazuje źródło obok pigułki): 'gios'
 *  gdy indeks GIOŚ policzony, inaczej czujniki obywatelskie, inaczej Airly;
 *  null gdy żadne źródło nie zna kategorii. */
function zrodloDla(
  eff: string | null,
  giosKategoria: string | null,
  communityKategoria: string | null,
): 'gios' | 'community' | 'airly' | null {
  if (eff === null) return null;
  if (giosKategoria !== null) return 'gios';
  return communityKategoria !== null ? 'community' : 'airly';
}

/** Indeks + porada dla KONKRETNEJ stacji (po id z autouzupełniania). */
export async function airForStation(stationId: number): Promise<{
  station: GiosStation | null;
  kategoria: string | null;
  kategoriaEfektywna: string | null;
  zrodloKategorii: 'gios' | 'community' | 'airly' | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: AirAlternative[];
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
  sources: AirSources;
}> {
  const stations = await allStations();
  const station = stations.find((st) => st.id === stationId) ?? null;
  if (!station) {
    return { station: null, kategoria: null, kategoriaEfektywna: null, zrodloKategorii: null, wartosc: null, dataObliczen: null, dataZrodlowa: null, pollutants: [], advice: 'Nie znaleziono stacji.', alternatives: [], distanceKm: null, community: null, airly: null, sources: { gios: 'ok', community: 'empty', airly: 'off' } };
  }
  const refPoint =
    station.lat !== null && station.lon !== null ? { lat: station.lat, lon: station.lon } : null;
  // sondowania indeksu idą do `probed` — alternatives pokażą z nich, które
  // pobliskie stacje mają żywe dane (zero dodatkowych wywołań; wzór: airForLocality)
  const probed = new Map<number, Record<string, unknown>>();
  const fetchIndexProbed = (id: number): Promise<Record<string, unknown>> =>
    fetchStationIndex(id).then((idx) => {
      probed.set(id, idx);
      return idx;
    });
  let a = await fetchIndexProbed(stationId);
  const { community, airly, probed: probeStatus } = await sourcesNear(refPoint);
  // to podstawowy flow UI (?station=): gdy stacja nie ma policzonego indeksu
  // (stacja manualna, np. Busko-Zdrój 756) i czujniki też nie znają kategorii —
  // podmień ją na najbliższą stację GIOŚ z żywym indeksem (≤3 próby, ≤80 km),
  // zamiast serwować martwą kartę
  let effectiveStation = station;
  let distanceKm = 0;
  if (!a['Nazwa kategorii indeksu'] && !communityLokalna(community) && !airly?.kategoria && refPoint) {
    const nearby = nearestStations(stations, refPoint.lat, refPoint.lon)
      .filter((c) => c.station.id !== station.id && c.distanceKm <= 80)
      .slice(0, 3);
    // tolerancyjnie: przejściowa awaria GIOŚ przy sondowaniu sąsiadów NIE odrzuca
    // już złożonej odpowiedzi ({} = „brak indeksu”, próbuj dalej); strict 502
    // zostaje dla pierwotnego indeksu stacji wyżej
    const fb = await pickWithIndex(nearby, (id) => fetchIndexProbed(id).catch(() => ({})));
    if (fb) {
      effectiveStation = fb.station;
      distanceKm = Math.round(fb.distanceKm * 10) / 10;
      a = fb.index;
      // dociągnij POZOSTAŁYCH pobliskich (≤2 dodatkowe wywołania), by alternatives
      // pokazały, które jeszcze mają żywe dane (wzór: ścieżka locality). Pojedyncza
      // awaria przy sondowaniu po prostu pomija stację.
      for (const cand of nearby) {
        if (probed.has(cand.station.id)) continue;
        await fetchIndexProbed(cand.station.id).catch(() => undefined);
      }
    }
  }
  const { kategoria, wartosc, dataObliczen, dataZrodlowa, pollutants } = parseAqIndex(a);
  // gdy GIOŚ nie ma indeksu dla stacji — porada z innych źródeł, nie „brak danych"
  const effectiveKategoria = kategoria ?? community?.kategoria ?? airly?.kategoria ?? null;
  // alternatives jak w airForLocality: najpierw sondowani sąsiedzi z żywym indeksem
  // (sortowani dystansem), potem pozostali pobliscy (≤80 km, bez znanego indeksu).
  // Wykluczamy i stację efektywną, i pierwotnie wybraną — po podmianie stacja
  // manualna (756) nie może wrócić jako klikalna alternatywa z dystansem ~0 km.
  const distOf = (st: GiosStation): number | null =>
    refPoint && st.lat !== null && st.lon !== null
      ? Math.round(distKm(refPoint.lat, refPoint.lon, st.lat, st.lon) * 10) / 10
      : null;
  const withIndex: AirAlternative[] = [];
  for (const [id, idx] of probed) {
    if (id === effectiveStation.id || id === stationId || !idx['Nazwa kategorii indeksu']) continue;
    const st = stations.find((s) => s.id === id);
    if (!st) continue;
    withIndex.push({
      id: st.id,
      name: st.name,
      city: st.city,
      kategoria: parseAqIndex(idx).kategoria,
      distanceKm: distOf(st),
    });
  }
  withIndex.sort((x, y) => (x.distanceKm ?? Infinity) - (y.distanceKm ?? Infinity));
  const others: AirAlternative[] = refPoint
    ? nearestStations(stations, refPoint.lat, refPoint.lon)
        .filter(
          (c) =>
            c.station.id !== effectiveStation.id &&
            c.station.id !== stationId &&
            !withIndex.some((w) => w.id === c.station.id) &&
            c.distanceKm <= 80,
        )
        .slice(0, 4)
        .map((m) => ({
          id: m.station.id,
          name: m.station.name,
          city: m.station.city,
          kategoria: null,
          distanceKm: distOf(m.station),
        }))
    : [];
  return {
    station: effectiveStation,
    kategoria,
    kategoriaEfektywna: effectiveKategoria,
    zrodloKategorii: zrodloDla(effectiveKategoria, kategoria, community?.kategoria ?? null),
    wartosc,
    dataObliczen,
    dataZrodlowa,
    pollutants,
    advice: adviceFor(effectiveKategoria),
    alternatives: [...withIndex, ...others].slice(0, 3),
    distanceKm,
    community,
    airly,
    sources: { gios: 'ok', ...probeStatus },
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
  /** odległość najbliższego czujnika od DOKŁADNEGO punktu zapytania (null gdy czujnik bez współrzędnych) */
  nearestKm: number | null;
  kategoria: string | null;
  measuredAt: string | null;
  /** promień faktycznie przeszukany — małe miejscowości wymagają eskalacji 12→25→50 km */
  radiusKm: number;
};

const SC_BASE = 'https://data.sensor.community/airrohr/v1';
const SC_RADII_KM = [12, 25, 50] as const;
/** Czujnik „lokalny” = w promieniu pierwszego sondowania. Kategoria z czujników
 *  dalej niż 12 km (mediana z np. 36 km opisuje inne miejscowości) NIE powinna
 *  blokować fallbacku na żywą stację GIOŚ; czujnik bez współrzędnych (nearestKm
 *  null) też nie blokuje — nie wiemy, czy w ogóle dotyczy zapytanego punktu. */
const COMMUNITY_LOCAL_KM = SC_RADII_KM[0];

/** Czy kategoria z czujników obywatelskich liczy się jako lokalna (patrz COMMUNITY_LOCAL_KM). */
function communityLokalna(c: CommunityAir | null): boolean {
  return !!c?.kategoria && c.nearestKm !== null && c.nearestKm <= COMMUNITY_LOCAL_KM;
}

// limity cache komórki: surowe wiersze z area=50 km potrafią być MB per komórka
// (Redis 128 MB allkeys-lru) — trzymamy tylko to, czego potrzebuje agregacja,
// w ograniczonej liczbie i wieku
const SC_MAX_ROWS = 500;
const SC_MAX_ROW_AGE_MS = 24 * 60 * 60 * 1000;

/** Minimalny wiersz czujnika — wystarczający do agregacji mediany i dystansu. */
type ScRow = {
  sid: number;
  lat: number | null;
  lon: number | null;
  pm25: number | null;
  pm10: number | null;
  ts: string | null;
};

/** Minimalne wiersze czujników SC dla komórki ~0,1° i promienia (cache Redis/pamięć).
 *  Puste komórki trzymają się bardzo krótko (negativeTtl); błąd HTTP NIE trafia
 *  do cache — źródło odróżnia „sprawdzone i pusto” od „nie odpowiedziało”. */
async function scRowsNear(lat: number, lon: number, radiusKm: number): Promise<ScRow[]> {
  // klucz per ~0.1° + promień — obce miejscowości w okolicy dzielą cache
  const key = `airsc:${lat.toFixed(1)}:${lon.toFixed(1)}:${radiusKm}`;
  return cached(
    key,
    15 * 60 * 1000,
    async () => {
      const res = await fetch(`${SC_BASE}/filter/area=${lat.toFixed(4)},${lon.toFixed(4)},${radiusKm}`, {
        signal: AbortSignal.timeout(12_000),
        headers: { 'User-Agent': 'ZdrowaPolska/1.0 (hackathon)' },
      });
      if (!res.ok) throw new Error(`Sensor.Community HTTP ${res.status}`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!Array.isArray(rows)) throw new Error('Sensor.Community: nieoczekiwany format odpowiedzi');

      const parsed: ScRow[] = [];
      const seen = new Set<number>();
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
        parsed.push({
          sid,
          lat: Number.isFinite(slat) ? slat : null,
          lon: Number.isFinite(slon) ? slon : null,
          pm25,
          pm10,
          ts: typeof s['timestamp'] === 'string' ? (s['timestamp'] as string) : null,
        });
      }
      if (parsed.length === 0) return [];
      // limit wieku (stary pomiar nie jest wiarygodny)…
      const fresh = parsed.filter((r) => r.ts === null || Date.now() - Date.parse(r.ts) < SC_MAX_ROW_AGE_MS);
      // …i liczby wierszy (najświeższe wygrywają)
      return fresh.length > SC_MAX_ROWS
        ? fresh
            .sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? '') || a.sid - b.sid)
            .slice(0, SC_MAX_ROWS)
        : fresh;
    },
    (rows) => rows.length > 0,
    2 * 60 * 1000,
  );
}

/** Czujniki PM (SDS011 itp.) wokół punktu — eskalacja promienia 12→25→50 km, gdy
 *  mała miejscowość nie ma czujników blisko (area 12 i 25 km bywają puste).
 *  Agregacja (mediana + najbliższy dystans) liczona względem DOKŁADNEGO punktu
 *  zapytania, POZA cache (cache trzyma wiersze względem komórki ~0,1°).
 *  Rzuca przy błędzie źródła; null = sprawdzono (do 50 km) i nie ma czujników z PM. */
export async function communityAirNear(lat: number, lon: number): Promise<CommunityAir | null> {
  for (const radiusKm of SC_RADII_KM) {
    const rows = await scRowsNear(lat, lon, radiusKm);
    if (rows.length === 0) continue;
    const pm25s: number[] = [];
    const pm10s: number[] = [];
    let nearestKm = Infinity;
    let measuredAt: string | null = null;
    for (const r of rows) {
      if (r.pm25 !== null) pm25s.push(r.pm25);
      if (r.pm10 !== null) pm10s.push(r.pm10);
      if (r.lat !== null && r.lon !== null) {
        nearestKm = Math.min(nearestKm, distKm(lat, lon, r.lat, r.lon));
      }
      if (r.ts && (!measuredAt || r.ts > measuredAt)) measuredAt = r.ts;
    }
    const m25 = median(pm25s);
    const m10 = median(pm10s);
    return {
      count: rows.length,
      pm25: m25 !== null ? Math.round(m25 * 10) / 10 : null,
      pm10: m10 !== null ? Math.round(m10 * 10) / 10 : null,
      nearestKm: Number.isFinite(nearestKm) ? Math.round(nearestKm * 10) / 10 : null,
      kategoria: worstCategory([
        m25 !== null ? pmCategory('PM25', m25) : null,
        m10 !== null ? pmCategory('PM10', m10) : null,
      ]),
      measuredAt,
      radiusKm,
    };
  }
  return null;
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

/** Najbliższy punkt pomiarowy Airly (do 10 km). Wymaga AIRLY_API_KEY — bez klucza
 *  pomijamy (status 'off'). Błąd HTTP rzuca — sourcesNear odróżni awarię od pusto. */
export async function airlyNear(lat: number, lon: number): Promise<AirlyAir | null> {
  const key = process.env.AIRLY_API_KEY;
  if (!key) return null;
  return cached(
    `airly:${lat.toFixed(2)}:${lon.toFixed(2)}`,
    15 * 60 * 1000,
    async () => {
      const res = await fetch(
        `https://airapi.airly.com/v2/measurements/nearest?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&maxDistanceKM=10`,
        {
          headers: { Accept: 'application/json', apikey: key },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) throw new Error(`Airly HTTP ${res.status}`);
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
      // Airly zwraca pełną precyzję float — jak w Sensor.Community zaokrąglamy do 0,1
      // (caqi zostaje: UI zaokrągla go przy renderze; kategoria pochodzi z pola level API)
      const round1 = (v: number | null) => (v !== null ? Math.round(v * 10) / 10 : null);
      return {
        pm25: round1(val('PM25')),
        pm10: round1(val('PM10')),
        caqi: typeof idx?.value === 'number' ? idx.value : null,
        kategoria: level ? (AIRLY_LEVEL_TO_KAT[level] ?? null) : null,
        level,
      };
    },
    (r) => r !== null,
  );
}

/** Stacje GIOŚ posortowane wg odległości od punktu (uogólnienie nearestStation —
 *  fallback „najbliższa stacja z żywym indeksem” bierze z tej listy kolejnych kandydatów). */
export function nearestStations(
  stations: GiosStation[],
  lat: number,
  lon: number,
  limit?: number,
): { station: GiosStation; distanceKm: number }[] {
  const ranked = stations
    .filter((st) => st.lat !== null && st.lon !== null)
    .map((st) => ({ station: st, distanceKm: distKm(lat, lon, st.lat!, st.lon!) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return typeof limit === 'number' ? ranked.slice(0, limit) : ranked;
}

/** Stacja GIOŚ najbliższa punktu (gdy miejscowość nie ma własnej stacji). */
export function nearestStation(
  stations: GiosStation[],
  lat: number,
  lon: number,
): { station: GiosStation; distanceKm: number } | null {
  return nearestStations(stations, lat, lon, 1)[0] ?? null;
}

/** Kandydat na stację urzędową z opcjonalną odległością (null dla dopasowania po nazwie). */
export type StationCandidate = { station: GiosStation; distanceKm: number | null };

/**
 * Czysta funkcja wyboru stacji: dociąga indeksy KOLEJNYCH kandydatów (≤ limit),
 * aż któraś ma policzoną kategorię indeksu („Nazwa kategorii indeksu” ≠ null).
 * fetchIndex wstrzykiwany — testy na fiksie, bez sieci. Zwraca null, gdy żadna
 * z sprawdzonych stacji nie ma indeksu.
 */
export async function pickWithIndex<C extends StationCandidate>(
  candidates: C[],
  fetchIndex: (stationId: number) => Promise<Record<string, unknown>>,
  limit = 3,
): Promise<(C & { index: Record<string, unknown> }) | null> {
  let tried = 0;
  for (const cand of candidates) {
    if (tried >= limit) break;
    tried++;
    const index = await fetchIndex(cand.station.id);
    if (index['Nazwa kategorii indeksu']) return { ...cand, index };
  }
  return null;
}

/** Alternatywa stacji: wzbogacona o kategorię i odległość — widać, które stacje mają dane. */
export type AirAlternative = {
  id: number;
  name: string;
  city: string;
  kategoria: string | null;
  distanceKm: number | null;
};

export type AirResult = {
  station: GiosStation;
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: AirAlternative[];
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

/** Stacje, o które GIOŚ została co najmniej raz spytana i odpowiedziała 200 BEZ
 *  policzonego indeksu (pomiar ręczny, np. Busko-Zdrój 756). Memo modułowe, wąskie
 *  gardło wszystkich sondowań to fetchStationIndex — stąd jedno miejsce zapisu. */
const stacjeManualne = new Set<number>();

/**
 * Surowy obiekt indeksu dla stacji. {} = GIOŚ odpowiada, ale indeksu nie policzyła
 * (stacje manualne, np. Busko-Zdrój 756). Awaria upstreamu (GiosError po retryach)
 * PRZELATUJE wyżej — endpoint zwróci 502 zamiast udawać „brak danych”.
 */
async function fetchStationIndex(stationId: number): Promise<Record<string, unknown>> {
  const idx = await Effect.runPromise(
    giosJson<{ AqIndex?: Record<string, unknown> }>(`/aqindex/getIndex/${stationId}`),
  );
  const aq = idx.AqIndex ?? {};
  // memo (d3): HTTP-200 bez policzonego indeksu = stacja manualna (pomiar ręczny).
  // Podpowiedzi i UI odnotują to bez kolejnych sondowań; awaria (GiosError) przelatuje
  // wyżej i memo NIE oznacza — „nie wiemy” ≠ „manualna”.
  if (!aq['Nazwa kategorii indeksu']) stacjeManualne.add(stationId);
  return aq;
}

type ParsedIndex = {
  kategoria: string | null;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
};

/** Rozbiera płaski obiekt GIOŚ AqIndex na kategorię + listę wskaźników. */
function parseAqIndex(a: Record<string, unknown>): ParsedIndex {
  const pollutants: AirPollutant[] = [];
  for (const [key, kategoria] of Object.entries(a)) {
    if (!key.startsWith('Nazwa kategorii indeksu dla wskażnika ') || typeof kategoria !== 'string')
      continue;
    const wskaznik = key.replace('Nazwa kategorii indeksu dla wskażnika ', '');
    const wartosc = a[`Wartość indeksu dla wskaźnika ${wskaznik}`];
    pollutants.push({
      wskaznik,
      kategoria,
      wartosc: typeof wartosc === 'number' ? wartosc : null,
    });
  }
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : null);
  return {
    kategoria: str('Nazwa kategorii indeksu'),
    wartosc: typeof a['Wartość indeksu'] === 'number' ? (a['Wartość indeksu'] as number) : null,
    dataObliczen: str('Data wykonania obliczeń indeksu'),
    dataZrodlowa: str('Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'),
    pollutants,
  };
}

/** Stacje pasujące do miejscowości (do autouzupełniania) — z cache stacji.
 *  `brakNaZywo`: stacja manualna wg memo (HTTP-200 bez indeksu) — UI dopisuje
 *  „· brak danych na żywo”. Brak wpisu = „jeszcze nie sprawdzono lub ma dane”. */
export async function airStationsByLocality(localityRaw: string): Promise<
  { id: number; name: string; city: string; brakNaZywo: boolean }[]
> {
  const q = normCity(localityRaw);
  if (q.length < 3) return [];
  const stations = await allStations();
  // miasto przed nazwą: „Kraków" nie może przegrywać z „Piotrków Trybunalski,
  // ul. Krakowskie Przedmieście" tylko przez niższy id GIOŚ. Po nazwie dopasowujemy
  // tylko część przed przecinkiem („Miasto, ulica"), a gdy przecinka nie ma —
  // pełną nazwę (nie każda stacja GIOŚ ma ten format)
  const cityHit = (st: (typeof stations)[number]) => normCity(st.city).includes(q);
  const nameHit = (st: (typeof stations)[number]) => {
    const head = st.name.split(',')[0];
    return normCity(head).includes(q);
  };
  return stations
    .filter((st) => cityHit(st) || nameHit(st))
    .sort((a, b) => Number(cityHit(b)) - Number(cityHit(a)) || a.name.localeCompare(b.name, 'pl'))
    .slice(0, 8)
    .map((st) => ({ id: st.id, name: st.name, city: st.city, brakNaZywo: stacjeManualne.has(st.id) }));
}

export async function airForLocality(localityRaw: string): Promise<{
  query: string;
  matches: { id: number; name: string; city: string }[];
  station: GiosStation | null;
  kategoria: string | null;
  kategoriaEfektywna: string | null;
  /** skąd kategoriaEfektywna — UI pokazuje źródło obok pigułki (d4) */
  zrodloKategorii: 'gios' | 'community' | 'airly' | null;
  /** true = fallback podmienił miejscową stację manualną na dalszą z żywym indeksem (d3) */
  miejscowaStacjaManualna: boolean;
  wartosc: number | null;
  dataObliczen: string | null;
  dataZrodlowa: string | null;
  pollutants: AirPollutant[];
  advice: string;
  alternatives: AirAlternative[];
  distanceKm: number | null;
  community: CommunityAir | null;
  airly: AirlyAir | null;
  sources: AirSources;
  /** true = oba geokodery padły (stan przejściowy — nie cache'ować) */
  geoError: boolean;
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
  // ranking jak w airStationsByLocality: stacje z dopasowanym miastem przed
  // pozostałymi (nazwa jako tie-breaker) — bez tego „Kraków" jako WYBRANĄ stację
  // dostawało Piotrków Trybunalski („ul. Krakowskie Przedmieście", niski id GIOŚ)
  matches.sort(
    (a, b) =>
      Number(normCity(b.city).includes(locality)) - Number(normCity(a.city).includes(locality)) ||
      a.name.localeCompare(b.name, 'pl'),
  );

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
  // geokodowanie z pamięcią wyniku (obie ścieżki niżej korzystają z JEDNEGO lookupu)
  // + rozróżnienie „nie znaleziono” od „oba providery padły” (f9). Memo na obiekcie —
  // TS nie śledzi przypisań do zmiennych z wnętrza closures.
  const geoMemo: { outcome: { point: GeoResult | null; error: boolean } | null } = { outcome: null };
  const geoOnce = async (): Promise<{ point: GeoResult | null; error: boolean }> => {
    if (geoMemo.outcome) return geoMemo.outcome;
    const r = await geocodeBatchWithStatus([localityRaw]).catch(
      (): { results: (GeoResult | null)[]; error: boolean } => ({ results: [null], error: true }),
    );
    geoMemo.outcome = { point: r.results[0] ?? null, error: r.error };
    return geoMemo.outcome;
  };
  if (candidates.length === 0) {
    const { point: geo } = await geoOnce();
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
    const { point: geo } = await geoOnce();
    if (geo) refPoint = { lat: geo.lat, lon: geo.lon };
  }

  // pierwsza stacja bez indeksu nie blokuje — próbujemy kolejnych kandydatów,
  // aż znajdziemy stację z policzoną kategorią indeksu. Wyniki sondowań idą do
  // `probed`, żeby alternatives pokazały, które pobliskie stacje MAJĄ dane.
  const probed = new Map<number, Record<string, unknown>>();
  const fetchIndexProbed = (id: number): Promise<Record<string, unknown>> =>
    fetchStationIndex(id).then((idx) => {
      probed.set(id, idx);
      return idx;
    });
  const picked = await pickWithIndex(candidates, fetchIndexProbed);
  let station: GiosStation | null = picked?.station ?? candidates[0]?.station ?? null;
  let distanceKm: number | null = picked?.distanceKm ?? candidates[0]?.distanceKm ?? null;
  let a: Record<string, unknown> = picked?.index ?? {};

  const { community, airly, probed: probeStatus } = await sourcesNear(refPoint);
  const sources: AirSources = { gios: 'ok', ...probeStatus };

  // fallback: wybrana stacja bez policzonego indeksu (stacja manualna, jak
  // Busko-Zdrój 756 — jedyna w mieście) i czujniki obywatelskie/Airly też nie
  // znają kategorii — dociągnij najbliższe stacje GIOŚ z żywym indeksem
  // (≤3 próby, ≤80 km) i podmień station/distanceKm
  let miejscowaStacjaManualna = false;
  if (!picked && station !== null && !communityLokalna(community) && !airly?.kategoria && refPoint) {
    const tried = new Set(candidates.map((c) => c.station.id));
    const nearby = nearestStations(stations, refPoint.lat, refPoint.lon)
      .filter((c) => !tried.has(c.station.id) && c.distanceKm <= 80)
      .slice(0, 3);
    // tolerancyjnie: przejściowa awaria GIOŚ przy sondowaniu sąsiadów NIE odrzuca
    // złożonej odpowiedzi ({} = „brak indeksu”, próbuj kolejnych); strict 502
    // zostaje dla pierwotnej pętli kandydatów wyżej
    const fb = await pickWithIndex(nearby, (id) => fetchIndexProbed(id).catch(() => ({})));
    if (fb) {
      station = fb.station;
      distanceKm = Math.round(fb.distanceKm * 10) / 10;
      a = fb.index;
      // d3: podmieniona miejscowa stacja manualna — tylko gdy kandydaci pochodzili
      // z dopasowania po nazwie/mieście (geo-fallback ma matches [] → to NIE jest
      // „miejscowa” stacja, tylko po prostu najbliższa)
      miejscowaStacjaManualna = matches.length > 0;
      // wzbogacenie alternatives: scan przerwał się na pierwszej stacji z indeksem,
      // więc dociągnij POZOSTAŁE pobliskie (≤2 dodatkowe wywołania), by alternatives
      // pokazały, które jeszcze mają żywe dane. Rzadka ścieżka (tylko fallback),
      // koszt kurtowany cache'em (30 min / 3 min negativeTtl); pojedyncza awaria
      // przy sondowaniu nie psuje dobrej odpowiedzi — po prostu pomijamy stację.
      for (const cand of nearby) {
        if (probed.has(cand.station.id)) continue;
        await fetchIndexProbed(cand.station.id).catch(() => undefined);
      }
    }
  }

  // geokoder padł po obu providerach — dopiero to wyjaśnia, czemu nie ma stacji
  // ani współrzędnych (małe wsie nieznane Nominatimowi to MISS, nie error)
  const geoError = geoMemo.outcome?.error === true;
  if (!station) {
    // brak stacji urzędowej — pokazujemy choćby czujniki obywatelskie/Airly
    const kat = community?.kategoria ?? airly?.kategoria ?? null;
    return {
      query: localityRaw,
      matches: [],
      station: null,
      kategoria: null,
      kategoriaEfektywna: kat,
      zrodloKategorii: zrodloDla(kat, null, community?.kategoria ?? null),
      miejscowaStacjaManualna: false,
      wartosc: null,
      dataObliczen: null,
      dataZrodlowa: null,
      pollutants: [],
      advice: geoError
        ? 'Geokodowanie chwilowo niedostępne — spróbuj za chwilę.'
        : kat
          ? adviceFor(kat)
          : `Nie znaleziono stacji GIOŚ dla „${localityRaw}" — wybierz pobliskie miasto.`,
      alternatives: [],
      distanceKm: null,
      community,
      airly,
      sources,
      geoError,
    };
  }

  const { kategoria, wartosc, dataObliczen, dataZrodlowa, pollutants } = parseAqIndex(a);

  // alternatives wzbogacone: najpierw najbliższe stacje z policzonym indeksem
  // (znane z sondowań TEGO żądania — zero dodatkowych wywołań GIOŚ), potem
  // pozostałe dopasowane; kategoria + odległość pokazują, które stacje mają dane
  const distOf = (st: GiosStation): number | null =>
    refPoint && st.lat !== null && st.lon !== null
      ? Math.round(distKm(refPoint.lat, refPoint.lon, st.lat, st.lon) * 10) / 10
      : null;
  const withIndex: AirAlternative[] = [];
  for (const [id, idx] of probed) {
    if (id === station!.id || !idx['Nazwa kategorii indeksu']) continue;
    const st = stations.find((s) => s.id === id);
    if (!st) continue;
    withIndex.push({
      id: st.id,
      name: st.name,
      city: st.city,
      kategoria: parseAqIndex(idx).kategoria,
      distanceKm: distOf(st),
    });
  }
  withIndex.sort((x, y) => (x.distanceKm ?? Infinity) - (y.distanceKm ?? Infinity));
  const others: AirAlternative[] = matches
    .filter((m) => m.id !== station!.id && !withIndex.some((w) => w.id === m.id))
    .slice(0, 4)
    .map((m) => ({ id: m.id, name: m.name, city: m.city, kategoria: null, distanceKm: distOf(m) }));
  const alternatives = [...withIndex, ...others].slice(0, 3);

  // porada z pierwszego źródła, które zna kategorię — stacja urzędowa może
  // nie mieć policzonego indeksu, a czujniki obywatelskie mają dane
  const effectiveKategoria = kategoria ?? community?.kategoria ?? airly?.kategoria ?? null;

  return {
    query: localityRaw,
    matches: others,
    station,
    kategoria,
    kategoriaEfektywna: effectiveKategoria,
    zrodloKategorii: zrodloDla(effectiveKategoria, kategoria, community?.kategoria ?? null),
    miejscowaStacjaManualna,
    wartosc,
    dataObliczen,
    dataZrodlowa,
    pollutants,
    advice: adviceFor(effectiveKategoria),
    alternatives,
    distanceKm,
    community,
    airly,
    sources,
    geoError,
  };
}
