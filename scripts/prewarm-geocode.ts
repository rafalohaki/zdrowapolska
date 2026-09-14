/**
 * Pre-warm geocache: geokoduje adresy placówek ze snapshotów NFZ, żeby mapy
 * w aplikacji były pełne od pierwszego wejścia (bez czekania na Nominatim).
 *
 * Użycie:
 *   bun scripts/prewarm-geocode.ts                          # wszystkie śledzone świadczenia (cap MAX)
 *   bun scripts/prewarm-geocode.ts --benefit="ODDZIAŁ KARDIOLOGICZNY"
 *   bun scripts/prewarm-geocode.ts --max=500
 *
 * Fair-use Nominatim: 1 req/s (pacing w geocode.ts), wszystko cache'owane w SQLite.
 */

// .env produkcyjny wskazuje /app/data (kontener) — na hoście użyj ./data
if (!process.env.DB_PATH || process.env.DB_PATH.startsWith('/app/')) {
  process.env.DB_PATH = './data/zdrowapolska.sqlite';
}

const { getSnapshots, trackedBenefits } = await import('../server/db');
const { geocodeBatch } = await import('../server/geocode');

const args = process.argv.slice(2);
function arg(name: string, def: string | null = null): string | null {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

const onlyBenefit = arg('benefit');
const maxAddresses = Number(arg('max', '600'));

const tracked = trackedBenefits();
const targets = (onlyBenefit ? [onlyBenefit] : tracked).filter(Boolean);

console.log(`[prewarm] świadczenia do geokodowania: ${targets.length}${onlyBenefit ? ' (jeden)' : ' (wszystkie śledzone)'}`);

let totalAddresses = 0;
let totalGeocoded = 0;

for (const benefit of targets) {
  if (totalAddresses >= maxAddresses) {
    console.log(`[prewarm] limit ${maxAddresses} adresów osiągnięty — kończę`);
    break;
  }
  const snaps = getSnapshots(benefit, 1);
  const addresses: string[] = [];
  for (const s of snaps) {
    for (const rec of s.records) {
      const a = (rec.attributes ?? {}) as Record<string, unknown>;
      const addr = typeof a['address'] === 'string' ? (a['address'] as string) : '';
      const city = typeof a['locality'] === 'string' ? (a['locality'] as string) : '';
      if (addr && city) addresses.push(`${addr}, ${city}`);
    }
  }
  const unique = [...new Set(addresses)];
  if (unique.length === 0) continue;
  const budget = Math.min(unique.length, maxAddresses - totalAddresses);
  const slice = unique.slice(0, budget);
  console.log(`[prewarm] ${benefit}: ${slice.length}/${unique.length} adresów`);
  // geocodeBatch ma wewnętrzny cache (SQLite) — pomija już znane adresy
  const points = await geocodeBatch(slice);
  const ok = points.filter((p) => p !== null).length;
  totalAddresses += slice.length;
  totalGeocoded += ok;
  console.log(`  → ${ok}/${slice.length} geokodowanych`);
}

console.log(`[prewarm] gotowe. adresów przetworzonych: ${totalAddresses}, trafień: ${totalGeocoded}`);
