import type { GslFacility, NfzRecord } from './types';
import { parsePcus } from './wait';

export type QueueInfo = {
  days: number | null;
  awaiting: number | null;
  matchedBy: 'phone' | 'address';
};

/** "+48 184 422 211" → "184422211". Puste, gdy za krótkie by ufać porównaniu. */
export function normPhone(phone: unknown): string {
  if (typeof phone !== 'string') return '';
  const digits = phone.replace(/\D/g, '');
  const tail = digits.slice(-9);
  return tail.length >= 7 ? tail : '';
}

function normText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l') // NFD nie rozkłada U+0142 — bez tego „Łódź" ≠ „lodz"
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-ząćęłńóśźż0-9/ ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
type ParsedAddr = { city: string; street: string[]; number: string };

function splitNumber(token: string): { street: string[]; number: string } {
  const parts = token.split(' ').filter(Boolean);
  // „LWOWSKA 178 A" — litera budynku oderwana spacją
  if (
    parts.length >= 3 &&
    /^[a-z]$/.test(parts[parts.length - 1] ?? '') &&
    /\d/.test(parts[parts.length - 2] ?? '')
  ) {
    const num = parts[parts.length - 2]!.replace(/\//g, '') + parts[parts.length - 1]!;
    return { street: parts.slice(0, -2), number: num };
  }
  const last = parts[parts.length - 1] ?? '';
  if (/\d/.test(last)) return { street: parts.slice(0, -1), number: last.replace(/\//g, '') };
  return { street: parts, number: '' };
}

/** "ul.Gabriela Narutowicza 2, 33-300 Nowy Sącz" → { city: "nowy sacz", street: [gabriela, narutowicza], number: "2" } */
export function parseGslAddress(address: string): ParsedAddr {
  const [streetRaw = '', cityRaw = ''] = address.split(',');
  const streetNorm = normText(streetRaw).replace(/^(ul|al|os|pl|rynek|ulica) /, '');
  const cityNorm = normText(cityRaw).replace(/^\d{2} \d{3} /, '');
  const { street, number } = splitNumber(streetNorm);
  return { city: cityNorm, street, number };
}

/** ITL: address "NARUTOWICZA 2" + locality "NOWY SĄCZ" (osobne pola). */
export function parseItlAddress(address: unknown, locality: unknown): ParsedAddr {
  const { street, number } = splitNumber(normText(typeof address === 'string' ? address : ''));
  return { city: normText(typeof locality === 'string' ? locality : ''), street, number };
}

function queueInfoOf(rec: NfzRecord, matchedBy: QueueInfo['matchedBy']): QueueInfo | null {
  const a = rec.attributes ?? {};
  const dates = (a['dates'] ?? {}) as Record<string, unknown>;
  const stats = (a['statistics'] ?? {}) as Record<string, unknown>;
  const pd = (stats['provider-data'] ?? {}) as Record<string, unknown>;
  const days =
    parsePcus(dates['pcus']) ??
    (typeof pd['average-period'] === 'number' && (pd['average-period'] as number) > 0
      ? (pd['average-period'] as number)
      : null);
  const awaiting = typeof pd['awaiting'] === 'number' ? (pd['awaiting'] as number) : null;
  if (days === null && awaiting === null) return null;
  return { days, awaiting, matchedBy };
}

type QueueIndex = {
  byPhone: Map<string, QueueInfo>;
  byAddr: { info: QueueInfo; addr: ParsedAddr }[];
};

function better(a: QueueInfo, b: QueueInfo): QueueInfo {
  // ten sam telefon w kilku rekordach (centrala) → bierz najkrótszą kolejkę
  if (a.days === null) return b;
  if (b.days === null) return a;
  return b.days < a.days ? b : a;
}

/** Indeks rekordów kolejek pod dopasowanie do placówek GSL. */
export function buildQueueIndex(records: NfzRecord[]): QueueIndex {
  const byPhone = new Map<string, QueueInfo>();
  const byAddr: QueueIndex['byAddr'] = [];
  for (const rec of records) {
    const a = rec.attributes ?? {};
    const info = queueInfoOf(rec, 'phone');
    if (!info) continue;
    const phone = normPhone(a['phone']);
    if (phone) {
      const prev = byPhone.get(phone);
      byPhone.set(phone, prev ? better(prev, { ...info, matchedBy: 'phone' }) : { ...info, matchedBy: 'phone' });
    }
    const addr = parseItlAddress(a['address'], a['locality']);
    if (addr.city && addr.number) byAddr.push({ info: { ...info, matchedBy: 'address' }, addr });
  }
  return { byPhone, byAddr };
}

/** Dopasuj placówkę GSL do kolejki: najpierw telefon, potem miasto+ulica+numer. */
export function matchFacility(f: GslFacility, idx: QueueIndex): QueueInfo | null {
  const phone = normPhone(f.phone);
  if (phone) {
    const hit = idx.byPhone.get(phone);
    if (hit) return hit;
  }
  if (!f.address) return null;
  const addr = parseGslAddress(f.address);
  if (!addr.city || !addr.number) return null;
  let best: QueueInfo | null = null;
  for (const cand of idx.byAddr) {
    if (cand.addr.city !== addr.city || cand.addr.number !== addr.number) continue;
    const shared = cand.addr.street.some((t) => t.length > 3 && addr.street.includes(t));
    if (!shared) continue;
    best = best ? better(best, cand.info) : cand.info;
  }
  return best;
}
