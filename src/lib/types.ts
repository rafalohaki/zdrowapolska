/** Typy współdzielone przez komponenty frontendu. */

/** Surowy atrybut rekordu kolejki z API NFZ (klucze mają myślniki — dostęp indeksowy). */
export type NfzAttributes = Record<string, unknown>;

export type NfzRecord = {
  id?: string;
  attributes?: NfzAttributes;
};

export type ProvinceData = {
  code: string;
  name: string;
  total: number;
  records: NfzRecord[];
  /** 'db' = świeży snapshot, 'stale' = przeterminowany (awaria NFZ), 'nfz' = żywe */
  source?: 'db' | 'stale' | 'nfz';
  /** przy source==='stale' — moment pobrania danych */
  fetchedAt?: string;
};

/** Parsed placówka gotowa do wyświetlenia. */
export type Facility = {
  id: string;
  provider: string;
  benefit: string;
  locality: string;
  address: string;
  phone: string;
  /** współrzędne NFZ (często null); geo='miss' gdy Nominatim nie znalazł adresu */
  lat: number | null;
  lon: number | null;
  geo: { lat: number; lon: number } | 'miss' | null;
  province: string;
  provinceName: string;
  /** oczekujący w dniach wg PCUS / average-period; null = brak danych */
  days: number | null;
  /** prognoza PCUS jako tekst NFZ ("0 dni", "2 miesiące") */
  waitLabel: string | null;
  awaiting: number | null;
  statsUpdate: string | null;
  situationAsAt: string | null;
  flags: {
    ramp: boolean;
    elevator: boolean;
    toilet: boolean;
    wheelchairs: boolean;
    ac: boolean;
    automaticDoor: boolean;
    bus: boolean;
    forChildren: boolean;
  };
};

export type AiResponse = {
  text: string;
  provider: string;
};

/** Placówka GSL NFZ (apteki, SOR, izby przyjęć, nocna pomoc). */
export type GslFacility = {
  name: string;
  address: string;
  phone: string;
};

export type GslResult = {
  category: string;
  province: string;
  total: number;
  results: GslFacility[];
  page: number;
  /** true = ostatnia znana lista z bazy (GSL NFZ nie odpowiada) */
  stale?: boolean;
  fetchedAt?: string;
};

export const GSL_CATEGORY_GROUPS = [
  { key: 'leczenie', label: 'Wizyty i leczenie' },
  { key: 'pomoc', label: 'Pomoc doraźna' },
  { key: 'apteki', label: 'Apteki' },
  { key: 'programy', label: 'Programy i pozostałe' },
] as const;

export const GSL_CATEGORIES = [
  { key: 'poz', label: 'POZ — rodzinny lekarz', group: 'leczenie' },
  { key: 'aos', label: 'Przychodnie specjalistyczne (AOS)', group: 'leczenie' },
  { key: 'szpitale', label: 'Szpitale i opieka całodobowa', group: 'leczenie' },
  { key: 'stomatologia', label: 'Leczenie stomatologiczne', group: 'leczenie' },
  { key: 'diagnostyka', label: 'Badania diagnostyczne', group: 'leczenie' },
  { key: 'sor', label: 'SOR', group: 'pomoc' },
  { key: 'izba', label: 'Izby przyjęć', group: 'pomoc' },
  { key: 'nocna', label: 'Nocna i świąteczna pomoc', group: 'pomoc' },
  { key: 'pomocMedyczna', label: 'Pomoc medyczna nagła', group: 'pomoc' },
  { key: 'ambulatoryjne', label: 'Ambulatoryjna pomoc doraźna', group: 'pomoc' },
  { key: 'apteki', label: 'Apteki (z receptą)', group: 'apteki' },
  { key: 'zpo', label: 'Zaopatrzenie (ortopedia, optyka)', group: 'programy' },
  { key: 'profilaktyka', label: 'Programy profilaktyczne', group: 'programy' },
  { key: 'programyLekowe', label: 'Programy lekowe', group: 'programy' },
  { key: 'opieka', label: 'Opieka koordynowana', group: 'programy' },
  { key: 'onkologia', label: 'Szybka ścieżka onkologiczna (DiLO)', group: 'programy' },
  { key: 'pozostale', label: 'Pozostałe świadczenia', group: 'programy' },
] as const;

export type GslCategoryKey = (typeof GSL_CATEGORIES)[number]['key'];

export type SortKey = 'wait' | 'awaiting' | 'name';

/** Klucze filtrów dostępności → odpowiadające pola atrybutów NFZ ("Y"/"N"). */
export const A11Y_FILTERS = [
  { key: 'ramp', label: 'Rampa', attr: 'ramp' },
  { key: 'elevator', label: 'Winda', attr: 'elevator' },
  { key: 'toilet', label: 'Toaleta dost.', attr: 'toilet' },
  { key: 'wheelchairs', label: 'Dostęp dla wózków', attr: 'wheelchairs' },
  { key: 'ac', label: 'Klimatyzacja', attr: 'ac' },
  { key: 'automaticDoor', label: 'Drzwi automat.', attr: 'automatic-door' },
  { key: 'bus', label: 'Dojazd komunikacją', attr: 'public-transport-lines' },
  { key: 'forChildren', label: 'Świadczenia dla dzieci', attr: 'benefits-for-children' },
] as const;

export type A11yKey = (typeof A11Y_FILTERS)[number]['key'];
