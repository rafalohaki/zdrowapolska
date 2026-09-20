import { useEffect, useMemo, useRef, useState } from 'react';
import { geocodeBatch } from '../lib/api';
import { formatDaysShort, waitLevel } from '../lib/wait';
import { escapeHtml, telHref } from '../lib/html';
import type { Facility } from '../lib/types';
import type * as LType from 'leaflet';
import { loadLeaflet } from './leaflet-loader';

export type ResolvedFacility = Facility & { rlat: number | null; rlon: number | null };

const PIN_COLORS: Record<string, string> = {
  great: '#059669',
  ok: '#65a30d',
  slow: '#f59e0b',
  bad: '#f43f5e',
  unknown: '#94a3b8',
};

function makePin(L: typeof LType, color: string, dark: boolean): LType.DivIcon {
  return L.divIcon({
    className: 'zp-pin',
    html: `<span style="display:block;width:20px;height:20px;border-radius:50%;background:${color};border:3px solid ${
      dark ? '#0f172a' : '#fff'
    };box-shadow:0 1px 4px rgb(0 0 0 / .4)"></span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });
}

/**
 * Mapa rankingu terminów: pinezki kolorowane wg czasu oczekiwania
 * (zielona = szybko, czerwona = długa kolejka). Adresy bez współrzędnych
 * NFZ geokoduje w batchach (max 5 na cykl, reszta przy cache-hitach).
 */
export function TerminyMap({
  facilities,
  onResolve,
  mapKey,
}: {
  facilities: Facility[];
  onResolve: (updates: { id: string; lat: number; lon: number }[] | { id: string }[]) => void;
  mapKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType.Map | null>(null);
  const [resolving, setResolving] = useState(false);
  const triedRef = useRef<Set<string>>(new Set());
  const [retryTick, setRetryTick] = useState(0);
  const failStreakRef = useRef(0);
  // nowe wyszukiwanie (mapKey) = nowa pula prób
  const keyRef = useRef(mapKey);
  if (keyRef.current !== mapKey) {
    keyRef.current = mapKey;
    triedRef.current = new Set();
    failStreakRef.current = 0;
  }

  // Leaflet przy unmount: remove() zdejmuje listenery window/document — bez tego
  // każde wejście w widok mapy zostawiało wiszącą instancję
  useEffect(
    () => () => {
      const m = mapRef.current;
      if (m) {
        lastFit.delete(m);
        m.remove();
        mapRef.current = null;
      }
    },
    [],
  );

  const resolved = useMemo<ResolvedFacility[]>(() => {
    return facilities.map((f) => {
      if (f.lat !== null && f.lon !== null) return { ...f, rlat: f.lat, rlon: f.lon };
      if (f.geo && typeof f.geo === 'object') return { ...f, rlat: f.geo.lat, rlon: f.geo.lon };
      return { ...f, rlat: null, rlon: null };
    });
  }, [facilities]);

  const pending = useMemo(
    () => resolved.filter((f) => f.rlat === null && f.geo !== 'miss'),
    [resolved],
  );
  const plotted = useMemo(() => resolved.filter((f) => f.rlat !== null), [resolved]);

  // geokodowanie zaległości — 10 adresów na cykl (pacing Nominatim trzyma backend);
  // każdy adres próbujemy raz (miss oznaczamy w triedRef, żeby nie zapętlać zapytań)
  useEffect(() => {
    if (pending.length === 0) return;
    let alive = true;
    const batch = pending
      .filter((f) => !triedRef.current.has(f.id) && (f.address || f.locality))
      .slice(0, 10);
    if (batch.length === 0) {
      onResolve(pending.map((f) => ({ id: f.id })));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const f of batch) triedRef.current.add(f.id);
    setResolving(true);
    void geocodeBatch(batch.map((f) => `${f.address}, ${f.locality}`.replace(/^,\s*/, '')))
      .then((res) => {
        if (!alive) return;
        failStreakRef.current = 0;
        const updates = res
          .map((point, i) => (point ? { id: batch[i].id, lat: point.lat, lon: point.lon } : { id: batch[i].id }))
          .filter((u) => 'lat' in u) as { id: string; lat: number; lon: number }[];
        const misses = res
          .map((point, i) => (!point ? { id: batch[i].id } : null))
          .filter((u): u is { id: string } => u !== null);
        const all = [...updates, ...misses];
        if (all.length > 0 && alive) onResolve(all);
      })
      .catch(() => {
        // awaria backendu / 429: cofnij marki i spróbuj ponownie z opóźnieniem —
        // bez tego adresy zostawały na zawsze jako „pozostało N"
        for (const f of batch) triedRef.current.delete(f.id);
        failStreakRef.current += 1;
        if (alive && failStreakRef.current <= 4) {
          timer = setTimeout(() => {
            if (alive) setRetryTick((t) => t + 1);
          }, 8000);
        }
      })
      .finally(() => {
        if (alive) setResolving(false);
      });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length === 0 ? 'done' : pending.map((f) => f.id).join(','), onResolve, retryTick]);

  // render mapy (Leaflet ładowany leniwie przy pierwszym otwarciu widoku)
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!containerRef.current) return;
        const L = await loadLeaflet();
        if (!alive || !containerRef.current) return;
        if (!mapRef.current) {
          mapRef.current = L.map(containerRef.current).setView([51.92, 19.15], 6);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap',
            maxZoom: 18,
          }).addTo(mapRef.current);
        }
        const map = mapRef.current;
        map.eachLayer((layer) => {
          if (layer instanceof L.Marker) map.removeLayer(layer);
        });
        const dark = document.documentElement.classList.contains('dark');
        const bounds: [number, number][] = [];
        for (const f of plotted.slice(0, 200)) {
          bounds.push([f.rlat as number, f.rlon as number]);
          L.marker([f.rlat as number, f.rlon as number], {
            icon: makePin(L, PIN_COLORS[waitLevel(f.days)], dark),
          })
            .addTo(map)
            .bindPopup(
              `<strong>${escapeHtml(f.provider)}</strong><br>${escapeHtml(f.locality)}${
                f.address ? `, ${escapeHtml(f.address)}` : ''
              }<br><strong>Czas oczekiwania: ${escapeHtml(formatDaysShort(f.days))}</strong><br>${
                f.phone ? `<a href="tel:${telHref(f.phone)}">${escapeHtml(f.phone)}</a>` : ''
              }`,
            );
        }
        if (bounds.length > 0 && mapKeyChanged(map, mapKey)) {
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
        }
      } catch (err) {
        console.error('[map] init/render failed:', err);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotted.map((f) => `${f.id}:${f.rlat}`).join(','), mapKey]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
      <div ref={containerRef} className="z-0 h-96 w-full" />
      <div className="px-4 py-2 text-xs text-slate-400 dark:text-slate-500">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: PIN_COLORS.great }} />do 14 dni</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: PIN_COLORS.ok }} />do 45 dni</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: PIN_COLORS.slow }} />do 120 dni</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: PIN_COLORS.bad }} />dłużej</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: PIN_COLORS.unknown }} />brak danych</span>
        </div>
        {plotted.length} z {facilities.length} placówek na mapie
        {resolving && ' · geokoduję adresy…'}
        {pending.length > 0 && ` · pozostało ${pending.length} adresów`}
        {' · współrzędne: NFZ + OpenStreetMap (przybliżone)'}
      </div>
    </div>
  );
}

const lastFit = new Map<LType.Map, string>();
function mapKeyChanged(map: LType.Map, key: string): boolean {
  if (lastFit.get(map) === key) return false;
  lastFit.set(map, key);
  return true;
}


