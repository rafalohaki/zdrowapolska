import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// air.ts → geocode.ts → db.ts (baza tworzona przy imporcie) — świeża baza na moduł
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'zp-air-')), 'test.sqlite');
// bez Redisa — ścieżka pamięci (bun ładuje .env i redis://redis:6379 wisi na DNS)
delete process.env.REDIS_URL;

const { cached, purgeKeys } = await import('../server/cache');
const { distKm, nearestStation, nearestStations, pickWithIndex, normCity } = await import(
  '../server/air'
);
import type { GiosStation } from '../server/air';

/** Fiks stacji GIOŚ (bez sieci — konstrukcja obiektu, zero fetchy). */
const st = (
  id: number,
  lat: number | null = null,
  lon: number | null = null,
  city = 'Miasto',
): GiosStation => ({
  id,
  code: '',
  name: `Stacja ${id}`,
  city,
  street: null,
  lat,
  lon,
});

/** Surowy obiekt AqIndex jak z GIOŚ — null kategorii = „indeks niepoliczony” (stacja manualna). */
const aqIndex = (kategoria: string | null) => ({ 'Nazwa kategorii indeksu': kategoria });

describe('nearestStations — ranking wg odległości (uogólnienie nearestStation)', () => {
  // fiks inspirowany Buskiem-Zdrojem: 756 = jedyna stacja w mieście (manualna),
  // 20568 Solec-Zdrój ~8 km na południe, Kraków daleko, jedna stacja bez współrzędnych
  const stations = [
    st(756, 50.4539, 20.5844, 'Busko-Zdrój'),
    st(20568, 50.4014, 20.6453, 'Solec-Zdrój'),
    st(400, 50.0647, 19.945, 'Kraków'),
    st(999, null, null),
  ];

  test('sortuje po distKm od punktu i pomija stacje bez współrzędnych', () => {
    const ranked = nearestStations(stations, 50.4539, 20.5844); // centrum Buska
    expect(ranked.map((r) => r.station.id)).toEqual([756, 20568, 400]);
    expect(ranked.map((r) => r.station.id)).not.toContain(999);
    expect(ranked[0].distanceKm).toBeLessThan(1);
    expect(ranked[1].distanceKm).toBeGreaterThan(3);
  });

  test('limit obcina listę do najbliższych', () => {
    const top = nearestStations(stations, 50.4539, 20.5844, 1);
    expect(top.length).toBe(1);
    expect(top[0].station.id).toBe(756);
  });

  test('nearestStation pozostaje zgodny (deleguje do nearestStations)', () => {
    const near = nearestStation(stations, 50.4014, 20.6453); // Solec-Zdrój
    expect(near?.station.id).toBe(20568);
    expect(near?.distanceKm).toBeCloseTo(distKm(50.4014, 20.6453, 50.4014, 20.6453), 5);
  });

  test('puste wejście / same stacje bez współrzędnych → pusto', () => {
    expect(nearestStations([], 50, 20)).toEqual([]);
    expect(nearestStations([st(1, null, null)], 50, 20)).toEqual([]);
    expect(nearestStation([st(1, null, null)], 50, 20)).toBeNull();
  });
});

