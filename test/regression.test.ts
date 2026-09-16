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
const { normCity } = await import('../server/air');

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

describe('normCity — pusty wynik po normalizacji', () => {
  test('„!!!" normalizuje się do pustego stringa (nie dopasowuje wszystkich stacji)', () => {
    expect(normCity('!!!')).toBe('');
    expect(normCity('Łódź')).toBe('lodz');
  });
});
