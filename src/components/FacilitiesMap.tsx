import { useEffect, useMemo, useRef, useState } from 'react';
import { geocodeBatch, type GeoPoint } from '../lib/api';
import type { GslFacility } from '../lib/types';
import { escapeHtml, telHref } from '../lib/html';
import { formatDaysShort, waitLevel, type WaitLevel } from '../lib/wait';
import type * as LType from 'leaflet';
import { loadLeaflet } from './leaflet-loader';

type Pin = { key: string; address: string; lat: number; lon: number; facilities: GslFacility[] };

/** Pinezka rysowana w CSS (bez zewnętrznych obrazków — bundler nie serwuje marker-icon.png). */
function makePin(L: typeof LType, dark: boolean, color = '#059669'): LType.DivIcon {
  return L.divIcon({
    className: 'zp-pin',
    html: `<span style="display:block;width:18px;height:18px;border-radius:50%;background:${color};border:3px solid ${
      dark ? '#0f172a' : '#fff'
    };box-shadow:0 1px 4px rgb(0 0 0 / .4)"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -9],
  });
}

const WAIT_DOT: Record<WaitLevel, string> = {
  great: '#059669',
  ok: '#65a30d',
  slow: '#f59e0b',
  bad: '#dc2626',
  unknown: '#64748b',
};

/** Startowy widok mapy: stolica województwa + zoom 8 (zamiast całej Polski). */
const PROVINCE_VIEW: Record<string, { at: [number, number]; zoom: number }> = {
  '01': { at: [51.11, 17.03], zoom: 8 }, // Wrocław
  '02': { at: [53.12, 18.01], zoom: 8 }, // Bydgoszcz
  '03': { at: [51.25, 22.57], zoom: 8 }, // Lublin
  '04': { at: [52.73, 15.23], zoom: 8 }, // Gorzów Wlkp.
  '05': { at: [51.76, 19.46], zoom: 8 }, // Łódź
  '06': { at: [50.06, 19.94], zoom: 8 }, // Kraków
  '07': { at: [52.23, 21.01], zoom: 8 }, // Warszawa
  '08': { at: [50.67, 17.92], zoom: 8 }, // Opole
  '09': { at: [50.04, 22.01], zoom: 8 }, // Rzeszów
  '10': { at: [53.13, 23.16], zoom: 8 }, // Białystok
  '11': { at: [54.35, 18.65], zoom: 8 }, // Gdańsk
  '12': { at: [50.26, 19.03], zoom: 8 }, // Katowice
  '13': { at: [50.87, 20.63], zoom: 8 }, // Kielce
  '14': { at: [53.78, 20.49], zoom: 8 }, // Olsztyn
  '15': { at: [52.41, 16.93], zoom: 8 }, // Poznań
  '16': { at: [53.43, 14.55], zoom: 8 }, // Szczecin
};
const DEFAULT_VIEW = { at: [51.92, 19.15] as [number, number], zoom: 6 };


// Cache sesji: powrót do tej samej kategorii/prowincji nie pyta backendu wcale.
// Missy też pamiętamy (backend i tak je cache'uje, ale oszczędzamy round-trip).
const geoCache = new Map<string, { lat: number; lon: number }>();
const geoMiss = new Set<string>();

const BATCH = 10; // limit endpointu /api/geocode to 20
const MAX_PINS = 40; // więcej pinezek = chaos na mapie; reszta i tak jest na liście
export function FacilitiesMap({
  facilities,
  province,
  resetKey,
  waits,
}: {
  facilities: GslFacility[];
  province: string;
  resetKey: string;
  /** Dopasowane kolejki ITL: adres → dni oczekiwania (null = nieznane) */
  waits?: Map<string, number | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType.Map | null>(null);
  const layerRef = useRef<LType.LayerGroup | null>(null);
  const markersRef = useRef(new Map<string, LType.Marker>());
  const markerWaitsRef = useRef(new Map<string, string>());
  const epochRef = useRef(0);
  const fittedRef = useRef(false); // kamera ustawiona na wyniki (raz na wyszukiwanie)
  const programmaticRef = useRef(false); // ruch mapy z kodu, nie od użytkownika
  const userMovedRef = useRef(false);
  const resetKeyRef = useRef(resetKey);
  const [pins, setPins] = useState<Pin[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [geoFailed, setGeoFailed] = useState(0); // partie, którym batch nie odpowiedział (sieć)
  const [mapReady, setMapReady] = useState(false);

  // Grupuj placówki po adresie: 1 pinezka = 1 budynek (NFZ ma wiele wpisów na ten sam adres).
  const addressGroups = useMemo(() => {
    const map = new Map<string, GslFacility[]>();
    for (const f of facilities) {
      if (!f.address) continue;
      const list = map.get(f.address);
      if (list) list.push(f);
      else map.set(f.address, [f]);
    }
    return [...map.entries()].slice(0, MAX_PINS);
  }, [facilities]);
  const addressesKey = useMemo(() => addressGroups.map(([a]) => a).join(';;'), [addressGroups]);

  // Init mapy raz: startowy widok to województwo, nie cała Polska.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!containerRef.current) return;
      const L = await loadLeaflet();
      if (!alive || !containerRef.current || mapRef.current) return;
      const start = PROVINCE_VIEW[province] ?? DEFAULT_VIEW;
      const map = L.map(containerRef.current).setView(start.at, start.zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 18,
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      // Leaflet nadaje zoomom angielskie title/aria-label — polska aplikacja
      for (const el of map.getContainer().querySelectorAll<HTMLElement>('.leaflet-bar a')) {
        if (el.classList.contains('leaflet-control-zoom-in')) {
          el.title = 'Przybliż';
          el.setAttribute('aria-label', 'Przybliż');
        } else if (el.classList.contains('leaflet-control-zoom-out')) {
          el.title = 'Oddal';
          el.setAttribute('aria-label', 'Oddal');
        }
      }
      map.on('movestart zoomstart', () => {
        if (!programmaticRef.current) userMovedRef.current = true;
      });
      map.on('moveend zoomend', () => {
        programmaticRef.current = false;
      });
      mapRef.current = map;
      setMapReady(true);
    })();
    return () => {
      alive = false;
      // unmount: remove() zdejmuje listenery window/document i zwalnia instancję mapy
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      markerWaitsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nowe wyszukiwanie (inna kategoria / województwo / nazwa): wyczyść, leć do województwa.
  // Doklejanie przez „Pokaż więcej" nie rusza kamery ani istniejących pinezek.
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    epochRef.current += 1;
    fittedRef.current = false;
    userMovedRef.current = false;
    markersRef.current.clear();
    markerWaitsRef.current.clear();
    layerRef.current?.clearLayers();
    setPins([]);
    const map = mapRef.current;
    if (map) {
      const start = PROVINCE_VIEW[province] ?? DEFAULT_VIEW;
      programmaticRef.current = true;
      map.setView(start.at, start.zoom);
    }
  }, [resetKey, province]);

  // Geokodowanie: tylko adresy spoza cache sesji, partiami; pinezki doklejają się na żywo.
  useEffect(() => {
    const epoch = ++epochRef.current;
    const ctrl = new AbortController();
    const groups = addressGroups;
    const pending = groups.filter(([a]) => !geoCache.has(a) && !geoMiss.has(a));
    setGeoFailed(0);
    const cachedPins: Pin[] = [];
    for (const [address, group] of groups) {
      const hit = geoCache.get(address);
      if (hit) cachedPins.push({ key: address, address, lat: hit.lat, lon: hit.lon, facilities: group });
    }
    setPins(cachedPins);
    setProgress({ done: groups.length - pending.length, total: groups.length });
    if (pending.length === 0) return () => ctrl.abort();

    void (async () => {
      const collected: Pin[] = [...cachedPins];
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        let res: (GeoPoint | null)[];
        try {
          res = await geocodeBatch(
            batch.map(([address]) => address),
            ctrl.signal,
          );
        } catch {
          if (ctrl.signal.aborted || epochRef.current !== epoch) return;
          res = [];
          // nie wrzucaj do geoMiss — to błąd sieci, nie „adres nieznany";
          // licznik trafia do podpisu zamiast znikać z paska postępu
          setGeoFailed((n) => n + batch.length);
        }
        if (epochRef.current !== epoch || ctrl.signal.aborted) return;
        res.forEach((point, j) => {
          const [address, group] = batch[j];
          if (!address || !group) return;
          if (point) {
            geoCache.set(address, { lat: point.lat, lon: point.lon });
            collected.push({ key: address, address, lat: point.lat, lon: point.lon, facilities: group });
          } else {
            geoMiss.add(address);
          }
        });
        if (epochRef.current !== epoch || ctrl.signal.aborted) return;
        setPins([...collected]);
        setProgress({ done: groups.length - pending.length + Math.min(i + BATCH, pending.length), total: groups.length });
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressesKey, resetKey]);

  // Render pinezek: dokładaj/usuwaj po kluczu; kamerę ustaw raz (chyba że użytkownik sam ruszył).
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    void loadLeaflet().then((L) => {
      if (mapRef.current !== map) return;
      const wanted = new Set(pins.map((p) => p.key));
      for (const [key, marker] of markersRef.current) {
        if (!wanted.has(key)) {
          layer.removeLayer(marker);
          markersRef.current.delete(key);
        }
      }
      const dark = document.documentElement.classList.contains('dark');
      const fresh: [number, number][] = [];
      for (const p of pins) {
        if (markersRef.current.has(p.key)) {
          // kolejki dociągają się później niż pinezki — odśwież kolor gdy doszły
          const wantDays = waits?.has(p.address) ? String(waits.get(p.address)) : 'none';
          if (markerWaitsRef.current.get(p.key) !== wantDays) {
            const old = markersRef.current.get(p.key)!;
            layer.removeLayer(old);
            markersRef.current.delete(p.key);
          } else {
            continue;
          }
        }
        const names = p.facilities.map((f) => escapeHtml(f.name));
        const label = names.length === 1 ? names[0] : `${names[0]} <em>(+${names.length - 1} więcej)</em>`;
        const phone = p.facilities.find((f) => f.phone)?.phone;
        const days = waits?.get(p.address) ?? null;
        const hasWaits = waits !== undefined && waits.size > 0;
        const dot = hasWaits ? WAIT_DOT[waitLevel(days)] : undefined;
        const waitLine =
          days !== null && days !== undefined
            ? `<br>Kolejka: <strong>${escapeHtml(formatDaysShort(days))}</strong>`
            : '';
        const marker = L.marker([p.lat, p.lon], { icon: makePin(L, dark, dot) }).bindPopup(
          `${label}<br>${escapeHtml(p.address)}${waitLine}${
            phone ? `<br><a href="tel:${telHref(phone)}">${escapeHtml(phone)}</a>` : ''
          }`,
        );
        layer.addLayer(marker);
        markersRef.current.set(p.key, marker);
        markerWaitsRef.current.set(p.key, waits?.has(p.address) ? String(waits.get(p.address)) : 'none');
        fresh.push([p.lat, p.lon]);
      }
      // Pozycjonowanie: raz na wyszukiwanie i tylko jeśli użytkownik nie przejął mapy.
      if (!fittedRef.current && pins.length > 0 && !userMovedRef.current) {
        fittedRef.current = true;
        programmaticRef.current = true;
        if (pins.length === 1) map.setView([pins[0].lat, pins[0].lon], 13);
        else map.fitBounds(pins.map((p) => [p.lat, p.lon] as [number, number]), { padding: [40, 40], maxZoom: 13 });
      } else if (fresh.length > 0 && userMovedRef.current) {
        // użytkownik ogląda wybrany fragment — nic nie ruszamy
      }
    });
  }, [pins, waits]);

  if (facilities.length === 0) return null;

  const active = progress.total > 0 && progress.done < progress.total;

  return (
    <div className="no-print mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card dark:border-slate-800 dark:bg-slate-900">
      <div className="relative">
        {!mapReady && (
          <div className="flex h-72 w-full animate-pulse items-center justify-center bg-slate-100 text-sm text-slate-400 dark:bg-slate-800">
            Ładowanie mapy…
          </div>
        )}
        <div ref={containerRef} className="z-0 h-72 w-full" />
        {active && (
          <div className="absolute inset-x-0 top-0 h-1 bg-slate-200/70 dark:bg-slate-700/70">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        )}
      </div>
      <p className="px-4 py-2 text-xs text-slate-400 dark:text-slate-500">
        {active
          ? `Ustalam współrzędne… ${progress.done}/${progress.total}`
          : pins.length > 0
            ? `Mapa: ${pins.length} pinezek z ${progress.total} adresów — współrzędne cache'owane.`
            : progress.total > 0
              ? `Nie udało się ustalić współrzędnych dla tych adresów.${geoFailed > 0 ? ` (błąd sieci: ${geoFailed})` : ''}`
              : 'Mapa: OpenStreetMap (Nominatim).'}
        {!active && pins.length > 0 && geoFailed > 0 && (
          <span className="text-amber-600 dark:text-amber-400"> · {geoFailed} adresów pominięto po błędzie sieci</span>
        )}
        {waits !== undefined && waits.size > 0 && !active && (
          <>
            {' '}Kolory pinezek to czas kolejki:{' '}
            <span style={{ color: WAIT_DOT.great }}>● ≤14 dni</span>
            {' · '}
            <span style={{ color: WAIT_DOT.ok }}>● ≤45 dni</span>
            {' · '}
            <span style={{ color: WAIT_DOT.slow }}>● ≤4 mies.</span>
            {' · '}
            <span style={{ color: WAIT_DOT.bad }}>● dłużej</span>
            {' · '}
            <span style={{ color: WAIT_DOT.unknown }}>● brak danych</span>.
          </>
        )}
      </p>
    </div>
  );
}
