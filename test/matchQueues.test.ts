import { describe, expect, test } from 'bun:test';
import {
  buildQueueIndex,
  matchFacility,
  normPhone,
  parseGslAddress,
} from '../src/lib/matchQueues';
import type { NfzRecord } from '../src/lib/types';

const itl = (phone: string, address: string, locality: string, pcus: string, avg: number | null = null): NfzRecord => ({
  id: phone,
  attributes: {
    provider: 'TEST',
    phone,
    address,
    locality,
    dates: { pcus },
    statistics: { 'provider-data': { awaiting: 5, 'average-period': avg } },
  },
});

describe('normPhone', () => {
  test('ucina kierunkowy i formatuje', () => {
    expect(normPhone('+48 184 422 211')).toBe('184422211');
    expect(normPhone('+48 14 653 51 01')).toBe('146535101');
    expect(normPhone('')).toBe('');
    expect(normPhone(null)).toBe('');
  });
});
describe('parseGslAddress', () => {
  test('rozbija ulicę, numer i miasto', () => {
    expect(parseGslAddress('ul.Gabriela Narutowicza 2, 33-300 Nowy Sącz')).toEqual({
      city: 'nowy sacz',
      street: ['gabriela', 'narutowicza'],
      number: '2',
    });
  });

  test('składa ł na l (NFD nie rozkłada U+0142)', () => {
    expect(parseGslAddress('ul.Łódzka 5, 90-001 Łódź').city).toBe('lodz');
  });

  test('litera budynku oderwana spacją', () => {
    expect(parseGslAddress('ul.Lwowska 178 A, 33-100 Tarnów').number).toBe('178a');
  });
});

describe('matchFacility', () => {
  const records = [
    itl('+48 184 422 211', 'NARUTOWICZA 2', 'NOWY SĄCZ', '12 dni'),
    itl('+48 146 315 000', 'LWOWSKA 178A', 'TARNÓW', '0 dni'),
  ];
  const idx = buildQueueIndex(records);

  test('łączy po telefonie mimo różnych nazw', () => {
    const hit = matchFacility(
      { name: 'Centrum Wsparcia Psychicznego', address: 'ul.Gabriela Narutowicza 2, 33-300 Nowy Sącz', phone: '+48 184 422 211' },
      idx,
    );
    expect(hit?.days).toBe(12);
    expect(hit?.matchedBy).toBe('phone');
  });

  test('fallback na adres gdy telefon inny', () => {
    const hit = matchFacility(
      { name: 'Szpital', address: 'ul.Lwowska 178A, 33-100 Tarnów', phone: '+48 999 000 000' },
      idx,
    );
    expect(hit?.days).toBe(0);
    expect(hit?.matchedBy).toBe('address');
  });

  test('nie łączy różnych numerów domów', () => {
    const hit = matchFacility(
      { name: 'Szpital', address: 'ul.Lwowska 179, 33-100 Tarnów', phone: '+48 999 000 000' },
      idx,
    );
    expect(hit).toBeNull();
  });

  test('najkrótsza kolejka przy współdzielonym telefonie', () => {
    const multi = buildQueueIndex([
      itl('+48 111 222 333', 'A 1', 'X', '60 dni'),
      itl('+48 111 222 333', 'B 2', 'X', '5 dni'),
    ]);
    const hit = matchFacility({ name: 'N', address: '', phone: '111222333' }, multi);
    expect(hit?.days).toBe(5);
  });
});
