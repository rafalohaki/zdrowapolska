/**
 * Warstwa cache: Redis (klient wbudowany w Bun) z automatycznym fallbackiem
 * do cache'u w pamięci procesu — backend działa też bez Redisa (dev / awaria).
 */

import { RedisClient } from 'bun';

const memory = new Map<string, { value: string; expires: number }>();
const inflight = new Map<string, Promise<unknown>>();

let redis: RedisClient | null = null;
let redisDisabledUntil = 0;

function getRedis(): RedisClient | null {
  if (!process.env.REDIS_URL) return null;
  if (Date.now() < redisDisabledUntil) return null;
  if (!redis) {
    try {
      redis = new RedisClient(process.env.REDIS_URL);
    } catch {
      redisDisabledUntil = Date.now() + 60_000;
      return null;
    }
  }
  return redis;
}

async function redisGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    redisDisabledUntil = Date.now() + 60_000;
    redis = null;
    return null;
  }
}

async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, value, 'EX', ttlSeconds);
  } catch {
    redisDisabledUntil = Date.now() + 60_000;
    redis = null;
  }
}

/** Cache-first loader: Redis → pamięć → loader (z deduplikacją zapytań in-flight). */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const memoryHit = memory.get(key);
  if (memoryHit && memoryHit.expires > now) return JSON.parse(memoryHit.value) as T;

  const promise = (async () => {
    const raw = await redisGet(key);
    if (raw) {
      memory.set(key, { value: raw, expires: now + ttlMs });
      return JSON.parse(raw) as T;
    }
    const value = await loader();
    const serialized = JSON.stringify(value);
    memory.set(key, { value: serialized, expires: Date.now() + ttlMs });
    if (memory.size > 500) {
      // sprzątanie wygasłych wpisów pamięci
      for (const [k, v] of memory) if (v.expires < Date.now()) memory.delete(k);
    }
    await redisSet(key, serialized, Math.ceil(ttlMs / 1000));
    return value;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise as Promise<T>;
}

/** Usuwa klucze zaczynające się od prefiksu (np. po reindexie słownika). */
export async function purgeKeys(prefix: string): Promise<number> {
  let removed = 0;
  for (const [k, v] of memory) {
    if (k.startsWith(prefix) || v.expires < Date.now()) {
      if (k.startsWith(prefix)) removed++;
      memory.delete(k);
    }
  }
  const r = getRedis();
  if (!r) return removed;
  try {
    let cursor = '0';
    do {
      const res = (await (r as unknown as { send: (cmd: string, ...args: string[]) => Promise<[string, string[]]> }).send(
        'SCAN',
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        '500',
      )) as [string, string[]];
      cursor = res[0];
      if (res[1].length) {
        await r.del(...res[1]);
        removed += res[1].length;
      }
    } while (cursor !== '0');
  } catch {
    redisDisabledUntil = Date.now() + 60_000;
    redis = null;
  }
  return removed;
}

export function cacheStats() {
  return {
    entries: memory.size,
    inflight: inflight.size,
    redis: process.env.REDIS_URL ? (Date.now() < redisDisabledUntil ? 'down (fallback: memory)' : 'ok') : 'off',
  };
}

/** Okresy TTL w jednym miejscu — łatwo dostroić. */
export const TTL = {
  dictionaries: 24 * 60 * 60 * 1000,
  dbCompare: 10 * 60 * 1000, // odczyt snapshotu z SQLite — tani, ale nie odpytuj bazy co sekundę
  queues: 10 * 60 * 1000, // żywe pobranie z NFZ
  ai: 0,
};
