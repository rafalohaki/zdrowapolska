import type { Facility, NfzRecord, NfzAttributes } from './types';

/** "0 dni" → 0, "45 dni" → 45, "3 miesiące" → 92, "rok" → 365, nieznane → null */
export function parsePcus(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const text = label.trim().toLowerCase();
  if (!text || text === 'brak' || text === 'bd') return null;
  const num = text.match(/(\d+(?:[.,]\d+)?)/);
  if (text.includes('mies')) {
    const m = num ? parseFloat(num[1].replace(',', '.')) : 1;
    return Math.round(m * 30.42);
  }
  if (text.includes('rok') || text.includes('lat')) {
    const y = num ? parseFloat(num[1].replace(',', '.')) : 1;
    return Math.round(y * 365); // „2 lata" → 730 (wcześniej zawsze 365)
  }
  if (num) {
    const val = parseFloat(num[1].replace(',', '.'));
    return Number.isFinite(val) ? Math.round(val) : null;
  }
  return null;
}

const bool = (v: unknown): boolean => v === 'Y' || v === true;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Spłaszcza surowy rekord NFZ do Facility; provinceName z kodu oddziału. */
export function toFacility(
  rec: NfzRecord,
  provinceCode: string,
  provinceName: string,
): Facility | null {
  const a: NfzAttributes = rec.attributes ?? {};
  const provider = str(a['provider']);
  if (!provider) return null;

  const stats = (a['statistics'] ?? {}) as NfzAttributes;
  const providerData = (stats['provider-data'] ?? {}) as NfzAttributes;
  const computed = (stats['computed-data'] ?? null) as NfzAttributes | null;
  const dates = (a['dates'] ?? {}) as NfzAttributes;

  const waitLabel = str(dates['pcus']) || null;
  const pcusDays = parsePcus(waitLabel);
  const avgProvider = typeof providerData['average-period'] === 'number' ? (providerData['average-period'] as number) : null;
  const avgComputed = computed && typeof computed['average-period'] === 'number' ? (computed['average-period'] as number) : null;

  const days = pcusDays ?? (avgProvider !== null && avgProvider > 0 ? avgProvider : null) ?? (avgComputed !== null && avgComputed > 0 ? avgComputed : null);

  const lat = typeof a['latitude'] === 'number' ? (a['latitude'] as number) : null;
  const lon = typeof a['longitude'] === 'number' ? (a['longitude'] as number) : null;

  return {
    id: str(rec.id) || `${provider}|${str(a['address'])}|${str(a['benefit'])}`,
    provider,
    benefit: str(a['benefit']),
    locality: str(a['locality']),
    address: str(a['address']),
    phone: str(a['phone']),
    province: provinceCode,
    provinceName,
    lat: lat === 0 || lat === null ? null : lat,
    lon: lon === 0 || lon === null ? null : lon,
    geo: null,
    days,
    waitLabel,
    awaiting: typeof providerData['awaiting'] === 'number' ? (providerData['awaiting'] as number) : null,
    statsUpdate: str(providerData['update']) || null,
    situationAsAt: str(dates['date-situation-as-at']) || null,
    flags: {
      ramp: bool(a['ramp']),
      elevator: bool(a['elevator']),
      toilet: bool(a['toilet']),
      wheelchairs: bool(a['wheelchairs']),
      ac: bool(a['ac']),
      automaticDoor: bool(a['automatic-door']),
      bus: str(a['public-transport-lines']) !== '' && str(a['public-transport-lines']) !== 'N',
      forChildren: bool(a['benefits-for-children']),
    },
  };
}

export type WaitLevel = 'great' | 'ok' | 'slow' | 'bad' | 'unknown';

export function waitLevel(days: number | null): WaitLevel {
  if (days === null) return 'unknown';
  if (days <= 14) return 'great';
  if (days <= 45) return 'ok';
  if (days <= 120) return 'slow';
  return 'bad';
}

/** "92" → "3 mies." — krótki format do badge'ów i wykresów */
export function formatDaysShort(days: number | null): string {
  if (days === null) return 'bd';
  if (days === 1) return '1 dzień';
  if (days <= 45) return `${days} dni`;
  const months = Math.round(days / 30.42);
  return `~${months} mies.`;
}

/** "92" → "92 dni" / "3 miesiące" — pełny format do szczegółów */
export function formatDaysLong(days: number): string {
  if (days === 0) return 'natychmiast (0 dni)';
  if (days <= 45) return days === 1 ? '1 dzień' : `${days} dni`;
  const months = Math.round(days / 30.42);
  if (months === 1) return '1 miesiąc';
  const last = months % 10;
  const tens = months % 100;
  const word = last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14) ? 'miesiące' : 'miesięcy';
  return `${months} ${word}`;
}

/** Pluralizacja: 1 osoba, 2-4 osoby, 5+ osób */
export function formatAwaiting(n: number | null): string {
  if (n === null) return 'bd';
  if (n === 1) return '1 osoba';
  const last = n % 10;
  const tens = n % 100;
  if (last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14)) return `${n} osoby`;
  return `${n} osób`;
}
