import type { AiResponse, CompareResponse, GslResult, ProvinceData } from './types';

export async function fetchFacilities(
  category: string,
  province: string,
  name = '',
  page = 1,
): Promise<GslResult & { page: number }> {
  const params = new URLSearchParams({ category, province, page: String(page) });
  if (name) params.set('name', name);
  const res = await fetch(`${API_BASE}/api/facilities?${params}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `GSL NFZ: HTTP ${res.status}`);
  }
  return (await res.json()) as GslResult & { page: number };
}

export type GeoPoint = { lat: number; lon: number } | null;

export async function geocodeBatch(
  addresses: string[],
  signal?: AbortSignal,
): Promise<(GeoPoint | null)[]> {
  const res = await fetch(`${API_BASE}/api/geocode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses }),
    signal,
  });
  if (!res.ok) throw new Error(`Geokodowanie: HTTP ${res.status}`);
  const json = (await res.json()) as { results: (GeoPoint | null)[] };
  return json.results;
}

/** Pojedyncze województwo (do ładowania progresywnego). */
export async function fetchProvinceQueues(
  benefit: string,
  province: string,
  kase: 1 | 2,
  locality: string,
  pages = 2,
): Promise<ProvinceData> {
  const params = new URLSearchParams({ benefit, province, case: String(kase), pages: String(pages) });
  if (locality) params.set('locality', locality);
  const res = await fetch(`${API_BASE}/api/queues-province?${params}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `NFZ: HTTP ${res.status}`);
  }
  return (await res.json()) as ProvinceData;
}

/**
 * Backend: w dev lokalny Bun (Hono), w produkcji domena tunelu.
 * Można nadpisać przy buildzie: VITE_API_BASE=https://inna-domena bun run build
 */
export const API_BASE =
  import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:2363' : 'https://yeapi.wpme.pl');

export async function fetchBenefits(name: string, signal?: AbortSignal): Promise<string[]> {
  // Preferuj Meilisearch (/api/search — literówki + synonimy, np. „dentysta" → stomatologia);
  // przy starszym backendzie wróć do /api/benefits.
  try {
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(name)}`, { signal });
    if (res.ok) {
      const json = (await res.json()) as { items?: string[] };
      return json.items ?? [];
    }
  } catch (err) {
    if (signal?.aborted) throw err; // przerwane zapytanie — nie próbuj fallbacku
  }
  const res = await fetch(`${API_BASE}/api/benefits?name=${encodeURIComponent(name)}`, { signal });
  if (!res.ok) throw new Error(`Słownik świadczeń: HTTP ${res.status}`);
  const json = (await res.json()) as { items: string[] };
  return json.items ?? [];
}

export async function fetchLocalities(name: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/localities?name=${encodeURIComponent(name)}`, { signal });
  if (!res.ok) throw new Error(`Słownik miejscowości: HTTP ${res.status}`);
  const json = (await res.json()) as { items: string[] };
  return json.items ?? [];
}

export async function fetchCompare(
  benefit: string,
  kase: 1 | 2,
  pages = 2,
  locality = '',
  signal?: AbortSignal,
): Promise<CompareResponse> {
  const params = new URLSearchParams({ benefit, case: String(kase), pages: String(pages) });
  if (locality) params.set('locality', locality);
  const res = await fetch(`${API_BASE}/api/compare?${params}`, { signal });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `NFZ: HTTP ${res.status}`);
  }
  return (await res.json()) as CompareResponse;
}

export async function fetchAdvice(
  benefit: string,
  results: unknown,
  question?: string,
): Promise<AiResponse> {
  const res = await fetch(`${API_BASE}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ benefit, results, question: question?.trim() || undefined }),
  });
  if (!res.ok) throw new Error(`Doradca AI: HTTP ${res.status}`);
  return (await res.json()) as AiResponse;
}
