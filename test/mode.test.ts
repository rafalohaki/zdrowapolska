import { describe, expect, test } from 'bun:test';
import { modeFromUrl } from '../src/lib/search';

describe('modeFromUrl', () => {
  test('rozpoznaje tryby z URL', () => {
    expect(modeFromUrl('?mode=wsparcie')).toBe('wsparcie');
    expect(modeFromUrl('?mode=placowki')).toBe('placowki');
    expect(modeFromUrl('?mode=raport')).toBe('raport');
    expect(modeFromUrl('?b=PORADNIA&mode=wsparcie')).toBe('wsparcie');
  });

  test('domyślnie terminy', () => {
    expect(modeFromUrl('')).toBe('terminy');
    expect(modeFromUrl('?b=KARDIOLOG')).toBe('terminy');
    expect(modeFromUrl('?mode=nieznany')).toBe('terminy');
  });

  test('nie łapie fałszywych trafień (regresja: substring match)', () => {
    expect(modeFromUrl('?xmode=wsparcie')).toBe('terminy');
    expect(modeFromUrl('?mode=wsparcie2')).toBe('terminy');
    expect(modeFromUrl('?mode=terminy&other=x')).toBe('terminy');
  });
});
