import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cached, cacheStats, TTL } from './cache';
import {
  getCompare,
  getLocalities,
  getProvinceQueues,
  slimRecord,
  PROVINCES,
  type CompareResponse,
  type NfzRecord,
} from './nfz';
import { advise, type AiRequest, type CompactRecord } from './ai';
import {
  getSnapshotOne,
  getSnapshots,
  saveSnapshot,
  snapshotAgeHours,
  snapshotProvinces,
  dbStats,
  getSyncState,
  queueTrend,
} from './db';
import { searchBenefits, reindexBenefits } from './search';
import { getSyncStatus, startSyncScheduler, triggerSync } from './sync';
import { GSL_CATEGORIES, gslFacilities, type GslCategory } from './gsl';
import { canonicalLocality, getGslSnapshot, likeLocalities, saveGslSnapshot } from './db';
import { getConnInfo } from 'hono/bun';

const app = new Hono();

/** Liczba z query z clampem — Number('abc') = NaN psułoby limity, klucze cache'i treść zapytań. */
function intParam(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(Math.floor(n), max)) : def;
}

/** Obetnij input użytkownika — trafia do kluczy cache, promptów AI i zapytań upstream. */
function cut(raw: string, max: number): string {
  return raw.slice(0, max);
}

const corsOrigins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('/api/*', logger());
// duże JSON-y (porównania 16 woj. ~850 KB) — gzip tnie to do ~100 KB
app.use('/api/*', compress());
// nosniff, Referrer-Policy, X-Frame-Options — na odpowiedziach JSON nieszkodliwe, na statycznym SPA pomocne
app.use('/api/*', secureHeaders());
app.use(
  '/api/*',
  cors({
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  }),
);

// Nagłówki cache — middleware MUSI być zarejestrowany przed trasami
// (w Hono handler trasy kończy łańcuch; middleware zarejestrowany później nie działa)
app.use('/api/*', async (c, next) => {
  await next();
  // cache'ujemy wyłącznie czyste 200; błędy i 202 („raport w trakcie generowania")
  // nie mogą utknąć w przeglądarce/CF na czas TTL
  if (c.req.method !== 'GET' || c.res.status !== 200) {
    c.header('Cache-Control', 'no-store');
    return;
  }
  const path = c.req.path;
  if (path.startsWith('/api/search') || path.startsWith('/api/insights')) {
    c.header('Cache-Control', 'public, max-age=600');
  } else if (
    path.startsWith('/api/compare') ||
    path.startsWith('/api/localities') ||
    path.startsWith('/api/benefits') ||
    path.startsWith('/api/trend')
  ) {
    c.header('Cache-Control', 'public, max-age=300');
  } else if (path.startsWith('/api/air')) {
    c.header('Cache-Control', 'public, max-age=900, stale-while-revalidate=300');
  } else {
    c.header('Cache-Control', 'no-store');
  }
});

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: err.message ?? 'Błąd serwera' }, 500);
});

// --- Rate limiter per IP (okno 60 s) -----------------------------------------
// Endpointy zapalające upstream (NFZ/GIOŚ/Nominatim/LLM) nie mogą być spamowane
// w pętli — na produkcji stoi za tym jeszcze limit na edge (Cloudflare).
const rlBuckets = new Map<string, number[]>();
const rlSweep = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, ts] of rlBuckets) {
    const kept = ts.filter((t) => t > cutoff);
    if (kept.length) rlBuckets.set(k, kept);
    else rlBuckets.delete(k);
  }
}, 60_000);
rlSweep.unref?.();

// Nagłówki proxy (cf-connecting-ip itd.) honorujemy tylko gdy backend stoi za
// zaufanym proxy (TRUST_PROXY=1 w compose — tam request przychodzi od cloudflared).
// Bez tego bezpośrednie żądanie do :2363 mogłoby spoofować X-Forwarded-For
// i rotować „IP" w rate limiterze.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(c: Context): string {
  if (TRUST_PROXY) {
    const fwd =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-real-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return getConnInfo(c).remote.address ?? 'anon';
}

