import type * as LType from 'leaflet';

// Leaflet ładowany leniwie — ~150 KB nie trafia do głównego bundle'a,
// dopóki użytkownik realnie nie otworzy mapy.
let leafletPromise: Promise<typeof LType> | null = null;
export function loadLeaflet(): Promise<typeof LType> {
  if (!leafletPromise) {
    leafletPromise = Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(
      ([L]) => L,
    );
  }
  return leafletPromise;
}
