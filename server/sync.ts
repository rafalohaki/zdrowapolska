/**
 * Kulturalny scraper NFZ: buduje i odświeża lokalną bazę świadczeń i statystyk
 * kolejek NA ZEWNĄTRZ od czasu demo (nocne/harmonogramowe synchronizacje).
 *
 * Zasady fair-use:
 * - jedno żądanie naraz (wspólny limiter z server/nfz.ts), odstęp ~60 ms,
 * - brak rotacji IP / proxy / Tor — nie obchodzimy limitów per-IP,
 * - pełny słownik ~150-400 żądań raz na cykl; kolejki: max SYNC_MAX_QUEUES_PER_RUN.
 */

import {
  allBenefits,
  dbStats,
  saveBenefits,
  saveSnapshot,
  setSyncState,
  getSyncState,
  trackedBenefits,
} from './db';
import { computeInsights } from './insights';
import { getBenefits, getCompare } from './nfz';
import { reindexBenefits } from './search';

const ALPHABET = 'aąbcćdeęfghijklmnóprstuwyzźż'.split('');
const LIMIT = 25;
const MIN_NAME_LEN = 3;

/** Startowe prefiksy (pierwsze litery typowych słów w nazwach NFZ). */
const SEED_PREFIXES = [
  'odd', 'por', 'zak', 'świ', 'lec', 'reh', 'ośr', 'hos', 'izb', 'pro',
  'sto', 'kar', 'ort', 'uro', 'neu', 'onk', 'oku', 'gin', 'che', 'dia',
  'end', 'gas', 'der', 'reu', 'psy', 'fiz', 'nef', 'pal', 'pie', 'pul',
  'amb', 'ope', 'tra', 'wst', 'zab', 'kra', 'oty', 'wym', 'nar', 'zab',
];

type SyncStatus = {
  running: boolean;
  phase: 'idle' | 'benefits' | 'queues';
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  progress: string;
};

const status: SyncStatus = {
  running: false,
  phase: 'idle',
  startedAt: null,
  finishedAt: getSyncState('last_sync_finished_at'),
  lastError: null,
  progress: '',
};

function log(msg: string) {
  console.log(`[sync ${new Date().toISOString()}] ${msg}`);
}

/** Spacer BFS po prefiksach słownika NFZ (name jest dopasowaniem fragmentu nazwy). */
async function walkBenefits(): Promise<string[]> {
  const found = new Set<string>();
  const seeds = new Set<string>(getSyncState('seed_prefixes')?.split(',') ?? SEED_PREFIXES);

  const walk = async (prefix: string, depth: number): Promise<void> => {
    const res = await getBenefits(prefix);
    if (res.count <= LIMIT) {
      for (const name of res.items) found.add(name);
      return;
    }
    for (const name of res.items) found.add(name);
    if (depth >= 7) return; // rozsądny limit głębokości
    for (const letter of ALPHABET) {
      await walk(prefix + letter, depth + 1);
    }
  };

  for (const seed of seeds) {
    await walk(seed, MIN_NAME_LEN);
  }

  // Samonaprawa pokrycia: nowe słowa z zebranych nazw stają się nasionami na kolejny raz.
  const words = new Set<string>();
  for (const name of found) {
    for (const w of name.toLowerCase().split(/[^a-ząćęłńóśźż]+/)) {
      if (w.length >= MIN_NAME_LEN) words.add(w.slice(0, MIN_NAME_LEN));
    }
  }
  const before = seeds.size;
  for (const w of words) seeds.add(w);
  if (seeds.size > before) setSyncState('seed_prefixes', [...seeds].join(','));

  return [...found];
}

export async function syncBenefits(): Promise<number> {
  log('start: słownik świadczeń');
  const names = await walkBenefits();
  saveBenefits(names);
  setSyncState('benefits_synced_at', new Date().toISOString());
  await reindexBenefits(allBenefits());
  log(`słownik: ${names.length} nazw → SQLite + Meilisearch`);
  return names.length;
}

export async function syncQueuesForBenefit(benefit: string, kase: 1 | 2 = 1): Promise<void> {
  const compare = await getCompare(benefit, kase, Number(process.env.SYNC_PAGES ?? 1));
  for (const p of compare.provinces) {
    saveSnapshot(benefit, p.code, kase, p.total, p.records);
  }
  setSyncState('queues_synced_at', new Date().toISOString());
}

/** Synchronizacja kolejek dla świadczeń już śledzonych + popularnych, z limitem na cykl. */
export async function syncQueues(): Promise<number> {
  const inDb = new Set(allBenefits());
  const popular = (process.env.SYNC_POPULAR ?? 'ODDZIAŁ KARDIOLOGICZNY,ODDZIAŁ CHIRURGII URAZOWO-ORTOPEDYCZNEJ,ODDZIAŁ OKULISTYCZNY,PORADNIA STOMATOLOGICZNA')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => inDb.has(s));
  const tracked = trackedBenefits();
  const queue = [...new Set([...popular, ...tracked])].slice(
    0,
    Number(process.env.SYNC_MAX_QUEUES_PER_RUN ?? 40),
  );
  let done = 0;
  for (const benefit of queue) {
    await syncQueuesForBenefit(benefit);
    done++;
    status.progress = `kolejki ${done}/${queue.length}`;
    log(`${status.progress}: ${benefit}`);
  }
  return done;
}

async function runSync(scope: 'benefits' | 'queues' | 'all'): Promise<void> {
  status.running = true;
  status.lastError = null;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  try {
    if (scope === 'benefits' || scope === 'all') {
      status.phase = 'benefits';
      await syncBenefits();
    }
    if (scope === 'queues' || scope === 'all') {
      status.phase = 'queues';
      await syncQueues();
      setSyncState('insights', JSON.stringify(computeInsights()));
    }
    setSyncState('last_sync_finished_at', new Date().toISOString());
    log('zakończono');
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error('[sync] failed:', err);
  } finally {
    status.running = false;
    status.phase = 'idle';
    status.finishedAt = new Date().toISOString();
    status.progress = '';
  }
}

/** Wyzwól synchronizację (nie koliduje z biegnącą). */
export function triggerSync(scope: 'benefits' | 'queues' | 'all'): boolean {
  if (status.running) return false;
  void runSync(scope);
  return true;
}

export function getSyncStatus() {
  return { ...status, db: dbStats() };
}

/** Harmonogram: synchronizacja w tle co SYNC_INTERVAL_H godzin (domyślnie 12). */
export function startSyncScheduler(): void {
  const intervalH = Number(process.env.SYNC_INTERVAL_H ?? 12);
  if (!Number.isFinite(intervalH) || intervalH <= 0) return;

  // przy starcie: pusty słownik → zbuduj bazę od razu (w tle, nie blokuje serwera)
  if (dbStats().benefits === 0) {
    log('pusta baza — pierwsza synchronizacja słownika w tle');
    triggerSync('benefits');
  }

  setInterval(
    () => {
      log(`harmonogram: cykliczna synchronizacja (co ${intervalH} h)`);
      triggerSync('all');
    },
    intervalH * 3_600_000,
  ).unref();
}
