/**
 * Klient API NFZ „Terminy Leczenia" (ITL) v1.4 zbudowany na Effect v4.
 * Endpointy zweryfikowane na żywo 2026-09-07 — pełna specyfikacja: docs/api-specs/nfz-itl-v1.4.json
 *
 * UWAGI:
 * - API nie zwraca konkretnych terminów wizyt, tylko statystyki kolejek
 *   (liczba oczekujących, średni czas oczekiwania w dniach, prognoza PCUS).
 * - Paginacja: max limit=25 na stronę.
 * - NFZ rate-limituje (HTTP 429 przy skokach z jednego IP) — dlatego wszystkie
 *   zapytania przechodzą przez Semaphore(1) + stały odstęp + cooldown na 429 (Ref).
 * - Kody województw to kody oddziałów NFZ (06 = małopolskie, 07 = mazowieckie), NIE TERYT.
 */

import { Data, Effect, Ref, Schedule, Semaphore } from 'effect';

const BASE = process.env.NFZ_BASE ?? 'https://apinfz.nfz.gov.pl/app-itl-api-pcus';
const TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = Number(process.env.NFZ_MAX_CONCURRENT ?? 1);
const MIN_INTERVAL_MS = Number(process.env.NFZ_MIN_INTERVAL_MS ?? 60);
const COOLDOWN_MS = Number(process.env.NFZ_COOLDOWN_MS ?? 15_000);
const RETRY_ATTEMPTS = 3;

// --- Błędy typowane (Effect Data.TaggedError) ---------------------------------

export class NfzRateLimited extends Data.TaggedError('NfzRateLimited')<Record<string, never>> {}
export class NfzPermanent extends Data.TaggedError('NfzPermanent')<{
  readonly status: number;
  readonly body: string;
}> {}
export class NfzNetwork extends Data.TaggedError('NfzNetwork')<{ readonly cause: string }> {}

export type NfzError = NfzRateLimited | NfzPermanent | NfzNetwork;

// --- Globalna infrastruktura zapytań (semaphore + pacing + cooldown) ----------

const semaphore = Effect.runSync(Semaphore.make(MAX_CONCURRENT));
const cooldownUntilRef = Effect.runSync(Ref.make(0));

// --- Efekty -------------------------------------------------------------------

/** Odczekaj cooldown (po 429) + stały odstęp między żądaniami. */
const pace = Effect.gen(function* () {
  const until = yield* Ref.get(cooldownUntilRef);
  if (until > Date.now()) yield* Effect.sleep(until - Date.now());
  yield* Effect.sleep(MIN_INTERVAL_MS);
});

function requestEffect(url: string) {
  return Effect.gen(function* () {
    yield* pace;
    const res = yield* semaphore.withPermits(1)(
      Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          }),
        catch: (cause) => new NfzNetwork({ cause: String(cause) }),
      }),
    );

    if (res.status === 429) {
      yield* Ref.update(cooldownUntilRef, (t) => Math.max(t, Date.now() + COOLDOWN_MS));
      return yield* Effect.fail(new NfzRateLimited({}));
    }
    if (!res.ok) {
      const body = yield* Effect.promise(() => res.text().catch(() => ''));
      return yield* Effect.fail(new NfzPermanent({ status: res.status, body: body.slice(0, 200) }));
    }
    return res;
  });
}

/** Retry: tylko błędy przejściowe (429 / sieć / timeout), z rosnącym odstępem. */
const retryTransient = <A, E extends NfzError, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.retry({
      times: RETRY_ATTEMPTS,
      schedule: Schedule.spaced('2 seconds'),
      while: (e: NfzError) => e._tag !== 'NfzPermanent',
    }),
  );

export async function fetchJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const program = requestEffect(url).pipe(
    Effect.flatMap((res) =>
      Effect.tryPromise({
        try: () => res.json() as Promise<T>,
        catch: (cause) => new NfzNetwork({ cause: String(cause) }),
      }),
    ),
    retryTransient,
    Effect.catchTag('NfzPermanent', (e) => Effect.fail(new Error(`NFZ ${e.status} dla ${path}: ${e.body}`))),
    Effect.catchTag('NfzRateLimited', () => Effect.fail(new Error('NFZ: przekroczono limit zapytań (429)'))),
    Effect.catchTag('NfzNetwork', (e) => Effect.fail(new Error(`NFZ niedostępny: ${e.cause}`))),
  );
  return Effect.runPromise(program);
}

// --- Publiczny interfejs (bez zmian dla reszty aplikacji) ---------------------

export const PROVINCES: { code: string; name: string }[] = [
  { code: '01', name: 'dolnośląskie' },
  { code: '02', name: 'kujawsko-pomorskie' },
  { code: '03', name: 'lubelskie' },
  { code: '04', name: 'lubuskie' },
  { code: '05', name: 'łódzkie' },
  { code: '06', name: 'małopolskie' },
  { code: '07', name: 'mazowieckie' },
  { code: '08', name: 'opolskie' },
  { code: '09', name: 'podkarpackie' },
  { code: '10', name: 'podlaskie' },
  { code: '11', name: 'pomorskie' },
  { code: '12', name: 'śląskie' },
  { code: '13', name: 'świętokrzyskie' },
  { code: '14', name: 'warmińsko-mazurskie' },
  { code: '15', name: 'wielkopolskie' },
  { code: '16', name: 'zachodniopomorskie' },
];

