import { A11Y_FILTERS, type Facility } from './types';

// PL Excel rozumie UTF-8 dopiero z BOM i domyślnie rozdziela pola średnikiem
const esc = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Ranking placówek → CSV (dla lekarza POZ / druku roboczego). */
export function facilitiesCsv(facilities: Facility[]): string {
  const head = [
    'rank',
    'placowka',
    'swiadczenie',
    'wojewodztwo',
    'miejscowosc',
    'adres',
    'telefon',
    'oczekujacy',
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
  URL.revokeObjectURL(url);
}
