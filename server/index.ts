import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
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
import { advise, type AiRequest } from './ai';
import {
  getSnapshotOne,
  getSnapshots,
  saveSnapshot,
  snapshotAgeHours,
  snapshotProvinces,
  dbStats,
  getSyncState,
} from './db';
import { searchBenefits, reindexBenefits } from './search';
import { getSyncStatus, startSyncScheduler, triggerSync } from './sync';
import { GSL_CATEGORIES, gslFacilities, type GslCategory } from './gsl';

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
  } else if (path.startsWith('/api/compare') || path.startsWith('/api/localities') || path.startsWith('/api/benefits')) {
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

app.get('/api/health', (c) =>
  c.json({ ok: true, service: 'zdrowapolska-backend', cache: cacheStats(), db: dbStats() }),
);

// Wyszukiwarka świadczeń (Meilisearch z synonimami i literówkami; fallbacki: SQLite → NFZ)
app.get('/api/search', async (c) => {
  const q = cut((c.req.query('q') ?? c.req.query('name') ?? '').trim(), 80);
  const limit = intParam(c.req.query('limit'), 25, 1, 25);
  if (q.length < 3) return c.json({ items: [], count: 0, source: 'meilisearch' });
  const res = await cached(`search:${q.toLowerCase()}:${limit}`, 10 * 60 * 1000, () =>
    searchBenefits(q, limit),
  );
  return c.json({ items: res.items, count: res.items.length, source: res.source });
});

// Kompatybilność ze starym kształtem (słownik po fragmencie)
app.get('/api/benefits', async (c) => {
  const name = cut((c.req.query('name') ?? '').trim(), 80);
  if (name.length < 3) return c.json({ items: [], count: 0 });
  const res = await cached(`search:${name.toLowerCase()}:25`, TTL.dictionaries, () =>
    searchBenefits(name, 25),
  );
  return c.json({ items: res.items, count: res.items.length });
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

// Autouzupełnianie miejscowości (jak „Gdzie się leczyć" NFZ)
app.get('/api/localities', async (c) => {
  const name = cut((c.req.query('name') ?? '').trim(), 60);
  if (name.length < 3) return c.json({ items: [] });
  const items = await cached(`localities:${name.toLowerCase()}`, TTL.dictionaries, () =>
    getLocalities(name),
  );
  return c.json({ items });
});

// Porównanie 16 województw: najpierw świeży snapshot z SQLite (natychmiast),
// w przeciwnym razie żywe pobranie z NFZ (+ zapis snapshotu na przyszłość).
app.get('/api/compare', async (c) => {
  const benefit = cut((c.req.query('benefit') ?? '').trim(), 120);
  const kase = c.req.query('case') === '2' ? 2 : 1;
  const pages = intParam(c.req.query('pages'), 2, 1, 4);
  const locality = cut((c.req.query('locality') ?? '').trim().toUpperCase(), 60);
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
    return c.json(
      await cached(dbKey, TTL.dbCompare, async () =>
        assemblePartialFromDb(benefit, kase, pages, locality, snaps),
      ),
    );
  }

  const data = await cached(`compare:${benefit}:${kase}:${pages}:${locality}`, TTL.queues, () =>
    getCompare(benefit, kase, pages, locality),
  );
  // snapshot per województwo — następne zapytania lecą z bazy.
  // Województwa z błędem (429/sieć) pomijamy: pusty snapshot z 0 rekordów przetrwałby
  // w cache 24 h jako "świeży" i zamrażał dziurę w wynikach.
  const failed = new Set(data.errors.map((e) => e.code));
  for (const p of data.provinces) {
    if (!failed.has(p.code)) saveSnapshot(benefit, p.code, kase, p.total, p.records, locality);
  }
  return c.json(data);
});

// Pojedyncze województwo: baza (jeśli świeże) → NFZ. Do ładowania progresywnego.
app.get('/api/queues-province', async (c) => {
  const benefit = cut((c.req.query('benefit') ?? '').trim(), 120);
  const province = (c.req.query('province') ?? '').trim();
  const kase = c.req.query('case') === '2' ? 2 : 1;
  const pages = intParam(c.req.query('pages'), 2, 1, 4);
  const locality = cut((c.req.query('locality') ?? '').trim().toUpperCase(), 60);
  if (benefit.length < 3 || !PROVINCES.some((p) => p.code === province)) {
    return c.json({ error: 'benefit (min. 3 znaki) i poprawny kod province wymagane' }, 400);
  }

  const ttlH = Number(process.env.SNAPSHOT_TTL_H ?? 24);
  const snap = getSnapshotOne(benefit, province, kase, locality);
  if (snap && (Date.now() - new Date(snap.fetchedAt).getTime()) / 3_600_000 <= ttlH) {
    const p = PROVINCES.find((x) => x.code === province)!;
    return c.json({
      code: p.code,
      name: p.name,
      total: snap.total,
      records: snap.records as NfzRecord[],
      source: 'db',
    });
  }

  const data = await cached(
    `province:${benefit}:${province}:${kase}:${pages}:${locality}`,
    TTL.queues,
    () => getProvinceQueues(benefit, province, kase, pages, locality),
  );
  saveSnapshot(benefit, province, kase, data.total, data.records, locality);
  return c.json({ ...data, source: 'nfz' });
});

// Placówki NFZ z „Gdzie się leczyć": apteki, SOR, izby przyjęć, nocna pomoc
app.get('/api/facilities', async (c) => {
  const category = (c.req.query('category') ?? 'apteki') as GslCategory;
  const province = (c.req.query('province') ?? '').trim();
  const name = (c.req.query('name') ?? '').trim().slice(0, 80);
  const page = intParam(c.req.query('page'), 1, 1, 20);
  if (!(category in GSL_CATEGORIES)) {
    return c.json({ error: `category: ${Object.keys(GSL_CATEGORIES).join(' | ')}` }, 400);
  }
  if (!PROVINCES.some((p) => p.code === province)) {
    return c.json({ error: 'Podaj poprawny kod województwa' }, 400);
  }
  try {
    const data = await cached(
      `gsl:${category}:${province}:${name.toLowerCase()}:${page}`,
      60 * 60 * 1000,
      () => gslFacilities(category, province, name, page),
    );
    return c.json(data);
  } catch (err) {
    // Błąd upstream GSL NFZ (sesja/paginacja/Imperva) — 502, nie 500: problem leży
    // po stronie NFZ, nie w naszym kodzie. Frontend pokazuje retry bez kasowania listy.
    console.error('[facilities]', category, province, page, err);
    return c.json({ error: err instanceof Error ? err.message : 'NFZ chwilowo niedostępny' }, 502);
  }
});


// Autouzupełnianie miast dla widoku powietrza (z cache stacji, bez NFZ/GIOŚ w locie)
app.get('/api/air-stations', async (c) => {
  const locality = cut((c.req.query('locality') ?? '').trim(), 60);
  if (locality.length < 3) return c.json({ items: [] });
  const { airStationsByLocality } = await import('./air');
  const items = await cached(`air-stations:${locality.toLowerCase()}`, 60 * 60 * 1000, () =>
    airStationsByLocality(locality),
  );
  return c.json({ items });
});

// Jakość powietrza GIOŚ — „czy dziś bezpieczny trening?"
app.get('/api/air', async (c) => {
  const locality = cut((c.req.query('locality') ?? '').trim(), 60);
  const stationId = Number(c.req.query('station') ?? 0);
  const { airForLocality, airForStation } = await import('./air');
  if (stationId > 0) {
    const data = await cached(`air:station:${stationId}`, 30 * 60 * 1000, () => airForStation(stationId));
    return c.json(data);
  }
  if (locality.length < 3) {
    return c.json({ error: 'Podaj miejscowość (min. 3 znaki)' }, 400);
  }
  // bez cached(): puste wyniki dla nietrafionych zapytań nie mogą zatruwać cache'a
  const data = await airForLocality(locality);
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

// Doradca AI (Groq/OpenRouter z lokalnym fallbackiem)
app.post('/api/ai', async (c) => {
  const body = (await c.req.json<AiRequest>().catch(() => null)) as AiRequest | null;
  if (!body?.benefit || !Array.isArray(body.results)) {
    return c.json({ error: 'Oczekiwano JSON: { benefit, results, question? }' }, 400);
  }
  // twardy limit tego, co wpada do promptu — userPrompt i tak bierze slice(0,12)
  const req: AiRequest = {
    benefit: String(body.benefit).slice(0, 120),
    question: typeof body.question === 'string' ? body.question.slice(0, 500) : undefined,
    results: body.results.slice(0, 20),
  };
  return c.json(await advise(req));
});

// Geokodowanie batch (Nominatim + cache SQLite)
app.post('/api/geocode', async (c) => {
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
app.post('/api/sync/trigger', async (c) => {
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

export default {
  port,
  hostname: '0.0.0.0',
  // zimne porównanie 16 województw (z backoffem 429 NFZ) potrafi zająć ~20 s,
  // a domyślny idleTimeout Bun zamyka bezczynne połączenia po 10 s
  idleTimeout: 255,
  fetch: app.fetch,
};