/** Surowy rekord kolejki z API NFZ — frontend parsuje i filtruje po swojemu. */
export type NfzRecord = Record<string, unknown>;

export type ProvinceData = {
  code: string;
  name: string;
  total: number;
  records: NfzRecord[];
};

export type CompareResponse = {
  benefit: string;
  case: 1 | 2;
  provinces: ProvinceData[];
  errors: { code: string; message: string }[];
};

export async function getBenefits(name: string): Promise<{ items: string[]; count: number }> {
  const json = await fetchJson<{ data: string[]; meta: { count: number } }>('/benefits', {
    name,
    limit: '25',
    format: 'json',
  });
  return { items: json.data ?? [], count: json.meta?.count ?? json.data?.length ?? 0 };
}

/** Słownik miejscowości (autouzupełnianie filtru „Gdzie" — jak na stronie GSL NFZ). */
export async function getLocalities(name: string): Promise<string[]> {
  const json = await fetchJson<{ data: string[] }>('/localities', {
    name,
    limit: '15',
    format: 'json',
  });
  return json.data ?? [];
}


// --- Slim payload: wysyłamy tylko pola używane przez frontend (~3x mniejszy JSON) ---
const SLIM_KEYS = [
  'provider', 'benefit', 'locality', 'address', 'phone',
  'latitude', 'longitude', 'ramp', 'elevator', 'toilet', 'wheelchairs',
  'ac', 'automatic-door', 'public-transport-lines', 'benefits-for-children',
] as const;

export function slimRecord(rec: NfzRecord): NfzRecord {
  const a = (rec.attributes ?? {}) as Record<string, unknown>;
  const attrs: Record<string, unknown> = { id: rec.id };
  for (const k of SLIM_KEYS) if (a[k] !== undefined) attrs[k] = a[k];
  const st = (a['statistics'] ?? {}) as Record<string, unknown>;
  const pd = (st['provider-data'] ?? {}) as Record<string, unknown>;
  attrs['statistics'] = {
    'provider-data': {
      awaiting: pd['awaiting'] ?? null,
      'average-period': pd['average-period'] ?? null,
      update: pd['update'] ?? null,
    },
  };
  attrs['dates'] = a['dates'] ?? {};
  return { id: rec.id, attributes: attrs };
}

type QueuesResponse = { data: NfzRecord[]; meta?: { count?: number } };

async function fetchQueuePages(
  benefit: string,
  province: string,
  kase: 1 | 2,
  pages: number,
  locality = '',
): Promise<{ records: NfzRecord[]; total: number }> {
  // strony sekwencyjnie — delikatnie dla rate-limitera NFZ
  const pageNumbers = Array.from({ length: Math.max(1, Math.min(pages, 10)) }, (_, i) => i + 1);
  let first: QueuesResponse | null = null;
  const records: NfzRecord[] = [];

  for (const page of pageNumbers) {
    const params: Record<string, string> = {
      benefit,
      province,
      case: String(kase),
      page: String(page),
      limit: '25',
      format: 'json',
    };
    if (locality) params.locality = locality;
    const res = await fetchJson<QueuesResponse>('/queues', params);
    if (!first) first = res;
    records.push(...(res.data ?? []));
    if (!res.data?.length) break; // pusta strona = koniec wyników
  }
  return { records, total: first?.meta?.count ?? records.length };
}

/** Statystyki kolejek dla JEDNEGO województwa — do ładowania progresywnego. */
export async function getProvinceQueues(
  benefit: string,
  province: string,
  kase: 1 | 2,
  pages: number,
  locality = '',
): Promise<{ code: string; name: string; total: number; records: NfzRecord[] }> {
  const p = PROVINCES.find((x) => x.code === province);
  if (!p) throw new Error(`Nieznany kod województwa: ${province}`);
  const { records, total } = await fetchQueuePages(benefit, province, kase, pages, locality);
  return { code: p.code, name: p.name, total, records: records.map(slimRecord) };
}

export async function getCompare(
  benefit: string,
  kase: 1 | 2,
  pagesPerProvince: number,
  locality = '',
): Promise<CompareResponse> {
  const results = await Promise.all(
    PROVINCES.map(async (p) => {
      try {
        const { records, total } = await fetchQueuePages(
          benefit,
          p.code,
          kase,
          pagesPerProvince,
          locality,
        );
        return { province: p, records: records.map(slimRecord), total, error: null };
      } catch (err) {
        return {
          province: p,
          records: [] as NfzRecord[],
          total: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return {
    benefit,
    case: kase,
    provinces: results.map((r) => ({
      code: r.province.code,
      name: r.province.name,
      total: r.total,
      records: r.records,
    })),
    errors: results
      .filter((r) => r.error)
      .map((r) => ({ code: r.province.code, message: r.error as string })),
  };
}
