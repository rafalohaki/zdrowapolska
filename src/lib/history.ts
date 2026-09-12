/** Historia wyszukiwań w localStorage (ostatnie 8, bez duplikatów). */

export type HistoryItem = { benefit: string; locality: string; ts: number };

const KEY = 'zp_history';
const CAP = 8;

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.benefit === 'string') : [];
  } catch {
    return [];
  }
}

export function pushHistory(benefit: string, locality: string): HistoryItem[] {
  const item: HistoryItem = { benefit, locality, ts: Date.now() };
  const list = [item, ...loadHistory().filter((x) => x.benefit !== benefit || x.locality !== locality)].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
  return list;
}
