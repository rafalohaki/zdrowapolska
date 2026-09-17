import { A11Y_FILTERS, type A11yKey, type Facility, type SortKey } from './types';
import { PROVINCES } from './provinces';

export type AppMode = 'terminy' | 'placowki' | 'raport' | 'wsparcie' | 'powietrze';

export function modeFromUrl(search: string): AppMode {
  // właściwe parsowanie: substring match łapał też ?xmode=wsparcie i mode=wsparcie2
  const m = new URLSearchParams(search).get('mode');
  return m === 'wsparcie' || m === 'placowki' || m === 'raport' || m === 'powietrze'
    ? m
    : 'terminy';
}
export type SearchState = {
  benefit: string;
  locality: string; // opcjonalna miejscowość (filtr „Gdzie" z GSL NFZ)
  province: string; // 'all' | kod NFZ
  kase: 1 | 2;
  a11y: A11yKey[];
  sort: SortKey;
  view: 'ranking' | 'mapa' | 'compare';
};

export const DEFAULT_STATE: SearchState = {
  benefit: '',
  locality: '',
  province: 'all',
  kase: 1,
  a11y: [],
  sort: 'wait',
  view: 'ranking',
};

export function stateToParams(s: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.benefit) p.set('b', s.benefit);
  if (s.locality) p.set('m', s.locality);
  if (s.province !== 'all') p.set('p', s.province);
  if (s.kase !== 1) p.set('c', String(s.kase));
  if (s.a11y.length) p.set('a', s.a11y.join(','));
  if (s.sort !== 'wait') p.set('s', s.sort);
  if (s.view !== 'ranking') p.set('v', s.view);
  return p;
}

const PROVINCE_CODES = new Set<string>(PROVINCES.map((p) => p.code));
const A11Y_KEYS = new Set<string>(A11Y_FILTERS.map((f) => f.key));

export function paramsToState(search: string): SearchState {
  const p = new URLSearchParams(search);
  const kase = p.get('c') === '2' ? 2 : 1;
  const sort = (['wait', 'awaiting', 'name'] as const).find((s) => s === p.get('s')) ?? 'wait';
  // walidacja: ?p=99 / ?a=foo w URL-u dawały ciche puste wyniki bez żadnego komunikatu
  const province = p.get('p') ?? 'all';
  const a11y = (p.get('a') ?? '')
    .split(',')
    .filter((x): x is A11yKey => A11Y_KEYS.has(x));
  return {
    benefit: p.get('b') ?? '',
    locality: p.get('m') ?? '',
    province: PROVINCE_CODES.has(province) ? province : 'all',
    kase,
    a11y,
    sort,
    view: (['ranking', 'mapa', 'compare'] as const).find((v) => v === p.get('v')) ?? 'ranking',
  };
}

export function syncUrl(s: SearchState, mode: AppMode = 'terminy', push = false) {
  const params = stateToParams(s);
  if (mode !== 'terminy') params.set('mode', mode);
  const qs = params.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}`;
  // push przy świadomym nowym wyszukiwaniu — „wstecz" wraca do poprzednich wyników;
  // replace przy zmianach filtrów — nie śmiecimy historii każdym checkboxem
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}
/** Filtr dostępności: wszystkie zaznaczone warunki muszą być spełnione. */
export function matchesA11y(f: Facility, required: A11yKey[]): boolean {
  return required.every((key) => f.flags[key]);
}

export function sortFacilities(facilities: Facility[], sort: SortKey): Facility[] {
  const arr = [...facilities];
  if (sort === 'wait') {
    arr.sort((a, b) => {
      const da = a.days ?? 9_999_999;
      const db = b.days ?? 9_999_999;
      return da - db || (a.awaiting ?? 9e9) - (b.awaiting ?? 9e9) || a.provider.localeCompare(b.provider, 'pl');
    });
  } else if (sort === 'awaiting') {
    arr.sort((a, b) => {
      const aa = a.awaiting ?? 9e9;
      const ab = b.awaiting ?? 9e9;
      return aa - ab || (a.days ?? 9_999_999) - (b.days ?? 9_999_999);
    });
  } else {
    arr.sort((a, b) => a.provider.localeCompare(b.provider, 'pl'));
  }
  return arr;
}