describe('pickWithIndex — sondowanie kandydatów aż do żywego indeksu', () => {
  test('przerywa na pierwszej stacji z kategorią (kolejnych nie odpytuje)', async () => {
    const calls: number[] = [];
    const fetchIndex = async (id: number) => {
      calls.push(id);
      return id === 1 ? aqIndex(null) : aqIndex('Dobry'); // 756-like manualna, potem żywa
    };
    const picked = await pickWithIndex(
      [
        { station: st(1), distanceKm: null },
        { station: st(2), distanceKm: 8.2 },
        { station: st(3), distanceKm: 20 },
      ],
      fetchIndex,
    );
    expect(calls).toEqual([1, 2]); // stacja 3 nietknięta
    expect(picked?.station.id).toBe(2);
    expect(picked?.distanceKm).toBe(8.2);
    expect(picked?.index['Nazwa kategorii indeksu']).toBe('Dobry');
  });

  test('żadna stacja nie ma indeksu → null (fallback może spróbować sąsiadów)', async () => {
    const calls: number[] = [];
    const picked = await pickWithIndex(
      [
        { station: st(1), distanceKm: null },
        { station: st(2), distanceKm: null },
      ],
      async (id) => {
        calls.push(id);
        return aqIndex(null);
      },
    );
    expect(picked).toBeNull();
    expect(calls).toEqual([1, 2]);
  });

  test('limit ogranicza liczbę sondowań (≤3 stacji ≤80 km, nie cała Polska)', async () => {
    const calls: number[] = [];
    const candidates = [1, 2, 3, 4, 5].map((id) => ({ station: st(id), distanceKm: id * 10.0 }));
    const picked = await pickWithIndex(
      candidates,
      async (id) => {
        calls.push(id);
        return aqIndex(null);
      },
      3,
    );
    expect(picked).toBeNull();
    expect(calls).toEqual([1, 2, 3]);
  });

  test('pusta lista kandydatów → null bez wywołań', async () => {
    let calls = 0;
    const picked = await pickWithIndex([], async () => {
      calls++;
      return aqIndex('Dobry');
    });
    expect(picked).toBeNull();
    expect(calls).toBe(0);
  });

  test('fallback Busko: najbliżsi sąsiedzi stacji manualnej → Solec z indeksem', async () => {
    // ta sama kompozycja co w airForStation/airForLocality: nearestStations →
    // filtr (bez stacji wybranej, ≤80 km) → slice(0,3) → pickWithIndex
    const stations = [
      st(756, 50.4539, 20.5844, 'Busko-Zdrój'),
      st(20568, 50.4014, 20.6453, 'Solec-Zdrój'),
      st(400, 50.0647, 19.945, 'Kraków'),
    ];
    const nearby = nearestStations(stations, 50.4539, 20.5844)
      .filter((c) => c.station.id !== 756 && c.distanceKm <= 80)
      .slice(0, 3);
    expect(nearby.map((c) => c.station.id)).toEqual([20568, 400]); // Kraków w zasięgu listy…
    const fetchIndex = async (id: number) => (id === 20568 ? aqIndex('Umiarkowany') : aqIndex(null));
    const picked = await pickWithIndex(nearby, fetchIndex);
    // …ale Solec (2. na liście) ma indeks, więc pętla kończy zanim dotknie Kraków
    expect(picked?.station.id).toBe(20568);
    expect(picked?.station.city).toBe('Solec-Zdrój');
    expect(picked!.distanceKm).toBeLessThan(80);
  });
});

describe('cached() — negativeTtlMs dla niepełnych odpowiedzi air', () => {
  const airLike = (v: { kategoria: string | null }) => v.kategoria !== null;
  const emptyAir = () => ({ kategoria: null, pollutants: [], community: null, airly: null });

  test('bez negativeTtlMs — niepełna odpowiedź nie trafia do cache (loader 2×)', async () => {
    let calls = 0;
    const key = `airneg0:${Date.now()}`;
    const loader = async () => {
      calls++;
      return emptyAir();
    };
    await cached(key, 60_000, loader, airLike);
    await cached(key, 60_000, loader, airLike);
    expect(calls).toBe(2);
  });

  test('z negativeTtlMs — niepełna odpowiedź krótko w cache (loader 1×, nie 2×)', async () => {
    let calls = 0;
    const key = `airneg1:${Date.now()}`;
    const loader = async () => {
      calls++;
      return emptyAir();
    };
    await cached(key, 60_000, loader, airLike, 180_000);
    await cached(key, 60_000, loader, airLike, 180_000); // hit z ujemnego TTL
    expect(calls).toBe(1); // drugi przebieg obsłużony z ujemnego TTL — loader nie ruszony
    await purgeKeys('airneg');
  });

  test('wartościowa odpowiedź dalej cacheuje się pełnym ttlMs', async () => {
    let calls = 0;
    const key = `airneg2:${Date.now()}`;
    const loader = async () => {
      calls++;
      return { kategoria: 'Dobry', pollutants: [{ wskaznik: 'PM25' }], community: null, airly: null };
    };
    await cached(key, 60_000, loader, airLike, 180_000);
    await cached(key, 60_000, loader, airLike, 180_000);
    expect(calls).toBe(1);
    await purgeKeys('airneg');
  });
});

describe('normCity — ranking r3 nietknięty (miasto przed nazwą)', () => {
  test('diakrytyki i „ł” normalizowane jak dotychczas', () => {
    expect(normCity('Kraków')).toBe('krakow');
    expect(normCity('Busko-Zdrój')).toBe('busko zdroj');
    expect(normCity('Solec-Zdrój')).toBe('solec zdroj');
  });
});
