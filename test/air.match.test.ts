import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// izolacja jak w regression.test.ts:7-11 — świeża baza, bez Redisa/Meili
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'zp-airmatch-')), 'test.sqlite');
delete process.env.REDIS_URL;
delete process.env.MEILI_URL;
// airly 'off' w tych testach (status deterministyczny, zero sieci)
delete process.env.AIRLY_API_KEY;

const { distKm, allStations, airForLocality, airForStation, airStationsByLocality, communityAirNear, adviceFor } =
  await import('../server/air');
const { geocodeBatch, geocodeBatchWithStatus } = await import('../server/geocode');
const { purgeKeys } = await import('../server/cache');

// --- Fiksy stacji GIOŚ (kształt 1:1 z API, patrz toStation w server/air.ts) -----

const BUSKO = { id: 756, name: 'Busko-Zdrój, ul. Ożarów', city: 'Busko-Zdrój', lat: 50.4539, lon: 20.5844 };
const SOLEC = { id: 20568, name: 'Solec-Zdrój, ul. Buska', city: 'Solec-Zdrój', lat: 50.4014, lon: 20.6453 };
const KRAKOW = { id: 400, name: 'Kraków, Aleja Krasińskiego', city: 'Kraków', lat: 50.0647, lon: 19.945 };
const KRAKOW2 = { id: 401, name: 'Kraków, ul. Wielicka', city: 'Kraków', lat: 50.0602, lon: 19.9373 };
// historyczna regresja: „Kraków” łapało Piotrków przez „ul. Krakowskie Przedmieście”
const PIOTRKOW = {
  id: 322,
  name: 'Piotrków Trybunalski, ul. Krakowskie Przedmieście',
  city: 'Piotrków Trybunalski',
  lat: 51.4053,
  lon: 19.7031,
};

const FIXTURES = [BUSKO, SOLEC, KRAKOW, KRAKOW2, PIOTRKOW];

const rawStation = (s: (typeof FIXTURES)[number]) => ({
  'Identyfikator stacji': s.id,
  'Kod stacji': `St${s.id}`,
  'Nazwa stacji': s.name,
  'Nazwa miasta': s.city,
  'Ulica': null,
  'WGS84 φ N': String(s.lat),
  'WGS84 λ E': String(s.lon),
});

// indeksy: 756 = stacja manualna (CAŁY obiekt null — jak aqindex/getIndex/756 na produkcji)
const idxNull = {
  'Nazwa kategorii indeksu': null,
  'Wartość indeksu': null,
  'Data wykonania obliczeń indeksu': null,
  'Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st': null,
};
const idx = (kat: string) => ({
  ...idxNull,
  'Nazwa kategorii indeksu': kat,
  'Nazwa kategorii indeksu dla wskażnika PM10': kat,
  'Wartość indeksu dla wskaźnika PM10': 2,
});
const INDEXES: Record<number, Record<string, unknown>> = {
  [BUSKO.id]: idxNull,
  [SOLEC.id]: idx('Dobry'),
  [KRAKOW.id]: idx('Umiarkowany'),
  [KRAKOW2.id]: idx('Dobry'),
  [PIOTRKOW.id]: idx('Dobry'),
};

// --- Stub globalThis.fetch — zero prawdziwej sieci ------------------------------

const realFetch = globalThis.fetch;
const indexCalls: number[] = [];
const scCalls: string[] = [];
const poisonedIds = new Set<number>(); // id stacji, których aqindex zwraca 503 (awaria GIOŚ)
const once429Ids = new Set<number>(); // d7: id z „429 raz” — pierwsze wywołanie zwraca 429, kolejne 200 (reset per-test!)
let scByRadius: Record<number, unknown> = {}; // odpowiedź SC per promień (brak wpisu = [])
let nominatimStatus = 503;
let photonStatus = 503;
let photonBody: unknown = { features: [] };

