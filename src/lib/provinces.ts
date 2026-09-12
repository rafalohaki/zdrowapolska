/** Kody oddziałów NFZ (nie TERYT!) — patrz docs/01-zdrowie.md */
export const PROVINCES = [
  { code: '01', name: 'dolnośląskie' },
  { code: '02', name: 'kujawsko-pomorskie' },
  { code: '03', name: 'lubelskie' },
  { code: '04', name: 'lubuskie' },
  { code: '05', name: 'łódzkie' },
  { code: '06', name: 'małopolskie' },
  { code: '07', name: 'mazowieckie' },
  { code: '08', name: 'opolskie' },
  { code: '09', name: 'podkarpackie' },
  { code: '10', name: 'podlaskie' },
  { code: '11', name: 'pomorskie' },
  { code: '12', name: 'śląskie' },
  { code: '13', name: 'świętokrzyskie' },
  { code: '14', name: 'warmińsko-mazurskie' },
  { code: '15', name: 'wielkopolskie' },
  { code: '16', name: 'zachodniopomorskie' },
] as const;

export type ProvinceCode = (typeof PROVINCES)[number]['code'];

export const provinceName = (code: string): string =>
  PROVINCES.find((p) => p.code === code)?.name ?? code;
