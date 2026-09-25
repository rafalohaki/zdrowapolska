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
import { normText } from '../src/lib/matchQueues';

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
  -- historia dzienna per klucz — napędza „trend kolejki" (snapshot się nadpisuje, historia rośnie)
  CREATE TABLE IF NOT EXISTS queue_history (
    benefit   TEXT NOT NULL,
    province  TEXT NOT NULL,
    case_no   INTEGER NOT NULL,
    locality  TEXT NOT NULL DEFAULT '',
    day       TEXT NOT NULL,
    total     INTEGER NOT NULL,
    records   INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (benefit, province, case_no, locality, day)
  );
  CREATE INDEX IF NOT EXISTS idx_history_benefit ON queue_history (benefit, case_no, locality, day);
  CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- ostatnie udane strony z serwisu „Gdzie się leczyć" — przy awarii GSL
  -- (timeout/502) serwujemy je z flagą stale zamiast pustego błędu
  CREATE TABLE IF NOT EXISTS gsl_snapshots (
    category  TEXT NOT NULL,
    province  TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    page      INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    total     INTEGER NOT NULL,
    json      TEXT NOT NULL,
    PRIMARY KEY (category, province, name, page)
  );
`);

// sprzątanie trujących snapshotów: w wolumenie bazy pojawiały się wiersze z
// sentinelową fetched_at z 2020-01-01 — MIN(fetched_at) w snapshotAgeHours pomijał
// przez nie świeżą ścieżkę DB przy /api/compare, a awaria NFZ serwowała 6-letnie
// dane jako stale. LIKE zamiast exact: wolumen ma format ISO '2020-01-01T00:00:00(.000)Z'
// (tak seeduje też test regresyjny), a realny sync nigdy tej daty nie zapisze.
{
  const snaps = db.query('DELETE FROM queue_snapshots WHERE fetched_at LIKE ?').run('2020-01-01%');
  const hist = db.query('DELETE FROM queue_history WHERE fetched_at LIKE ?').run('2020-01-01%');
  if (Number(snaps.changes) + Number(hist.changes) > 0) {
    console.log(
      `[db] usunięto trujące wiersze z fetched_at LIKE '2020-01-01%': snapshots=${snaps.changes}, history=${hist.changes}`,
    );
  }
}

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
  // historia: jeden wpis dziennie per klucz, w ramach dnia nadpisany najnowszym pomiarem
  db.query(
    `INSERT INTO queue_history (benefit, province, case_no, locality, day, total, records, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(benefit, province, case_no, locality, day)
     DO UPDATE SET total = excluded.total, records = excluded.records, fetched_at = excluded.fetched_at`,
  ).run(benefit, province, kase, locality, now().slice(0, 10), total, records.length, now());
}

export type TrendPoint = { day: string; total: number; records: number };

/** Trend kolejki: suma oczekujących i placówek per dzień (PL lub wskazana miejscowość). */
export function queueTrend(benefit: string, kase: number, locality = ''): TrendPoint[] {
  return db
    .query(
      `SELECT day, SUM(total) AS total, SUM(records) AS records
       FROM queue_history
       WHERE benefit = ? AND case_no = ? AND locality = ?
       GROUP BY day ORDER BY day`,
    )
    .all(benefit, kase, locality) as TrendPoint[];
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

/** Miejscowości ze snapshotów kolejek — fallback autouzupełniania przy padniętym NFZ.
 *  Dopasowanie po normText (diakrytyki/wielkość liter ignorowane, substring, nie
 *  tylko prefiks): „sącz" trafia w „NOWY SĄCZ", „lodz" w „ŁÓDŹ" — czego SQL LIKE
 *  (ASCII-only case-insensitive) nie potrafi. */
export function likeLocalities(pattern: string, limit: number): string[] {
  const q = normText(pattern);
  if (!q) return [];
  return (
    db
      .query(
        `SELECT DISTINCT json_extract(r.value, '$.attributes.locality') AS loc
         FROM queue_snapshots s, json_each(s.json) r
         ORDER BY loc`,
      )
      .all() as { loc: string | null }[]
  )
    .map((r) => r.loc)
    .filter((x): x is string => Boolean(x) && normText(x!).includes(q))
    .slice(0, limit);
}

/** Kanoniczna nazwa NFZ dla miejscowości wpisanej bez diakrytyków: DOKŁADNE trafienie
 *  po normText („KRAKOW" → „KRAKÓW" — NFZ wymaga diakrytyków i na „krakow" zwraca 0
 *  wyników). Bez trafu zwraca wejście bez zmian — nie zgadujemy nazwy z prefiksu.
 *  Skan json_each po całej tabeli snapshotów jest kosztowny, więc wynik per fraza
 *  trzymamy chwilę w pamięci (snapshoty doklejają się w tle synchronizacji). */
const canonicalCache = new Map<string, { at: number; value: string }>();
const CANONICAL_TTL_MS = 5 * 60_000;

export function canonicalLocality(name: string): string {
  if (!name) return name;
  const hit = canonicalCache.get(name);
  if (hit && Date.now() - hit.at < CANONICAL_TTL_MS) return hit.value;
  const q = normText(name);
  const rows = q
    ? (db
        .query(
          `SELECT DISTINCT json_extract(r.value, '$.attributes.locality') AS loc
           FROM queue_snapshots s, json_each(s.json) r`,
        )
        .all() as { loc: string | null }[])
    : [];
  const value =
    rows.map((r) => r.loc).find((x): x is string => Boolean(x) && normText(x!) === q) ?? name;
  canonicalCache.set(name, { at: Date.now(), value });
  return value;
}

export type GslSnapshot = { total: number; results: unknown[]; fetchedAt: string };

export function saveGslSnapshot(
  category: string,
  province: string,
  name: string,
  page: number,
  total: number,
  results: unknown[],
): void {
  db.query(
    `INSERT INTO gsl_snapshots (category, province, name, page, fetched_at, total, json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(category, province, name, page)
     DO UPDATE SET fetched_at = excluded.fetched_at, total = excluded.total, json = excluded.json`,
  ).run(category, province, name, page, now(), total, JSON.stringify(results));
}

export function getGslSnapshot(
  category: string,
  province: string,
  name: string,
  page: number,
): GslSnapshot | null {
  const row = db
    .query(
      'SELECT total, json, fetched_at FROM gsl_snapshots WHERE category = ? AND province = ? AND name = ? AND page = ?',
    )
    .get(category, province, name, page) as
    | { total: number; json: string; fetched_at: string }
    | undefined;
  if (!row) return null;
  return { total: row.total, results: JSON.parse(row.json), fetchedAt: row.fetched_at };
}

export function trackedBenefits(): string[] {
  return (
    db.query('SELECT DISTINCT benefit FROM queue_snapshots ORDER BY benefit').all() as {
      benefit: string;
    }[]
  ).map((r) => r.benefit);
}

/** Śledzone świadczenia od NAJSTARSZEGO snapshotu — przy limicie na cykl sync odświeża wszystkie po kolei. */
export function staleBenefits(): string[] {
  return (
    db
      .query(
        'SELECT benefit, MIN(fetched_at) AS oldest FROM queue_snapshots GROUP BY benefit ORDER BY oldest ASC',
      )
      .all() as { benefit: string }[]
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
