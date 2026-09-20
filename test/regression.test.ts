import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// świeża baza na moduł testowy (DB_PATH czytane przy imporcie db.ts)
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'zp-regr-')), 'test.sqlite');
// bez Meilisearch — testujemy fallback SQLite
delete process.env.MEILI_URL;
// bez Redisa — testujemy ścieżkę pamięci (bun ładuje .env i redis://redis:6379 wisi na DNS)
delete process.env.REDIS_URL;

const db = await import('../server/db');
const { cached, purgeKeys } = await import('../server/cache');
const { searchBenefits } = await import('../server/search');
const { geocodeBatch } = await import('../server/geocode');
const { normCity, pmCategory, worstCategory, distKm, nearestStation } = await import('../server/air');
const { gslCity } = await import('../src/lib/matchQueues');
const { facilitiesCsv } = await import('../src/lib/csv');
const { paramsToState } = await import('../src/lib/search');

describe('staleBenefits — sync odświeża najstarsze snapshoty pierwsze', () => {
  test('kolejność po MIN(fetched_at), nie alfabetyczna', () => {
    db.saveSnapshot('ZZZ ŚWIADCZENIE', '06', 1, 10, []);
    db.saveSnapshot('AAA ŚWIADCZENIE', '06', 1, 10, []);
    // AAA zapisane później, ale cofamy mu zegar → powinno być pierwsze mimo alfabetyki
    db.db.query("UPDATE queue_snapshots SET fetched_at = '2020-01-01T00:00:00Z' WHERE benefit = 'ZZZ ŚWIADCZENIE'").run();
    expect(db.staleBenefits()[0]).toBe('ZZZ ŚWIADCZENIE');
  });
});

describe('cached() — predykat shouldCache', () => {
  test('nietrafione wyniki nie zapisują się w cache', async () => {
    let calls = 0;
    const key = `regr:miss:${Date.now()}`;
    const loader = async () => {
      calls++;
      return { found: false };
    };
    await cached(key, 60_000, loader, (v) => v.found);
    await cached(key, 60_000, loader, (v) => v.found);
    expect(calls).toBe(2); // miss nie utknął w cache
  });

  test('trafione wyniki są serwowane z cache', async () => {
    let calls = 0;
    const key = `regr:hit:${Date.now()}`;
    const loader = async () => {
      calls++;
      return { found: true };
    };
    await cached(key, 60_000, loader, (v) => v.found);
    await cached(key, 60_000, loader, (v) => v.found);
    expect(calls).toBe(1);
    await purgeKeys('regr:');
  });
});

describe('searchBenefits — fallback SQLite z polskimi diakrytykami', () => {
  beforeEach(() => {
    db.saveBenefits(['PORADNIA ŁÓDZKA', 'ODDZIAŁ ZABIEGOWY', 'PORADNIA POŁOŻNICZA']);
  });

  test('„łódz" trafia w „PORADNIA ŁÓDZKA"', async () => {
    const res = await searchBenefits('łódz');
    expect(res.source).toBe('sqlite');
    expect(res.items).toContain('PORADNIA ŁÓDZKA');
  });

  test('„oddzial" trafia w „ODDZIAŁ"', async () => {
    const res = await searchBenefits('oddzial');
    expect(res.items).toContain('ODDZIAŁ ZABIEGOWY');
  });
});

describe('geocodeBatch — jeden wynik na jeden adres wejściowy', () => {
  const A = 'UL. REJOWSKA 3, RZESZÓW';
  const B = 'UL. LEŚNA 7, RZESZÓW';

  beforeEach(() => {
    db.db.query(
      "INSERT INTO geocache (address, lat, lon, fetched_at, miss) VALUES (?, ?, ?, ?, 0) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at, miss = 0",
    ).run(A, 50.04, 22.0, new Date().toISOString());
    db.db.query(
      "INSERT INTO geocache (address, lat, lon, fetched_at, miss) VALUES (?, ?, ?, ?, 0) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at, miss = 0",
    ).run(B, 50.05, 22.1, new Date().toISOString());
  });

  test('duplikaty adresów nie rozjeżdżają indeksowania (wszystko z cache, bez sieci)', async () => {
    const res = await geocodeBatch([A, A, A]);
    expect(res.length).toBe(3);
    expect(res[0]).toEqual(res[1]);
    expect(res[1]?.lat).toBeCloseTo(50.04);
  });

  test('kolejność odpowiedzi = kolejność wejścia', async () => {
    const res = await geocodeBatch([A, B, A]);
    expect(res.length).toBe(3);
    expect(res[0]?.lat).toBeCloseTo(50.04);
    expect(res[1]?.lat).toBeCloseTo(50.05);
    expect(res[2]?.lat).toBeCloseTo(50.04);
  });
});

