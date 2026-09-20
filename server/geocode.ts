/**
 * Geokodowanie adresów przez Nominatim (OpenStreetMap) — do mapy placówek.
 *
 * Fair-use Nominatim: max 1 req/s, własny User-Agent, cache wszystkiego.
 * Trafienia lądują w SQLite (permanentnie), tempo zapewnia Semaphore(1) + pacing.
 */

import { Data, Effect, Semaphore } from 'effect';
import { db } from './db';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  'ZdrowaPolska/1.0 (hackathon; https://github.com/rafalohaki/zdrowapolska)';

export class GeoError extends Data.TaggedError('GeoError')<{
  readonly cause: string;
}> {}

const semaphore = Effect.runSync(Semaphore.make(1));

db.exec(`
  CREATE TABLE IF NOT EXISTS geocache (
    address TEXT PRIMARY KEY,
    lat REAL,
    lon REAL,
    fetched_at TEXT NOT NULL,
    miss INTEGER NOT NULL DEFAULT 0
  );
`);

const nowIso = () => new Date().toISOString();
// miss ważny 30 dni — potem ponawiamy (Nominatim sukcesywnie uzupełnia dane)
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function dbLookup(address: string): { lat: number; lon: number } | 'miss' | null {
  const row = db.query('SELECT lat, lon, miss, fetched_at FROM geocache WHERE address = ?').get(address) as
    | { lat: number | null; lon: number | null; miss: number; fetched_at: string }
    | undefined;
  if (!row) return null;
  if (row.miss || row.lat === null || row.lon === null) {
    const age = Date.now() - new Date(row.fetched_at).getTime();
    return age < MISS_TTL_MS ? 'miss' : null;
  }
  return { lat: row.lat, lon: row.lon };
}

function dbSave(address: string, point: { lat: number; lon: number } | null): void {
  db.query(
    'INSERT INTO geocache (address, lat, lon, fetched_at, miss) VALUES (?, ?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at, miss = excluded.miss',
  ).run(address, point?.lat ?? null, point?.lon ?? null, nowIso(), point ? 0 : 1);
}

type NomiHit = { lat: string; lon: string; importance?: number };

function nominatimEffect(address: string) {
  return Effect.gen(function* () {
    // GSL daje adresy typu "ul.Wrocławska 1-3, 30-901 Kraków-Krowodrza" — normalizuj
    const q = address.replace(/^ul\.|^al\.|^os\./i, '').trim();
    const params = new URLSearchParams({
      q: `${q}, Polska`,
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'pl',
    });
    const res = yield* semaphore.withPermits(1)(
      Effect.tryPromise({
        try: (signal) =>
          fetch(`${NOMINATIM_URL}?${params}`, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          }),
        catch: (cause) => new GeoError({ cause: String(cause) }),
      }).pipe(Effect.tap(() => Effect.sleep('1 second'))), // pacing 1 req/s po ZAKOŃCZENIU zapytania
    );
    if (!res.ok) return yield* Effect.fail(new GeoError({ cause: `HTTP ${res.status}` }));
    const hits = (yield* Effect.tryPromise({
      try: () => res.json() as Promise<NomiHit[]>,
      catch: (cause) => new GeoError({ cause: String(cause) }),
    })) as NomiHit[];
    const hit = hits[0];
    if (!hit) return null;
    return { lat: Number(hit.lat), lon: Number(hit.lon) };
  }).pipe(
    Effect.retry({ times: 1, while: (e) => e._tag === 'GeoError' }),
    // 'error' ≠ null: przejściowa awaria Nominatima nie może truć cache'a jako
    // 30-dniowy „nie znaleziono" — miss zapisujemy tylko dla faktycznego braku
    Effect.catch(() => Effect.succeed('error' as const)),
  );
}

export type GeoResult = { address: string; lat: number; lon: number } | null;

/**
 * Geokoduje batch adresów (cache-first; max 20 na zapytanie).
 * Zwraca JEDEN wynik na każdy adres wejściowy — deduplikacja służy tylko
 * ograniczeniu pracy; pytanie o duplikaty nie zaburza indeksowania odpowiedzi.
 * NULL = nie znaleziono (zapisane, nie pytamy ponownie przez MISS_TTL_MS).
 */
export async function geocodeBatch(addresses: string[]): Promise<(GeoResult | null)[]> {
  const inputs = addresses.map((a) => a.trim()).filter(Boolean).slice(0, 20);
  const resolved = new Map<string, GeoResult | null>();
  for (const address of new Set(inputs)) {
    const hit = dbLookup(address);
    if (hit && hit !== 'miss') {
      resolved.set(address, { address, ...hit });
      continue;
    }
    if (hit === 'miss') {
      resolved.set(address, null);
      continue;
    }
    const point = await Effect.runPromise(nominatimEffect(address));
    if (point === 'error') {
      // błąd sieciowy/HTTP — nie zapisuj miss, zapytamy ponownie następnym razem
      resolved.set(address, null);
      continue;
    }
    dbSave(address, point);
    resolved.set(address, point ? { address, lat: point.lat, lon: point.lon } : null);
  }
  return inputs.map((a) => resolved.get(a) ?? null);
}