function installFetchStub(): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const json = (o: unknown) =>
      new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/station/findAll')) {
      return json({ 'Lista stacji pomiarowych': FIXTURES.map(rawStation), totalPages: 1 });
    }
    const m = url.match(/aqindex\/getIndex\/(\d+)/);
    if (m) {
      const id = Number(m[1]);
      indexCalls.push(id);
      if (poisonedIds.has(id)) return new Response('stub: GIOŚ 503 dla indeksu', { status: 503 });
      // d7: „429 raz” — zużywamy flagę (wypisujemy id), więc kolejne wywołanie tego
      // samego id dostaje już 200; retry w giosJson honoruje Retry-After
      if (once429Ids.has(id)) {
        once429Ids.delete(id);
        return new Response('stub: GIOŚ 429 dla indeksu', { status: 429, headers: { 'Retry-After': '1' } });
      }
      return json({ AqIndex: INDEXES[id] ?? idxNull });
    }
    if (url.includes('data.sensor.community')) {
      scCalls.push(url);
      const radius = Number(url.match(/area=[\d.]+,[\d.]+,(\d+)/)?.[1] ?? 0);
      return json(scByRadius[radius] ?? []);
    }
    if (url.includes('nominatim.openstreetmap.org')) {
      if (nominatimStatus !== 200) return new Response('stub: nominatim down', { status: nominatimStatus });
      return json([{ lat: '52.0', lon: '21.0', importance: 0.6 }]);
    }
    if (url.includes('photon.komoot.io')) {
      if (photonStatus !== 200) return new Response('stub: photon down', { status: photonStatus });
      return json(photonBody);
    }
    return new Response(`stub: nieoczekiwany URL: ${url}`, { status: 404 });
  }) as typeof fetch;
}

/** Oczekiwany dystans liczony TĄ SAMĄ formułą co serwer (distKm), nie hardkod. */
const expectedKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.round(distKm(a.lat, a.lon, b.lat, b.lon) * 10) / 10;

