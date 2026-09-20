/**
 * Wyszukiwarka świadczeń: Meilisearch (self-host, tolerancja literówek, synonimy
 * polskie — np. „dentysta" znajduje PORADNIA STOMATOLOGICZNA) z dwoma fallbackami:
 * LIKE po lokalnej bazie SQLite, a na końcu żywy słownik NFZ.
 */

import { allBenefits } from './db';
import { getBenefits } from './nfz';
import { normText } from '../src/lib/matchQueues';

const MEILI_URL = (process.env.MEILI_URL ?? '').replace(/\/$/, '');
const MEILI_KEY = process.env.MEILI_MASTER_KEY ?? '';
const INDEX = 'benefits';

/** Pary synonimów (symetryczne) — potoczne nazwy + odmiany polskie z nazw NFZ. */
const SYNONYM_PAIRS: [string, string[]][] = [
  [
    'dentysta',
    ['stomatolog', 'stomatologia', 'stomatologiczna', 'stomatologicznej', 'stomatologiczny', 'stomatologii', 'protetyka', 'protetyki'],
  ],
  [
    'stomatolog',
    ['dentysta', 'stomatologia', 'stomatologiczna', 'stomatologicznej', 'stomatologiczny', 'stomatologii'],
  ],
  ['kardiolog', ['kardiologia', 'serce']],
  ['kardiologia', ['kardiolog']],
  ['ortopeda', ['ortopedia', 'traumatologia']],
  ['ortopedia', ['ortopeda']],
  ['okulista', ['okulistyka', 'oko']],
  ['okulistyka', ['okulista']],
  ['laryngolog', ['otorynolaryngologia', 'laryngologia']],
  ['laryngologia', ['laryngolog']],
  ['urolog', ['urologia']],
  ['urologia', ['urolog']],
  ['neurolog', ['neurologia']],
  ['neurologia', ['neurolog']],
  ['onkolog', ['onkologia', 'nowotwór']],
  ['onkologia', ['onkolog']],
  ['psychiatra', ['psychiatria']],
  ['psychiatria', ['psychiatra']],
  ['dermatolog', ['dermatologia']],
  ['dermatologia', ['dermatolog']],
  ['ginekolog', ['ginekologia', 'polożnictwo']],
  ['ginekologia', ['ginekolog']],
  ['pediatra', ['pediatria', 'dzieci']],
  ['pediatria', ['pediatra']],
  ['endokrynolog', ['endokrynologia']],
  ['endokrynologia', ['endokrynolog']],
  ['diabetolog', ['diabetologia', 'cukrzyca']],
  ['diabetologia', ['diabetolog']],
  ['reumatolog', ['reumatologia']],
  ['reumatologia', ['reumatolog']],
  ['chirurg', ['chirurgia']],
  ['chirurgia', ['chirurg']],
  ['fizjoterapeuta', ['fizjoterapia']],
  ['fizjoterapia', ['rehabilitacja', 'fizjoterapeuta']],
  ['rehabilitacja', ['fizjoterapia']],
  ['gastrolog', ['gastroenterologia']],
  ['gastroenterologia', ['gastrolog']],
];

const SYNONYMS: Record<string, string[]> = (() => {
  const map = new Map<string, Set<string>>();
  const add = (k: string, v: string) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(v);
  };
  for (const [a, bs] of SYNONYM_PAIRS) {
    for (const b of bs) {
      add(a, b);
      add(b, a);
    }
  }
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));
})();

async function meili<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MEILI_URL}${path}`, {
    method,
    headers: {
      ...(MEILI_KEY ? { Authorization: `Bearer ${MEILI_KEY}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Meilisearch ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return (await res.json()) as T;
}

/** Identyfikator dokumentu Meilisearch: tylko [a-z0-9-] (nazwy NFZ mają spacje/diacrytyki). */
function slugId(name: string): string {
  const ascii = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l');
  return (
    ascii
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'brak'
  );
}

async function waitForTask(uid: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await meili<{ status: string; error?: { message?: string } }>(
      'GET',
      `/tasks/${uid}`,
    );
    if (t.status === 'succeeded') return;
    if (t.status === 'failed' || t.status === 'canceled') {
      throw new Error(`Meilisearch task ${uid}: ${t.error?.message ?? t.status}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Meilisearch task ${uid}: timeout`);
}

/** Tworzy indeks, ustawia synonimy i ładuje słownik (idempotentne). */
export async function reindexBenefits(names: string[]): Promise<void> {
  if (!MEILI_URL) return;
  try {
    // utworzenie indeksu — jeśli już istnieje, ignorujemy (ważniejszy jest primaryKey przy dokumentach)
    await meili('POST', `/indexes/${INDEX}`, { uid: INDEX, primaryKey: 'name' })
      .then((t) => waitForTask((t as { taskUid: number }).taskUid))
      .catch(() => undefined);
    const settings = await meili<{ taskUid: number }>('PATCH', `/indexes/${INDEX}/settings`, {
      searchableAttributes: ['name'],
      filterableAttributes: [],
      synonyms: SYNONYMS,
      typoTolerance: { minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
    });
    await waitForTask(settings.taskUid);

    // upsert po primaryKey nie usuwa wycofanych świadczeń — czyść indeks przed
    // ładowaniem (DELETE /documents = deleteAll; pusty indeks krótko to OK,
    // bo searchBenefits i tak pada wtedy na fallback SQLite)
    if (names.length > 0) {
      const del = await meili<{ taskUid: number }>('DELETE', `/indexes/${INDEX}/documents`);
      await waitForTask(del.taskUid);
    }

    for (let i = 0; i < names.length; i += 500) {
      const batch = names.slice(i, i + 500).map((name) => ({ id: slugId(name), name }));
      const doc = await meili<{ taskUid: number }>('POST', `/indexes/${INDEX}/documents`, batch);
      await waitForTask(doc.taskUid);
    }
    console.log(`[search] zaindeksowano ${names.length} świadczeń w Meilisearch`);
  } catch (err) {
    console.error('[search] reindex failed:', err);
  }
}

export type SearchResult = { items: string[]; source: 'meilisearch' | 'sqlite' | 'nfz' };

export async function searchBenefits(query: string, limit = 25): Promise<SearchResult> {
  const q = query.trim();
  if (q.length < 3) return { items: [], source: 'meilisearch' };

  // 1) Meilisearch — literówki + synonimy
  if (MEILI_URL) {
    try {
      const res = await meili<{ hits: { name: string }[] }>(
        'POST',
        `/indexes/${INDEX}/search`,
        { q, limit, attributesToRetrieve: ['name'] },
      );
      if (res.hits.length > 0) {
        return { items: res.hits.map((h) => h.name), source: 'meilisearch' };
      }
      // 0 trafień (np. pusty indeks) → fallback poniżej
    } catch (err) {
      console.error('[search] meili failed, falling back:', err);
    }
  }

  // 2) lokalna baza — porównanie po normalizacji (SQLite LIKE jest case-insensitive
  // tylko dla ASCII: „łódź" nie trafiałoby w „ŁÓDŹ", „dentysta" w „STOMATOLOGICZNA")
  const qn = normText(q);
  const like = qn
    ? allBenefits()
        .filter((b) => normText(b).includes(qn))
        .slice(0, limit)
    : [];
  if (like.length > 0) return { items: like, source: 'sqlite' };

  // 3) żywy słownik NFZ
  const nfz = await getBenefits(q);
  return { items: nfz.items, source: 'nfz' };
}
