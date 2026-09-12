/**
 * Trwały magazyn danych NFZ — SQLite (bun:sqlite, wbudowany w Bun, zero zależności).
 * Trzyma: pełny słownik świadczeń, snapshoty statystyk kolejek (per świadczenie ×
 * województwo × przypadek) i stan synchronizacji. Dzięki temu wyszukiwanie
 * i porównania działają natychmiast z własnej bazy, a NFZ odpytujemy tylko
 * podczas kulturalnej synchronizacji w tle.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/zdrowapolska.sqlite';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// migracja: dodaj kolumnę locality (starsze wolumeny bez niej) — tabela jest cache'em,
// więc rebuild z utratą snapshotów jest akceptowalny (odbudowują się przy zapytaniach)
const snapCols = db.query('PRAGMA table_info(queue_snapshots)').all() as { name: string }[];
if (snapCols.length > 0 && !snapCols.some((c) => c.name === 'locality')) {
  db.exec('DROP TABLE queue_snapshots');
  console.log('[db] queue_snapshots: dodano kolumnę locality (tabela przebudowana)');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS benefits (
    name TEXT PRIMARY KEY,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS queue_snapshots (
    benefit   TEXT NOT NULL,
    province  TEXT NOT NULL,
    case_no   INTEGER NOT NULL,
    locality  TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    total     INTEGER NOT NULL,
    json      TEXT NOT NULL,
    PRIMARY KEY (benefit, province, case_no, locality)
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_benefit ON queue_snapshots (benefit, case_no);
  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

export function saveBenefits(names: string[]): number {
  const stmt = db.query(
    'INSERT INTO benefits (name, synced_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET synced_at = excluded.synced_at',
  );
  const tx = db.transaction((rows: string[]) => {
    for (const n of rows) stmt.run(n, now());
  });
  tx(names);
  return names.length;
}

export function allBenefits(): string[] {
  return (db.query('SELECT name FROM benefits ORDER BY name').all() as { name: string }[]).map(
    (r) => r.name,
  );
}

export function countBenefits(): number {
  return (db.query('SELECT COUNT(*) AS c FROM benefits').get() as { c: number }).c;
}

export function likeBenefits(pattern: string, limit: number): string[] {
  return (
    db
      .query('SELECT name FROM benefits WHERE name LIKE ? ORDER BY name LIMIT ?')
      .all(pattern, limit) as { name: string }[]
  ).map((r) => r.name);
}

export type ProvinceSnapshot = {
  code: string;
  name: string;
  total: number;
  records: unknown[];
  fetchedAt: string;
};

export function saveSnapshot(
  benefit: string,
  province: string,
  kase: number,
  total: number,
  records: unknown[],
  locality = '',
): void {
  db.query(
    `INSERT INTO queue_snapshots (benefit, province, case_no, locality, fetched_at, total, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(benefit, province, case_no, locality)
     DO UPDATE SET fetched_at = excluded.fetched_at, total = excluded.total, json = excluded.json`,
  ).run(benefit, province, kase, locality, now(), total, JSON.stringify(records));
}

export function getSnapshots(benefit: string, kase: number, locality = ''): ProvinceSnapshot[] {
  return (
    db
      .query(
        'SELECT province, total, json, fetched_at FROM queue_snapshots WHERE benefit = ? AND case_no = ? AND locality = ?',
      )
      .all(benefit, kase, locality) as {
      province: string;
      total: number;
      json: string;
      fetched_at: string;
    }[]
  ).map((r) => ({
    code: r.province,
    name: r.province, // nazwa województwa doklejana w warstwie compare
    total: r.total,
    records: JSON.parse(r.json),
    fetchedAt: r.fetched_at,
  }));
}

export function snapshotAgeHours(benefit: string, kase: number, locality = ''): number | null {
  const row = db
    .query(
      'SELECT MIN(fetched_at) AS oldest, COUNT(DISTINCT province) AS provinces FROM queue_snapshots WHERE benefit = ? AND case_no = ? AND locality = ?',
    )
    .get(benefit, kase, locality) as { oldest: string | null; provinces: number };
  if (!row.oldest || row.provinces === 0) return null;
  return (Date.now() - new Date(row.oldest).getTime()) / 3_600_000;
}

export function snapshotProvinces(benefit: string, kase: number, locality = ''): number {
  return (
    (db
      .query(
        'SELECT COUNT(DISTINCT province) AS c FROM queue_snapshots WHERE benefit = ? AND case_no = ? AND locality = ?',
      )
      .get(benefit, kase, locality) as { c: number }).c
  );
}

export type SingleSnapshot = { total: number; records: unknown[]; fetchedAt: string };

export function getSnapshotOne(
  benefit: string,
  province: string,
  kase: number,
  locality = '',
): SingleSnapshot | null {
  const row = db
    .query(
      'SELECT total, json, fetched_at FROM queue_snapshots WHERE benefit = ? AND province = ? AND case_no = ? AND locality = ?',
    )
    .get(benefit, province, kase, locality) as
    | { total: number; json: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  return { total: row.total, records: JSON.parse(row.json), fetchedAt: row.fetched_at };
}

export function trackedBenefits(): string[] {
  return (
    db.query('SELECT DISTINCT benefit FROM queue_snapshots ORDER BY benefit').all() as {
      benefit: string;
    }[]
  ).map((r) => r.benefit);
}

export function getSyncState(key: string): string | null {
  const row = db.query('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(key: string, value: string): void {
  db.query(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function dbStats() {
  return {
    benefits: countBenefits(),
    trackedBenefits: trackedBenefits().length,
    snapshots: (db.query('SELECT COUNT(*) AS c FROM queue_snapshots').get() as { c: number }).c,
    benefitsSyncedAt: getSyncState('benefits_synced_at'),
    queuesSyncedAt: getSyncState('queues_synced_at'),
  };
}