describe('queueTrend — historia dzienna kolejek', () => {
  test('saveSnapshot zapisuje historię + agregat per dzień', () => {
    const B = 'TREND TEST ŚWIADCZENIE';
    // 3 dni historii wstawione wprost + dziś przez saveSnapshot
    const ins = db.db.prepare(
      "INSERT INTO queue_history (benefit, province, case_no, locality, day, total, records, fetched_at) VALUES (?, '06', 1, '', ?, ?, 5, ?)",
    );
    ins.run(B, '2026-09-01', 100, '2026-09-01T10:00:00Z');
    ins.run(B, '2026-09-08', 80, '2026-09-08T10:00:00Z');
    db.saveSnapshot(B, '06', 1, 60, [{ id: 'x' }]);
    const pts = db.queueTrend(B, 1);
    expect(pts.length).toBe(3);
    expect(pts[0].total).toBe(100);
    expect(pts[2].total).toBe(60); // dziś z saveSnapshot
  });
});

describe('gslCity — miasto z adresu GSL z diakrytykami', () => {
  test('wyciąga surowe miasto (NFZ wymaga KRAKÓW, nie krakow)', () => {
    expect(gslCity('ul. Wrocławska 1-3, 30-901 KRAKÓW')).toBe('KRAKÓW');
    expect(gslCity('NARUTOWICZA 2, 33-300 Nowy Sącz')).toBe('Nowy Sącz');
    expect(gslCity('ul. Leśna 7')).toBe(''); // brak segmentu z miastem
  });
});

describe('facilitiesCsv — eksport rankingu', () => {
  const f = (provider: string) =>
    ({
      id: provider,
      provider,
      benefit: 'ODDZIAŁ KARDIOLOGICZNY',
      locality: 'RZESZÓW',
      address: 'LEŚNA 7',
      phone: '17 000 00 00',
      lat: null,
      lon: null,
      geo: null,
      province: '18',
      provinceName: 'podkarpackie',
      days: 45,
      waitLabel: '45 dni',
      awaiting: 120,
      statsUpdate: null,
      situationAsAt: null,
      flags: { ramp: true, elevator: false, toilet: true, wheelchairs: false, ac: false, automaticDoor: false, bus: true, forChildren: false },
    }) as const;

  test('BOM + średniki + escapowanie cudzysłowów', () => {
    const csv = facilitiesCsv([f('SZPITAL "MIEJSKI"; RZESZÓW') as never]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n'); // slice zdejmuje BOM
    expect(lines[0].startsWith('rank;placówka')).toBe(true);
    expect(lines[1]).toContain('"SZPITAL ""MIEJSKI""; RZESZÓW"');
    expect(lines[1]).toContain(';45;');
  });
});

describe('normCity — pusty wynik po normalizacji', () => {
  test('„!!!" normalizuje się do pustego stringa (nie dopasowuje wszystkich stacji)', () => {
    expect(normCity('!!!')).toBe('');
    expect(normCity('Łódź')).toBe('lodz');
  });
});

describe('jakość powietrza — progi PM i najbliższa stacja', () => {
  test('pmCategory: oficjalne progi polskiego indeksu (µg/m³)', () => {
    expect(pmCategory('PM25', 10)).toBe('Bardzo dobry');
    expect(pmCategory('PM25', 30)).toBe('Dobry');
    expect(pmCategory('PM25', 60)).toBe('Dostateczny');
    expect(pmCategory('PM25', 200)).toBe('Bardzo zły');
    expect(pmCategory('PM10', 45)).toBe('Dobry');
    expect(pmCategory('PM10', 160)).toBe('Bardzo zły');
  });

  test('worstCategory wybiera najgorszą kategorię', () => {
    expect(worstCategory(['Dobry', 'Zły', null])).toBe('Zły');
    expect(worstCategory([null, null])).toBeNull();
    expect(worstCategory(['Bardzo dobry'])).toBe('Bardzo dobry');
  });

  test('distKm + nearestStation: wybór po współrzędnych, nie po nazwie', () => {
    // Kraków (50.06,19.94) → Rzeszów ~148 km
    expect(distKm(50.06, 19.94, 50.04, 22.0)).toBeGreaterThan(140);
    expect(distKm(50.06, 19.94, 50.07, 19.95)).toBeLessThan(2);
    const stations = [
      { id: 1, code: '', name: 'Daleka', city: 'X', street: null, lat: 52.0, lon: 21.0 },
      { id: 2, code: '', name: 'Bliska', city: 'Y', street: null, lat: 50.05, lon: 19.95 },
      { id: 3, code: '', name: 'Bez koordów', city: 'Z', street: null, lat: null, lon: null },
    ];
    const near = nearestStation(stations, 50.06, 19.94);
    expect(near?.station.id).toBe(2); // pomija stacje bez współrzędnych
  });
});

describe('paramsToState — walidacja parametrów URL', () => {
  test('nieznany kod województwa → all (zamiast cichych pustych wyników)', () => {
    expect(paramsToState('?p=99&b=X').province).toBe('all');
    expect(paramsToState('?p=06&b=X').province).toBe('06');
    expect(paramsToState('?b=X').province).toBe('all');
  });

  test('nieznane klucze a11y są odrzucane (filtr „foo" zerowałby wyniki)', () => {
    expect(paramsToState('?a=ramp,foo,toilet').a11y).toEqual(['ramp', 'toilet']);
    expect(paramsToState('?a=foo').a11y).toEqual([]);
  });
});
