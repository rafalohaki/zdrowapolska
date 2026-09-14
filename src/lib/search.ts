import type { A11yKey, Facility, SortKey } from './types';

export type AppMode = 'terminy' | 'placowki' | 'raport' | 'wsparcie' | 'powietrze';

export function modeFromUrl(search: string): AppMode {
  if (search.includes('mode=wsparcie')) return 'wsparcie';
  if (search.includes('mode=placowki')) return 'placowki';
  if (search.includes('mode=raport')) return 'raport';
  if (search.includes('mode=powietrze')) return 'powietrze';
  return 'terminy';
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

export function paramsToState(search: string): SearchState {
  const p = new URLSearchParams(search);
  const kase = p.get('c') === '2' ? 2 : 1;
  const sort = (['wait', 'awaiting', 'name'] as const).find((s) => s === p.get('s')) ?? 'wait';
  const a11y = (p.get('a') ?? '')
    .split(',')
    .filter((x): x is A11yKey => x.length > 0);
  return {
    benefit: p.get('b') ?? '',
    locality: p.get('m') ?? '',
    province: p.get('p') ?? 'all',
    kase,
    a11y,
    sort,
    view: (['ranking', 'mapa', 'compare'] as const).find((v) => v === p.get('v')) ?? 'ranking',
  };
}

export function syncUrl(s: SearchState, mode: AppMode = 'terminy') {
  const params = stateToParams(s);
  if (mode !== 'terminy') params.set('mode', mode);
  const qs = params.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}`;
  history.replaceState(null, '', url);
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
