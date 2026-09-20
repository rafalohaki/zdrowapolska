import { A11Y_FILTERS, type Facility } from './types';

// PL Excel rozumie UTF-8 dopiero z BOM i domyślnie rozdziela pola średnikiem
const esc = (v: string | number | null | undefined): string => {
  let s = v === null || v === undefined ? '' : String(v);
  // neutralizacja formuł: komórka od [=+\-@] (np. telefon „+48 22…") Excel
  // traktuje jako formułę → #NAME? i podatność formula-injection na danych NFZ
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Ranking placówek → CSV (dla lekarza POZ / druku roboczego). */
export function facilitiesCsv(facilities: Facility[]): string {
  // nagłówki z diakrytykami — plik otwierają głównie ludzie (Excel z BOM-em
  // świetnie czyta UTF-8; dane i tak już są z polskimi znakami)
  const head = [
    'rank',
    'placówka',
    'świadczenie',
    'województwo',
    'miejscowość',
    'adres',
    'telefon',
    'oczekujący',
    'czas_dni',
    'udogodnienia',
  ];
  const rows = facilities.map((f, i) => [
    i + 1,
    f.provider,
    f.benefit,
    f.provinceName,
    f.locality,
    f.address,
    f.phone,
    f.awaiting,
    f.days,
    A11Y_FILTERS.filter((x) => f.flags[x.key])
      .map((x) => x.label)
      .join(' '),
  ]);
  return '\uFEFF' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');

}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // odroczona rewokacja — synchroniczna kasowała pobieranie w starszych Safari/Firefox
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