beforeAll(async () => {
  installFetchStub();
  await allStations(); // seed listy stacji przez stub (totalPages=1 — jeden fetch)
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('airStationsByLocality — ranking r3 na fiksach', () => {
  test('„Kraków”: miasto przed nazwą — 400 pierwszy, Piotrków („ul. Krakowskie…”) poza listą', async () => {
    const items = await airStationsByLocality('Kraków');
    expect(items[0].id).toBe(KRAKOW.id);
    expect(items.map((i) => i.id)).toContain(KRAKOW2.id);
    expect(items.map((i) => i.id)).not.toContain(PIOTRKOW.id);
    expect(items.every((i) => i.city === 'Kraków')).toBe(true);
  });

  test('tie-break alfabetyczny w obrębie miasta (localeCompare pl)', async () => {
    const items = await airStationsByLocality('Kraków');
    expect(items.map((i) => i.id)).toEqual([KRAKOW.id, KRAKOW2.id]); // „Aleja…” < „ul…”
  });

  test('ochrona pustych/krótkich fraz — nic nie dopasowuje się przez includes("")', async () => {
    expect(await airStationsByLocality('!!')).toEqual([]);
    expect(await airStationsByLocality('   ')).toEqual([]);
    expect(await airStationsByLocality('!!!')).toEqual([]);
  });
});

describe('airForLocality — geo-fallback i „najbliższa z żywym indeksem”', () => {
  test('Busko-Zdrój: stacja 756 bez indeksu → podmiana na Solec 20568 z dystansem z distKm', async () => {
    scByRadius = {}; // czujniki: sprawdzone i pusto (jak Busko na produkcji)
    const res = await airForLocality('Busko-Zdrój');
    expect(res.station?.id).toBe(SOLEC.id);
    expect(res.station?.city).toBe('Solec-Zdrój');
    expect(res.kategoria).toBe('Dobry');
    // dystans liczony ze współrzędnych fiksu — nie hardkod
    expect(res.distanceKm).toBe(expectedKm(BUSKO, SOLEC));
    // alternatives wzbogacone: 400 (z indeksem, ~63 km) przed gołym dopasowaniem 756
    expect(res.alternatives[0].id).toBe(KRAKOW.id);
    expect(res.alternatives[0].kategoria).toBe('Umiarkowany');
    expect(res.alternatives[0].distanceKm).toBe(expectedKm(BUSKO, KRAKOW));
    const buskoAlt = res.alternatives.find((a) => a.id === BUSKO.id);
    expect(buskoAlt?.kategoria ?? null).toBeNull();
    // statusy: gios lista pobrana, czujniki sprawdzone i pusto, airly off (brak klucza)
    expect(res.sources).toEqual({ gios: 'ok', community: 'empty', airly: 'off' });
    // d3: podmieniono MIEJSCOWĄ stację manualną (kandydat z dopasowania po mieście)
    expect(res.miejscowaStacjaManualna).toBe(true);
  });

  test('podpowiedzi z adnotacją „brak na żywo”: 756 memoizowany po sondowaniu, 400 bez odznaki (d3)', async () => {
    // zależne od kolejności: memo stacjeManualne wypełnia dopiero test wyżej (756 bez indeksu)
    const busko = await airStationsByLocality('Busko');
    expect(busko[0]?.id).toBe(BUSKO.id);
    expect(busko[0]?.brakNaZywo).toBe(true);
    const krk = await airStationsByLocality('Kraków');
    expect(krk.every((i) => !i.brakNaZywo)).toBe(true);
  });

  test('Kraków: happy path r3 — dokładnie JEDNO sondowanie indeksu (400), bez fallbacku', async () => {
    indexCalls.length = 0;
    const res = await airForLocality('Kraków');
    expect(res.station?.id).toBe(KRAKOW.id);
    expect(res.distanceKm).toBeNull(); // dopasowanie po mieście — bez dystansu
    expect(indexCalls).toEqual([KRAKOW.id]); // pętla przerwana na pierwszym z indeksem
    expect(res.geoError).toBe(false);
  });

  test('miejscowość bez stacji + oba geokodery padły → geoError z uczciwym komunikatem', async () => {
    nominatimStatus = 503;
    photonStatus = 503;
    const res = await airForLocality('Zwariowana Wioska Testowa 42');
    expect(res.station).toBeNull();
    expect(res.geoError).toBe(true);
    expect(res.advice).toBe('Geokodowanie chwilowo niedostępne — spróbuj za chwilę.');
  }, 20_000);
});

describe('airForStation — fallback stacji manualnej (?station=756)', () => {
  test('756 bez indeksu i bez czujników → odpowiedź ze Solecem i realnym dystansem', async () => {
    scByRadius = {};
    const res = await airForStation(BUSKO.id);
    expect(res.station?.id).toBe(SOLEC.id);
    expect(res.distanceKm).toBe(expectedKm(BUSKO, SOLEC));
    expect(res.kategoria).toBe('Dobry');
    expect(res.pollutants.map((p) => p.wskaznik)).toEqual(['PM10']);
    expect(res.sources.gios).toBe('ok');
    // d2: alternatives — żywi sąsiedzi z sondowań, sortowani dystansem (400 przed 401)
    expect(res.alternatives.map((a) => a.id)).toEqual([KRAKOW.id, KRAKOW2.id]);
    expect(res.alternatives[0]).toMatchObject({
      kategoria: 'Umiarkowany',
      distanceKm: expectedKm(BUSKO, KRAKOW),
    });
    // po podmianie pierwotna stacja manualna NIE wraca jako klikalna alternatywa
    expect(res.alternatives.some((a) => a.id === BUSKO.id)).toBe(false);
  });

  test('stacja z żywym indeksem NIE jest podmieniana (400 zostaje 400)', async () => {
    indexCalls.length = 0;
    const res = await airForStation(KRAKOW.id);
    expect(res.station?.id).toBe(KRAKOW.id);
    expect(res.distanceKm).toBe(0);
    expect(res.kategoria).toBe('Umiarkowany');
    expect(indexCalls).toEqual([KRAKOW.id]); // brak sondowania sąsiadów
    // d2: bez fallbacku alternatives to pozostali pobliscy (≤80 km) wg dystansu:
    // 401 (~0,7 km), potem Solec (~62,4 km) i 756 (~62,8 km); Piotrków (~150 km)
    // poza limitem. Solec z indeksem? Nie — w tej ścieżce nie sondowano go, więc
    // kategoria null (żywe kategorie trafiają do alternatives tylko z sondowań).
    expect(res.alternatives.map((a) => a.id)).toEqual([KRAKOW2.id, SOLEC.id, BUSKO.id]);
    expect(res.alternatives[0]?.kategoria).toBeNull(); // indeksu 401 nie sondowano
    expect(res.alternatives[0]?.distanceKm).toBe(expectedKm(KRAKOW, KRAKOW2));
  });
});

describe('fallback odporny na przejściową awarię GIOŚ (fix recenzji: strict 502 tylko dla primary)', () => {
  test('airForLocality: 503 na pierwszym sąsiedzie (Solec) → próbuje kolejnego (Kraków), odpowiedź nie pada', async () => {
    scByRadius = {};
    poisonedIds.add(SOLEC.id);
    try {
      const res = await airForLocality('Busko-Zdrój');
      // Solec zwrócił 503 → tolerancyjnie {} → scan próbuje Krakowa zamiast odrzucać
      expect(res.station?.id).toBe(KRAKOW.id);
      expect(res.kategoria).toBe('Umiarkowany');
      expect(res.distanceKm).toBe(expectedKm(BUSKO, KRAKOW));
    } finally {
      poisonedIds.delete(SOLEC.id);
    }
  }, 20_000); // odzysk przechodzi przez realny backoff GIOŚ (2 s + 4 s) — przekracza domyślne 5 s

  test('airForStation: 503 na sąsiedzie nie odrzuca złożonej odpowiedzi (?station=756)', async () => {
    scByRadius = {};
    poisonedIds.add(SOLEC.id);
    try {
      const res = await airForStation(BUSKO.id);
      expect(res.station?.id).toBe(KRAKOW.id);
      expect(res.distanceKm).toBe(expectedKm(BUSKO, KRAKOW));
      expect(res.kategoria).toBe('Umiarkowany');
    } finally {
      poisonedIds.delete(SOLEC.id);
    }
  }, 20_000); // jw. — backoff GIOŚ w ścieżce odzysku
});

describe('giosJson honoruje Retry-After przy 429 (d7)', () => {
  test('pierwsze sondowanie 400 → 429 z Retry-After: 1, ponowne podejście → „Umiarkowany”', async () => {
    indexCalls.length = 0;
    once429Ids.add(KRAKOW.id);
    try {
      const res = await airForLocality('Kraków');
      expect(res.station?.id).toBe(KRAKOW.id);
      expect(res.kategoria).toBe('Umiarkowany');
      // 429 → czekaj wg Retry-After (1 s, wewnątrz semafora) → retry → 200
      expect(indexCalls).toEqual([KRAKOW.id, KRAKOW.id]);
      expect(res.sources.gios).toBe('ok');
    } finally {
      // flaga per-test: 400 bywa sondowany w testach wyżej — skumulowana flaga
      // zużyłaby 429 za wcześnie i przewróciła cudze asercje
      once429Ids.clear();
    }
  }, 20_000); // realnie ~3 s: sleep 1 s z Retry-After + backoff 2 s
});

describe('communityAirNear — adaptacyjny promień i agregacja po dokładnym punkcie', () => {
  const scRow = (id: number, lat: number, lon: number, p1: number, p2: number, ageH = 1) => ({
    sensor: { id },
    sensordatavalues: [
      { value_type: 'P1', value: String(p1) },
      { value_type: 'P2', value: String(p2) },
    ],
    location: { latitude: String(lat), longitude: String(lon) },
    timestamp: new Date(Date.now() - ageH * 3_600_000).toISOString(),
  });

  test('czujniki w 12 km: radiusKm=12, nearestKm wg DOKŁADNEGO punktu, mediana i kategoria', async () => {
    scByRadius = { 12: [scRow(1, 54.39, 18.59, 20, 12), scRow(2, 54.42, 18.64, 90, 40)] };
    const point = { lat: 54.4, lon: 18.6 }; // Trójmiasto — świeża komórka cache (bez kolizji)
    const res = await communityAirNear(point.lat, point.lon);
    expect(res?.radiusKm).toBe(12);
    expect(res?.count).toBe(2);
    // najbliższy = czujnik 1 (~1,3 km) — dystans od punktu ZAPYTANIA, nie od komórki
    expect(res?.nearestKm).toBe(expectedKm(point, { lat: 54.39, lon: 18.59 }));
    // mediana PM10 (20,90) = 55 → „Umiarkowany”
    expect(res?.kategoria).toBe('Umiarkowany');
  });

  test('eskalacja 12→25→50 km, gdy mniejsze promienie są puste', async () => {
    const rows = [scRow(5, 53.42, 14.55, 20, 12)];
    scByRadius = { 12: [], 25: [], 50: rows };
    scCalls.length = 0;
    const point = { lat: 53.43, lon: 14.55 }; // Szczecin — świeża komórka
    const res = await communityAirNear(point.lat, point.lon);
    expect(res?.radiusKm).toBe(50);
    expect(res?.count).toBe(1);
    const radii = scCalls.map((u) => Number(u.match(/area=[\d.]+,[\d.]+,(\d+)/)?.[1]));
    expect(radii).toEqual([12, 25, 50]); // faktyczna sekwencja eskalacji
  });

  test('limit wieku: czujnik ze stampem >24 h nie wchodzi do agregacji', async () => {
    scByRadius = {
      12: [scRow(7, 51.77, 19.46, 20, 12, 1), scRow(8, 51.78, 19.47, 200, 150, 30)],
    };
    const point = { lat: 51.76, lon: 19.46 }; // Łódź — świeża komórka
    const res = await communityAirNear(point.lat, point.lon);
    expect(res?.count).toBe(1); // stary czujnik (30 h) odfiltrowany
    expect(res?.nearestKm).toBe(expectedKm(point, { lat: 51.77, lon: 19.46 }));
  });

  test('pusto na wszystkich promieniach → null (status „empty”, nie error)', async () => {
    scByRadius = {};
    const point = { lat: 54.52, lon: 18.54 }; // Gdynia — świeża komórka
    expect(await communityAirNear(point.lat, point.lon)).toBeNull();
  });
});

describe('geocode — rozróżnienie błędu od missu + zapasowy Photon', () => {
  test('Nominatim padł → Photon ratuje geokodowanie (bez klucza, ten sam cache SQLite)', async () => {
    nominatimStatus = 503;
    photonStatus = 200;
    photonBody = { features: [{ geometry: { coordinates: [19.5, 51.1] }, properties: { country: 'Polska' } }] };
    const res = await geocodeBatchWithStatus(['Photonowa Wioska 7']);
    expect(res.error).toBe(false);
    expect(res.results[0]).toEqual({ address: 'Photonowa Wioska 7', lat: 51.1, lon: 19.5 });
    // stary kształt API dalej działa (wyniki bez statusu)
    expect(await geocodeBatch(['Photonowa Wioska 7'])).toHaveLength(1);
  }, 20_000);

  test('oba providery padły → error=true, wynik null i BEZ zapisu 30-dniowego missu', async () => {
    nominatimStatus = 503;
    photonStatus = 503;
    const res = await geocodeBatchWithStatus(['Padla Wioska 13']);
    expect(res.error).toBe(true);
    expect(res.results[0]).toBeNull();
    // drugie podejście znowu pyta (błąd nie został zapisany jako miss)
    const again = await geocodeBatchWithStatus(['Padla Wioska 13']);
    expect(again.error).toBe(true);
  }, 20_000);
});

// --- d1/d4: bramka dystansu czujników i pigułka kategorii ze źródłem --------------
// WAŻNE: puste komórki airsc:50.5:20.6:{12,25,50} z testów Buska wyżej siedzą 2 min
// w pamięci procesu (negativeTtl scRowsNear) — dlatego każdy test poniżej zaczyna
// się od purgeKeys('airsc') (czyści pamięć i Redis), by stub SC był realnie odpytany.
// Umiejscowienie na KOŃCU pliku chroni testy „odpornych na awarię” wyżej przed
// odwrotnym zatruciem (one ustawiają scByRadius={}, ale czytają z pamięci).

const scSensor = (id: number, lat: number, lon: number, p1: number, p2: number) => ({
  sensor: { id },
  sensordatavalues: [
    { value_type: 'P1', value: String(p1) },
    { value_type: 'P2', value: String(p2) },
  ],
  location: { latitude: String(lat), longitude: String(lon) },
  timestamp: new Date().toISOString(),
});
// ~46 km od Buska — poza COMMUNITY_LOCAL_KM (12), w zasięgu eskalacji 50 km;
// PM10 20 / PM2.5 12 → kategoria „Dobry” (scena produkcyjna Buska: czujniki daleko)
const DALEKI_CZUJNIK = scSensor(900, 50.87, 20.58, 20, 12);
// ~6,7 km od Buska — lokalny: jego kategoria słusznie tłumi fallback
const LOKALNY_CZUJNIK = scSensor(901, 50.51, 20.62, 20, 12);

describe('bramka dystansu czujników w fallbacku (d1) — kategoria z ≥12 km nie blokuje', () => {
  test('czujnik ~46 km z kategorią: fallback podmienia 756 na Solec 20568 („Dobry”)', async () => {
    await purgeKeys('airsc');
    scByRadius = { 50: [DALEKI_CZUJNIK] };
    const res = await airForLocality('Busko-Zdrój');
    // szacunek JEST, ale z czujnika spoza progu lokalności — nie blokuje podmiany
    expect(res.community?.kategoria).not.toBeNull();
    expect(res.community?.nearestKm ?? 0).toBeGreaterThan(12);
    expect(res.station?.id).toBe(SOLEC.id);
    expect(res.kategoria).toBe('Dobry');
    expect(res.zrodloKategorii).toBe('gios');
    // podmieniono miejscową stację (kandydat z dopasowania po mieście)
    expect(res.miejscowaStacjaManualna).toBe(true);
  });

  test('lokalny czujnik (~6,7 km): fallback stłumiony — zostaje 756 z kategorią null', async () => {
    await purgeKeys('airsc');
    scByRadius = { 12: [LOKALNY_CZUJNIK] };
    const res = await airForLocality('Busko-Zdrój');
    expect(res.station?.id).toBe(BUSKO.id);
    expect(res.kategoria).toBeNull();
    expect(res.community?.kategoria).not.toBeNull();
    expect(res.community?.nearestKm ?? 99).toBeLessThanOrEqual(12);
    // spójna pigułka (d4): efektywna kategoria z lokalnych czujników + wskazanie źródła
    expect(res.kategoriaEfektywna).toBe(res.community?.kategoria ?? null);
    expect(res.zrodloKategorii).toBe('community');
    expect(res.advice).toBe(adviceFor(res.community?.kategoria ?? null));
  });
});

describe('pigułka kategorii ze wskazaniem źródła (d4) — odpowiedź bez podmiany stacji', () => {
  test('wszyscy sąsiedzi zatruceni (503): 756 zostaje, kategoriaEfektywna z czujników ≥12 km', async () => {
    await purgeKeys('airsc');
    scByRadius = { 50: [DALEKI_CZUJNIK] };
    // nearby dla Buska to dokładnie SOLEC+KRAKOW+KRAKOW2 (sort wg dystansu, ≤80 km,
    // slice 3) — jedno zatrucie nie wystarczy: zdrowy KRAKOW2 przejąłby fallback
    poisonedIds.add(SOLEC.id);
    poisonedIds.add(KRAKOW.id);
    poisonedIds.add(KRAKOW2.id);
    try {
      const res = await airForLocality('Busko-Zdrój');
      expect(res.station?.id).toBe(BUSKO.id); // wszyscy nearby zatruceni — bez podmiany
      expect(res.kategoria).toBeNull();
      expect(res.kategoriaEfektywna).toBe(res.community?.kategoria ?? null);
      expect(res.zrodloKategorii).toBe('community');
      expect(res.advice).toBe(adviceFor(res.community?.kategoria ?? null));
      expect(res.miejscowaStacjaManualna).toBe(false); // fallback nie znalazł następcy
    } finally {
      poisonedIds.clear();
    }
  }, 30_000); // 3 zatrute sondowania × backoff GIOŚ (2 s + 4 s) ≈ 20 s — 30 s z zapasem
});
