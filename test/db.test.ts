import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// świeża baza na każdy moduł testowy (DB_PATH czytane przy imporcie)
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'zp-test-')), 'test.sqlite');

const { saveBenefits, likeBenefits, saveSnapshot, getSnapshots, snapshotAgeHours, snapshotProvinces, trackedBenefits } =
  await import('../server/db');

describe('db (sqlite)', () => {
  beforeEach(() => {
    saveBenefits(['ODDZIAŁ KARDIOLOGICZNY', 'PORADNIA STOMATOLOGICZNA', 'ODDZIAŁ OKULISTYCZNY']);
  });

  test('zapis i LIKE po słowniku', () => {
    expect(likeBenefits('%KARDIO%', 10)).toEqual(['ODDZIAŁ KARDIOLOGICZNY']);
    expect(likeBenefits('%STOMATO%', 10)).toEqual(['PORADNIA STOMATOLOGICZNA']);
  });

  test('snapshot per województwo + wiek + liczba województw', () => {
    saveSnapshot('ODDZIAŁ KARDIOLOGICZNY', '06', 1, 24, [{ id: 'x' }]);
    saveSnapshot('ODDZIAŁ KARDIOLOGICZNY', '07', 1, 37, [{ id: 'y' }]);
    const snaps = getSnapshots('ODDZIAŁ KARDIOLOGICZNY', 1);
    expect(snaps.length).toBe(2);
    expect(snapshotProvinces('ODDZIAŁ KARDIOLOGICZNY', 1)).toBe(2);
    const age = snapshotAgeHours('ODDZIAŁ KARDIOLOGICZNY', 1);
    expect(age).not.toBeNull();
    expect(age! < 1).toBe(true);
    // nadpisanie tego samego (benefit, province, case)
    saveSnapshot('ODDZIAŁ KARDIOLOGICZNY', '06', 1, 25, [{ id: 'x2' }]);
    expect(getSnapshots('ODDZIAŁ KARDIOLOGICZNY', 1).length).toBe(2);
    expect(trackedBenefits()).toContain('ODDZIAŁ KARDIOLOGICZNY');
  });
});
