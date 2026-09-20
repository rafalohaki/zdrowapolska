import { describe, expect, test } from 'bun:test';
import { parsePcus, formatDaysShort, formatDaysLong, formatAwaiting, toFacility, waitLevel } from '../src/lib/wait';
import { matchesA11y, sortFacilities, stateToParams, paramsToState } from '../src/lib/search';
import type { Facility, NfzRecord } from '../src/lib/types';

describe('parsePcus', () => {
  test('parsuje dni', () => {
    expect(parsePcus('0 dni')).toBe(0);
    expect(parsePcus('45 dni')).toBe(45);
    expect(parsePcus('1 dzień')).toBe(1);
  });
  test('parsuje miesiące (30.42 dnia/mies.)', () => {
    expect(parsePcus('3 miesiące')).toBe(91);
    expect(parsePcus('1 miesiąc')).toBe(30);
    expect(parsePcus('2 miesiące')).toBe(61);
  });
  test('parsuje rok', () => {
    expect(parsePcus('rok')).toBe(365);
    expect(parsePcus('12 miesięcy')).toBe(365);
  });
  test('mnożnik lat — „2 lata" to 730, nie 365', () => {
    expect(parsePcus('2 lata')).toBe(730);
    expect(parsePcus('1 rok')).toBe(365);
    expect(parsePcus('3 lata')).toBe(1095);
  });
  test('nieznane wartości → null', () => {
    expect(parsePcus('brak danych')).toBeNull();
    expect(parsePcus('')).toBeNull();
    expect(parsePcus(null)).toBeNull();
    expect(parsePcus(undefined)).toBeNull();
  });
});

describe('formaty', () => {
  test('formatDaysShort', () => {
    expect(formatDaysShort(0)).toBe('0 dni');
    expect(formatDaysShort(1)).toBe('1 dzień');
    expect(formatDaysShort(45)).toBe('45 dni');
    expect(formatDaysShort(92)).toBe('~3 mies.');
    expect(formatDaysShort(null)).toBe('—');
  });
  test('formatDaysLong', () => {
    expect(formatDaysLong(0)).toBe('natychmiast (0 dni)');
    expect(formatDaysLong(1)).toBe('1 dzień');
    expect(formatDaysLong(92)).toBe('3 miesiące');
  });
  test('formatAwaiting (odmiana polska)', () => {
    expect(formatAwaiting(1)).toBe('1 osoba');
    expect(formatAwaiting(3)).toBe('3 osoby');
    expect(formatAwaiting(12)).toBe('12 osób');
    expect(formatAwaiting(23)).toBe('23 osoby');
    expect(formatAwaiting(null)).toBe('brak danych');
  });
  test('waitLevel progi', () => {
    expect(waitLevel(0)).toBe('great');
    expect(waitLevel(14)).toBe('great');
    expect(waitLevel(45)).toBe('ok');
    expect(waitLevel(46)).toBe('slow');
    expect(waitLevel(121)).toBe('bad');
    expect(waitLevel(null)).toBe('unknown');
  });
});

describe('toFacility', () => {
  const raw = {
    id: 'abc',
    attributes: {
      provider: 'SZPITAL TESTOWY',
      benefit: 'ODDZIAŁ KARDIOLOGICZNY',
      locality: 'Kraków',
      address: 'UL. TESTOWA 1',
      phone: '+48 12 345 67 89',
      ramp: 'Y',
      elevator: 'N',
      toilet: 'Y',
      'public-transport-lines': 'BUS, TRAMWAJ',
      'benefits-for-children': 'N',
      statistics: { 'provider-data': { awaiting: 42, 'average-period': 0, update: '2026-07' } },
      dates: { pcus: '0 dni', 'date-situation-as-at': '2026-08-07' },
    },
  };
  test('parsuje rekord i flagi', () => {
    const f = toFacility(raw, '06', 'małopolskie')!;
    expect(f.provider).toBe('SZPITAL TESTOWY');
    expect(f.days).toBe(0); // PCUS ma pierwszeństwo
    expect(f.awaiting).toBe(42);
    expect(f.flags.ramp).toBe(true);
    expect(f.flags.elevator).toBe(false);
    expect(f.flags.bus).toBe(true);
    expect(f.provinceName).toBe('małopolskie');
  });
  test('fallback na average-period gdy PCUS brak', () => {
    const rec: NfzRecord = {
      attributes: {
        provider: 'SZPITAL TESTOWY',
        dates: {},
        statistics: { 'provider-data': { awaiting: 10, 'average-period': 75 } },
      },
    };
    const f = toFacility(rec, '06', 'małopolskie')!;
    expect(f.days).toBe(75);
  });
  test('null dla rekordu bez providera', () => {
    expect(toFacility({ attributes: {} }, '06', 'małopolskie')).toBeNull();
  });
  test('lat/lon z NFZ i geo=null do uzupełnienia', () => {
    const rec: NfzRecord = { attributes: { provider: 'SZPITAL', latitude: 50.06, longitude: 19.94 } };
    const f = toFacility(rec, '06', 'małopolskie')!;
    expect(f.lat).toBe(50.06);
    expect(f.lon).toBe(19.94);
    expect(f.geo).toBeNull();
  });
  test('zerowe współrzędne traktowane jako brak (geo do uzupełnienia)', () => {
    const rec: NfzRecord = { attributes: { provider: 'SZPITAL', latitude: 0, longitude: 0 } };
    const f = toFacility(rec, '06', 'małopolskie')!;
    expect(f.lat).toBeNull();
    expect(f.geo).toBeNull();
  });
});

describe('search', () => {
  const fac = (days: number | null, awaiting: number | null, name = 'SZPITAL'): Facility => ({
    id: name + days + awaiting,
    provider: name,
    benefit: 'B',
    locality: 'L',
    address: 'A',
    phone: '',
    province: '06',
    provinceName: 'małopolskie',
    lat: null,
    lon: null,
    geo: null,
    days,
    waitLabel: null,
    awaiting,
    statsUpdate: null,
    situationAsAt: null,
    flags: { ramp: true, elevator: false, toilet: true, wheelchairs: false, ac: false, automaticDoor: false, bus: false, forChildren: false },
  });

  test('sortowanie wg czasu oczekiwania, null na końcu', () => {
    const sorted = sortFacilities([fac(null, 5), fac(30, 100), fac(3, 1)], 'wait');
    expect(sorted.map((f) => f.days)).toEqual([3, 30, null]);
  });
  test('filtr dostępności AND', () => {
    expect(matchesA11y(fac(3, 3), ['ramp'])).toBe(true);
    expect(matchesA11y(fac(3, 3), ['ramp', 'elevator'])).toBe(false);
  });
  test('roundtrip URL', () => {
    const s = { benefit: 'ODDZIAŁ KARDIOLOGICZNY', locality: 'KRAKÓW', province: '06', kase: 2 as const, a11y: ['ramp' as const], sort: 'awaiting' as const, view: 'compare' as const };
    const back = paramsToState(stateToParams(s).toString());
    expect(back).toEqual(s);
  });
});