function limit(perMinute: number) {
  return async (c: Context, next: Next) => {
    const key = `${c.req.path}:${clientIp(c)}`;
    const now = Date.now();
    const ts = (rlBuckets.get(key) ?? []).filter((t) => t > now - 60_000);
    if (ts.length >= perMinute) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Za dużo zapytań — odczekaj chwilę i spróbuj ponownie.' }, 429);
    }
    ts.push(now);
    rlBuckets.set(key, ts);
    await next();
  };
}

// --- Circuit breaker na upstream NFZ ------------------------------------------
// Błąd sieciowy/429/5xx z NFZ zamyka obwód na ~45 s: zapytania idą wtedy od razu
// do przeterminowanych snapshotów zamiast młócić retry × 16 województw przy
// każdym wyszukiwaniu (semafor NFZ + retryTransient by seryjnie wymusił ~minutę
// czekania na ścianę błędu). 4xx (np. nieznana nazwa świadczenia) nie jest awarią.
let nfzDownUntil = 0;
const nfzDown = () => Date.now() < nfzDownUntil;
function noteNfzError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/niedostępny|limit zapytań|NFZ 5/.test(msg)) nfzDownUntil = Date.now() + 45_000;
}

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'zdrowapolska-backend', cache: cacheStats(), db: dbStats() }),
);

// Wyszukiwarka świadczeń (Meilisearch z synonimami i literówkami; fallbacki: SQLite → NFZ)
app.get('/api/search', limit(30), async (c) => {
  const q = cut((c.req.query('q') ?? c.req.query('name') ?? '').trim(), 80);
  const limit = intParam(c.req.query('limit'), 25, 1, 25);
  if (q.length < 3) return c.json({ items: [], count: 0, source: 'meilisearch' });
  try {
    const res = await cached(`search:${q.toLowerCase()}:${limit}`, 10 * 60 * 1000, () =>
      searchBenefits(q, limit),
    );
    return c.json({ items: res.items, count: res.items.length, source: res.source });
  } catch (err) {
    // awaria NFZ + puste Meili/SQLite → degradacja na pustą listę zamiast 500
    // (autouzupełnianie nie może umierać, gdy reszta apki płynie na snapshotach)
    noteNfzError(err);
    return c.json({ items: [], count: 0, source: 'nfz' });
  }
});

// Kompatybilność ze starym kształtem (słownik po fragmencie)
app.get('/api/benefits', limit(30), async (c) => {
  const name = cut((c.req.query('name') ?? '').trim(), 80);
  if (name.length < 3) return c.json({ items: [], count: 0 });
  try {
    const res = await cached(`search:${name.toLowerCase()}:25`, TTL.dictionaries, () =>
      searchBenefits(name, 25),
    );
    return c.json({ items: res.items, count: res.items.length });
  } catch (err) {
    noteNfzError(err);
    return c.json({ items: [], count: 0 });
  }
});

function assembleFromDb(
  benefit: string,
  kase: 1 | 2,
  snaps: ReturnType<typeof getSnapshots>,
): CompareResponse {
  const byCode = new Map(snaps.map((s) => [s.code, s]));
  return {
    benefit,
    case: kase,
    provinces: PROVINCES.map((p) => {
      const s = byCode.get(p.code);
      return {
        code: p.code,
        name: p.name,
        total: s?.total ?? 0,
        records: (s?.records ?? []).map((r) => slimRecord(r as NfzRecord)),
      };
    }),
    errors: [],
  };
}

/** Świeży zbiór CZĘŚCIOWY z bazy: dociąga tylko brakujące województwa z NFZ (indywidualnie,
 *  zamiast powtarzać cały compare). Te, które znów padły, trafiają do errors — i tak
 *  zostaną zapisane te, które się udały, więc następne zapytania dociągają coraz mniej. */
async function assemblePartialFromDb(
  benefit: string,
  kase: 1 | 2,
  pages: number,
  locality: string,
  snaps: ReturnType<typeof getSnapshots>,
): Promise<CompareResponse> {
  const have = new Map(snaps.map((s) => [s.code, s]));
  const missing = PROVINCES.filter((p) => !have.has(p.code));
  const errors: { code: string; message: string }[] = [];
  const fetched = await Promise.all(
    missing.map(async (p) => {
      try {
        const d = await getProvinceQueues(benefit, p.code, kase, pages, locality);
        saveSnapshot(benefit, p.code, kase, d.total, d.records, locality);
        return d;
      } catch (err) {
        // braki z tej ścieżki też zamykają obwód — bez noteNfzError awaria NFZ
        // powtarzałaby kosztowną pętlę dociągania przy każdym compare
        noteNfzError(err);
        errors.push({ code: p.code, message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }),
  );
  const fetchedByCode = new Map(
    fetched.filter((d): d is NonNullable<typeof d> => d !== null).map((d) => [d.code, d]),
  );
  return {
    benefit,
    case: kase,
    provinces: PROVINCES.map((p) => {
      const f = fetchedByCode.get(p.code);
      if (f) return { code: p.code, name: p.name, total: f.total, records: f.records };
      const s = have.get(p.code);
      return {
        code: p.code,
        name: p.name,
        total: s?.total ?? 0,
        records: (s?.records ?? []).map((r) => slimRecord(r as NfzRecord)),
      };
    }),
    errors,
  };
}

// Autouzupełnianie miejscowości (jak „Gdzie się leczyć" NFZ).
// Przy awarii NFZ (albo zamkniętym obwodzie) podpowiadamy z lokalnych snapshotów
// — nazwy placówek/miejscowości zapisane przy kolejkach, bez dotykania upstreamu.
app.get('/api/localities', limit(30), async (c) => {
  const name = cut((c.req.query('name') ?? '').trim(), 60);
  if (name.length < 3) return c.json({ items: [] });
  if (!nfzDown()) {
    try {
      const items = await cached(`localities:${name.toLowerCase()}`, TTL.dictionaries, () =>
        getLocalities(name),
      );
      // NFZ wymaga diakrytyków i na frazę bez nich („krakow") zwraca pusto —
      // dogrywamy wtedy dopasowaniem po normText z własnych snapshotów
      if (items.length > 0) return c.json({ items });
      const dbItems = likeLocalities(name, 15);
      if (dbItems.length > 0) return c.json({ items: dbItems, source: 'db' });
      return c.json({ items });
    } catch (err) {
      noteNfzError(err);
    }
  }
  return c.json({ items: likeLocalities(name, 15), source: 'db' });
});

// Porównanie 16 województw: najpierw świeży snapshot z SQLite (natychmiast),
// w przeciwnym razie żywe pobranie z NFZ (+ zapis snapshotu na przyszłość).
app.get('/api/compare', limit(12), async (c) => {
  const benefit = cut((c.req.query('benefit') ?? '').trim(), 120);
  const kase = c.req.query('case') === '2' ? 2 : 1;
  const pages = intParam(c.req.query('pages'), 2, 1, 4);
  // „KRAKOW" bez diakrytyków daje z NFZ 0 wyników — rozwiązujemy do kanonicznej nazwy
  const locality = canonicalLocality(cut((c.req.query('locality') ?? '').trim().toUpperCase(), 60));
  if (benefit.length < 3) {
    return c.json({ error: 'Podaj świadczenie (min. 3 znaki)' }, 400);
  }

  const ttlH = Number(process.env.SNAPSHOT_TTL_H ?? 24);
  const age = snapshotAgeHours(benefit, kase, locality);
  const saved = snapshotProvinces(benefit, kase, locality);
  if (age !== null && age <= ttlH && saved > 0) {
    const snaps = getSnapshots(benefit, kase, locality);
    const dbKey = `dbcompare:${benefit}:${kase}:${pages}:${locality}`;
    if (saved >= PROVINCES.length) {
      return c.json(await cached(dbKey, TTL.dbCompare, async () => assembleFromDb(benefit, kase, snaps)));
    }
    // częściowe snapshoty + zamknięty obwód: dociąganie braków kosztuje minuty
    // i młóci leżący upstream — serwuj to, co jest, ze znacznikiem stale
    if (nfzDown()) {
      return c.json({ ...assembleFromDb(benefit, kase, snaps), stale: true });
    }
    return c.json(
      await cached(
        dbKey,
        TTL.dbCompare,
        async () => assemblePartialFromDb(benefit, kase, pages, locality, snaps),
        // odpowiedzi z brakami (errors) nie zamrażamy na 10 min — dociągnięte
        // w międzyczasie snapshoty muszą trafić do kolejnego zapytania
        (d) => d.errors.length === 0,
      ),
    );
  }

  // obwód zamknięty → mamy jakiekolwiek snapshoty → serwuj je (stare, ale dane)
  if (saved > 0 && nfzDown()) {
    return c.json({
      ...assembleFromDb(benefit, kase, getSnapshots(benefit, kase, locality)),
      stale: true,
    });
  }

  try {
    const data = await cached(
      `compare:${benefit}:${kase}:${pages}:${locality}`,
      TTL.queues,
      () => getCompare(benefit, kase, pages, locality),
      // żywa ścieżka też nie może mrozić odpowiedzi z błędami — padłe
      // województwa zostają dociągnięte przez następne zapytanie
      (d) => d.errors.length === 0,
    );
    // snapshot per województwo — następne zapytania lecą z bazy.
    // Województwa z błędem (429/sieć) pomijamy: pusty snapshot z 0 rekordów przetrwałby
    // w cache 24 h jako "świeży" i zamrażał dziurę w wynikach.
    const failed = new Set(data.errors.map((e) => e.code));
    for (const p of data.provinces) {
      if (!failed.has(p.code)) saveSnapshot(benefit, p.code, kase, p.total, p.records, locality);
    }
    // getCompare połyka błędy per województwo i nigdy nie rzuca — bez tej gałęzi
    // totalny pad NFZ wyglądał jak „0 placówek w całej Polsce" (HTTP 200), a catch
    // z fallbackiem na snapshoty i noteNfzError były nieosiągalne
    if (failed.size === 0) return c.json(data);
    if (failed.size >= PROVINCES.length) {
      // padły WSZYSTKIE: to awaria upstreamu, nie puste wyniki — zamknij obwód
      // (retry kolejnych zapytań za 45 s), a snapshoty serwuj ze znacznikiem stale
      noteNfzError(new Error(data.errors[0].message));
      if (saved > 0) {
        return c.json({
          ...assembleFromDb(benefit, kase, getSnapshots(benefit, kase, locality)),
          stale: true,
        });
      }
      return c.json(data);
    }
    // padła część: świeże wyniki zostają, padłe kody nadpisujemy danymi ze
    // snapshotu (analogia do assemblePartialFromDb) — z flagą stale na odpowiedzi
    const byCode = new Map(getSnapshots(benefit, kase, locality).map((s) => [s.code, s]));
    return c.json({
      ...data,
      provinces: data.provinces.map((p) => {
        const s = failed.has(p.code) ? byCode.get(p.code) : undefined;
        return s
          ? {
              code: p.code,
              name: p.name,
              total: s.total,
              records: (s.records as NfzRecord[]).map((r) => slimRecord(r)),
            }
          : p;
      }),
      stale: true,
    });
  } catch (err) {
    noteNfzError(err);
    // awaria NFZ, a snapshoty są (choć stare) → lepsze to niż ściana błędu
    if (saved > 0) {
      return c.json({
        ...assembleFromDb(benefit, kase, getSnapshots(benefit, kase, locality)),
        stale: true,
      });
    }
    throw err;
  }
});

// Pojedyncze województwo: baza (jeśli świeże) → NFZ. Do ładowania progresywnego.
// jeden search odpala do 16 takich zapytań (progresywne ładowanie województw) — limit szeroki
app.get('/api/queues-province', limit(90), async (c) => {
  const benefit = cut((c.req.query('benefit') ?? '').trim(), 120);
  const province = (c.req.query('province') ?? '').trim();
  const kase = c.req.query('case') === '2' ? 2 : 1;
  const pages = intParam(c.req.query('pages'), 2, 1, 4);
  // „KRAKOW" bez diakrytyków daje z NFZ 0 wyników — rozwiązujemy do kanonicznej nazwy
  const locality = canonicalLocality(cut((c.req.query('locality') ?? '').trim().toUpperCase(), 60));
  if (benefit.length < 3 || !PROVINCES.some((p) => p.code === province)) {
    return c.json({ error: 'benefit (min. 3 znaki) i poprawny kod province wymagane' }, 400);
  }

  const ttlH = Number(process.env.SNAPSHOT_TTL_H ?? 24);
  const snap = getSnapshotOne(benefit, province, kase, locality);
  const p = PROVINCES.find((x) => x.code === province)!;
  if (snap && (Date.now() - new Date(snap.fetchedAt).getTime()) / 3_600_000 <= ttlH) {
    return c.json({
      code: p.code,
      name: p.name,
      total: snap.total,
      records: snap.records as NfzRecord[],
      source: 'db',
    });
  }

  const stale = () =>
    snap
      ? {
          code: p.code,
          name: p.name,
          total: snap.total,
          records: snap.records as NfzRecord[],
          source: 'stale' as const,
          fetchedAt: snap.fetchedAt,
        }
      : null;

  // awaria NFZ: bez dotykania upstreamu serwuj przeterminowany snapshot
  if (nfzDown()) {
    const s = stale();
    if (s) return c.json(s);
  }

  try {
    const data = await cached(
      `province:${benefit}:${province}:${kase}:${pages}:${locality}`,
      TTL.queues,
      () => getProvinceQueues(benefit, province, kase, pages, locality),
    );
    saveSnapshot(benefit, province, kase, data.total, data.records, locality);
    return c.json({ ...data, source: 'nfz' });
  } catch (err) {
    noteNfzError(err);
    const s = stale();
    if (s) return c.json(s);
    throw err;
  }
});

// Placówki NFZ z „Gdzie się leczyć": apteki, SOR, izby przyjęć, nocna pomoc
app.get('/api/facilities', limit(30), async (c) => {
  const category = (c.req.query('category') ?? 'apteki') as GslCategory;
  const province = (c.req.query('province') ?? '').trim();
  const name = (c.req.query('name') ?? '').trim().slice(0, 80);
  // 68 = wewnętrzny limit GSL; niższy clamp psuł „Pokaż więcej" — żądanie str. 21
  // ścinało do 20 i frontend doklejał tę samą stronę drugi raz (duplikaty)
  const page = intParam(c.req.query('page'), 1, 1, 68);
  // Object.hasOwn, nie `in` — klucze prototypu ('toString', 'constructor')
  // przechodziły walidację i wywalały GSL_CATEGORIES[category].route na 502
  if (!Object.hasOwn(GSL_CATEGORIES, category)) {
    return c.json({ error: `category: ${Object.keys(GSL_CATEGORIES).join(' | ')}` }, 400);
  }
  if (!PROVINCES.some((p) => p.code === province)) {
    return c.json({ error: 'Podaj poprawny kod województwa' }, 400);
  }
  const nameKey = name.toLowerCase();
  try {
    const data = await cached(
      `gsl:${category}:${province}:${nameKey}:${page}`,
      60 * 60 * 1000,
      () => gslFacilities(category, province, name, page),
    );
    // ostatnia dobra strona ląduje w SQLite — przy awarii GSL serwujemy ją jako stale
    saveGslSnapshot(category, province, nameKey, data.page ?? page, data.total, data.results);
    return c.json(data);
  } catch (err) {
    const snap = getGslSnapshot(category, province, nameKey, page);
    if (snap) {
      return c.json({
        category,
        province,
        total: snap.total,
        results: snap.results,
        page,
        stale: true,
        fetchedAt: snap.fetchedAt,
      });
    }
    // Błąd upstream GSL NFZ (sesja/paginacja/Imperva) — 502, nie 500: problem leży
    // po stronie NFZ, nie w naszym kodzie. Frontend pokazuje retry bez kasowania listy.
    // Surowy message („The operation timed out", EN z fetch/Impervy) nie nadaje się
    // do UI — tłumaczymy na zrozumiały polski.
    console.error('[facilities]', category, province, page, err);
    return c.json(
      { error: 'Serwis NFZ „Gdzie się leczyć" nie odpowiada — spróbuj ponownie za chwilę.' },
      502,
    );
  }
});


// Autouzupełnianie miast dla widoku powietrza (z cache stacji, bez NFZ/GIOŚ w locie)
app.get('/api/air-stations', limit(20), async (c) => {
  const locality = cut((c.req.query('locality') ?? '').trim(), 60);
  if (locality.length < 3) return c.json({ items: [] });
  const { airStationsByLocality } = await import('./air');
  const items = await cached(`air-stations:${locality.toLowerCase()}`, 60 * 60 * 1000, () =>
    airStationsByLocality(locality),
  );
  return c.json({ items });
});

// Jakość powietrza GIOŚ — „czy dziś bezpieczny trening?"
app.get('/api/air', limit(20), async (c) => {
  const locality = cut((c.req.query('locality') ?? '').trim(), 60);
  const stationRaw = c.req.query('station');
  const stationId = stationRaw ? Number(stationRaw) : 0;
  // ?station=abc → czytelny 400 zamiast mylącego „Podaj miejscowość"
  if (stationRaw && !Number.isFinite(stationId)) {
    return c.json({ error: 'station: dodatnia liczba całkowita' }, 400);
  }
  const { airForLocality, airForStation } = await import('./air');
  if (stationId > 0) {
    // jak przy locality: nietrafione id stacji nie zatruwają cache'a na 30 min
    const data = await cached(
      `air:station:${stationId}`,
      30 * 60 * 1000,
      () => airForStation(stationId),
      (r) => r.station !== null,
    );
    return c.json(data);
  }
  if (locality.length < 3) {
    return c.json({ error: 'Podaj miejscowość (min. 3 znaki)' }, 400);
  }
  // trafienia cache'ujemy 30 min; nietrafione zapytania nie mogą zatruwać cache'a
  // (ani dowolny wpisany string nie może na pół godziny zamrażać odpowiedzi).
  // Wartościowa odpowiedź = stacja GIOŚ LUB jakiekolwiek czujniki w okolicy.
  const data = await cached(
    `air:locality:${locality.toLowerCase()}`,
    30 * 60 * 1000,
    () => airForLocality(locality),
    (r) => r.station !== null || r.community !== null || r.airly !== null,
  );
  return c.json(data);
});

// Trend kolejki — historia dzienna budowana przy każdym zapisie snapshotu
app.get('/api/trend', async (c) => {
  const benefit = cut((c.req.query('benefit') ?? '').trim(), 120);
  const kase = c.req.query('case') === '2' ? 2 : 1;
  // kanonizacja jak w /api/compare i /api/queues-province — snapshoty/historia
  // zapisują się pod zkanonizowaną nazwą, więc surowa fraza dałaby pusty trend
  // obok żywych wyników
  const locality = canonicalLocality(cut((c.req.query('locality') ?? '').trim().toUpperCase(), 60));
  if (benefit.length < 3) return c.json({ error: 'benefit: min. 3 znaki' }, 400);
  const data = await cached(`trend:${benefit}:${kase}:${locality}`, 10 * 60 * 1000, async () => {
    const points = queueTrend(benefit, kase, locality);
    const first = points[0];
    const last = points[points.length - 1];
    const deltaTotal = first && last && points.length > 1 ? last.total - first.total : null;
    return {
      points,
      from: first?.day ?? null,
      to: last?.day ?? null,
      deltaTotal,
      deltaPct: deltaTotal !== null && first!.total > 0 ? Math.round((deltaTotal / first!.total) * 100) : null,
    };
  });
  return c.json(data);
});

// Raport ogólnopolski (agregaty z lokalnej bazy snapshotów)
app.get('/api/insights', (c) => {
  const raw = getSyncState('insights');
  if (!raw) {
    return c.json(
      { status: 'empty', hint: 'Uruchom synchronizację: POST /api/sync/trigger?scope=queues' },
      202,
    );
  }
  return c.json(JSON.parse(raw) as object);
});

/** Sanitizacja rekordu z body — surowe obiekty z sieci nie mogą wywalić promptu (flags: undefined → TypeError → 500). */
function cleanRecord(r: unknown): CompactRecord {
  const o = (r ?? {}) as Record<string, unknown>;
  const f = (o['flags'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    provider: String(o['provider'] ?? '').slice(0, 200),
    locality: String(o['locality'] ?? '').slice(0, 120),
    address: String(o['address'] ?? '').slice(0, 200),
    benefit: String(o['benefit'] ?? '').slice(0, 120),
    days: num(o['days']),
    awaiting: num(o['awaiting']),
    phone: String(o['phone'] ?? '').slice(0, 40),
    flags: {
      ramp: !!f['ramp'],
      elevator: !!f['elevator'],
      toilet: !!f['toilet'],
      wheelchairs: !!f['wheelchairs'],
      ac: !!f['ac'],
      automaticDoor: !!f['automaticDoor'],
      bus: !!f['bus'],
      forChildren: !!f['forChildren'],
    },
  };
}

// Doradca AI (Groq/OpenRouter z lokalnym fallbackiem)
app.post('/api/ai', limit(10), async (c) => {
  const body = (await c.req.json<AiRequest>().catch(() => null)) as AiRequest | null;
  if (!body?.benefit || !Array.isArray(body.results)) {
    return c.json({ error: 'Oczekiwano JSON: { benefit, results, question? }' }, 400);
  }
  // twardy limit tego, co wpada do promptu — userPrompt i tak bierze slice(0,12)
  const req: AiRequest = {
    benefit: String(body.benefit).slice(0, 120),
    question: typeof body.question === 'string' ? body.question.slice(0, 500) : undefined,
    results: body.results
      .filter((r) => r !== null && typeof r === 'object')
      .slice(0, 20)
      .map(cleanRecord),
    kase: body.kase === 2 ? 2 : 1,
  };
  return c.json(await advise(req));
});

// Geokodowanie batch (Nominatim + cache SQLite)
app.post('/api/geocode', limit(10), async (c) => {
  const { geocodeBatch } = await import('./geocode');
  const body = (await c.req.json<{ addresses?: string[] }>().catch(() => null)) ?? null;
  const addresses = Array.isArray(body?.addresses)
    ? body.addresses.filter((a) => typeof a === 'string').map((a) => a.trim().slice(0, 200)).filter(Boolean)
    : [];
  if (addresses.length === 0 || addresses.length > 20) {
    return c.json({ error: 'addresses: 1–20 adresów' }, 400);
  }
  const results = await geocodeBatch(addresses);
  return c.json({ results });
});

// Ręczny rebuild indeksu wyszukiwania z lokalnej bazy (bez dotykania NFZ).
// Operacja serwisowa — gdy ustawiono SYNC_TOKEN, wymagaj go jak przy synchronizacji.
app.post('/api/search/reindex', async (c) => {
  const token = process.env.SYNC_TOKEN;
  if (token && c.req.query('token') !== token) {
    return c.json({ error: 'Nieprawidłowy token' }, 401);
  }
  const { allBenefits } = await import('./db');
  const { purgeKeys } = await import('./cache');
  const names = allBenefits();
  const purged = await purgeKeys('search:');
  await reindexBenefits(names);
  return c.json({ indexed: names.length, purgedCacheKeys: purged });
});

// Synchronizacja (scraper)
app.get('/api/sync/status', (c) => c.json(getSyncStatus()));
app.post('/api/sync/trigger', limit(5), async (c) => {
  // opcjonalna ochrona: ustaw SYNC_TOKEN, by obcy nie odpalali synchronizacji
  const token = process.env.SYNC_TOKEN;
  if (token && c.req.query('token') !== token) {
    return c.json({ error: 'Nieprawidłowy token' }, 401);
  }
  const body = (await c.req.json<{ scope?: string }>().catch(() => null)) ?? null;
  const raw = body?.scope ?? c.req.query('scope') ?? 'all';
  const scope: 'benefits' | 'queues' | 'all' =
    raw === 'benefits' || raw === 'queues' || raw === 'all' ? raw : 'all';
  if (raw !== scope) {
    return c.json({ error: 'scope: benefits | queues | all' }, 400);
  }
  const started = triggerSync(scope);
  return c.json({ started, status: getSyncStatus() }, started ? 202 : 409);
});

const port = Number(process.env.PORT ?? 2363);

console.log(`▶ zdrowapolska-backend nasłuchuje na 0.0.0.0:${port}`);
startSyncScheduler();
// Prewarm listy stacji GIOŚ w tle (~20 stron z pacingiem) — pierwsze wejście
// w zakładkę „Powietrze" nie czeka ~30 s na zimny cache
void import('./air')
  .then((m) => m.allStations())
  .catch(() => undefined);

export default {
  port,
  hostname: '0.0.0.0',
  // zimne porównanie 16 województw (z backoffem 429 NFZ) potrafi zająć ~20 s,
  // a domyślny idleTimeout Bun zamyka bezczynne połączenia po 10 s
  idleTimeout: 255,
  fetch: app.fetch,
};
