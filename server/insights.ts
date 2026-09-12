/**
 * Raport ogólnopolski — agregaty z lokalnej bazy snapshotów NFZ.
 * Zero dodatkowych zapytań do NFZ: liczymy z tego, co sync już zebrał.
 */

import { getSnapshots, trackedBenefits } from './db';
import { PROVINCES } from './nfz';
import { toFacility } from '../src/lib/wait';
import type { Facility } from '../src/lib/types';

export const REPORT_BENEFITS: { benefit: string; label: string }[] = [
  { benefit: 'ODDZIAŁ KARDIOLOGICZNY', label: 'Kardiologia' },
  { benefit: 'ODDZIAŁ CHIRURGII URAZOWO-ORTOPEDYCZNEJ', label: 'Ortopedia i urazy' },
  { benefit: 'ODDZIAŁ NEUROLOGICZNY', label: 'Neurologia' },
  { benefit: 'ODDZIAŁ OKULISTYCZNY', label: 'Okulistyka' },
  { benefit: 'ODDZIAŁ OTORYNOLARYNGOLOGICZNY', label: 'Laryngologia' },
  { benefit: 'ODDZIAŁ REUMATOLOGICZNY', label: 'Reumatologia' },
  { benefit: 'ODDZIAŁ CHIRURGII ONKOLOGICZNEJ', label: 'Chirurgia onkologiczna' },
  { benefit: 'PORADNIA STOMATOLOGICZNA', label: 'Stomatologia' },
];

export type InsightItem = {
  benefit: string;
  label: string;
  facilities: number;
  awaitingTotal: number;
  avgDays: number | null;
  minDays: number | null;
  maxDays: number | null;
  zeroShare: number | null; // udział placówek z kolejką "0 dni" (0–1)
  worstProvince: string | null;
};

export type InsightsReport = {
  generatedAt: string;
  items: InsightItem[];
};

export function computeInsights(): InsightsReport {
  const items: InsightItem[] = [];

  for (const { benefit, label } of REPORT_BENEFITS) {
    const snaps = getSnapshots(benefit, 1);
    const facilities: Facility[] = [];
    const provName = (code: string) => PROVINCES.find((p) => p.code === code)?.name ?? code;
    for (const s of snaps) {
      for (const rec of s.records) {
        const f = toFacility(rec as Record<string, unknown>, s.code, provName(s.code));
        if (f) facilities.push(f);
      }
    }
    if (facilities.length === 0) continue;

    const withDays = facilities.filter((f) => f.days !== null) as (Facility & { days: number })[];
    const avgDays =
      withDays.length > 0
        ? Math.round(withDays.reduce((sum, f) => sum + f.days, 0) / withDays.length)
        : null;
    const minDays = withDays.length > 0 ? Math.min(...withDays.map((f) => f.days)) : null;
    const maxDays = withDays.length > 0 ? Math.max(...withDays.map((f) => f.days)) : null;
    const zeroShare =
      facilities.length > 0
        ? facilities.filter((f) => f.days === 0).length / facilities.length
        : null;
    const awaitingTotal = facilities.reduce((sum, f) => sum + (f.awaiting ?? 0), 0);

    // województwo z najdłuższym średnim czasem (min. 3 placówki, żeby nie brać przypadkowych)
    const byProvince = new Map<string, { sum: number; n: number }>();
    for (const f of withDays) {
      const cur = byProvince.get(f.provinceName) ?? { sum: 0, n: 0 };
      cur.sum += f.days;
      cur.n += 1;
      byProvince.set(f.provinceName, cur);
    }
    let worstProvince: string | null = null;
    let worstAvg = -1;
    for (const [name, v] of byProvince) {
      if (v.n < 3) continue;
      const avg = v.sum / v.n;
      if (avg > worstAvg) {
        worstAvg = avg;
        worstProvince = name;
      }
    }

    items.push({
      benefit,
      label,
      facilities: facilities.length,
      awaitingTotal,
      avgDays,
      minDays,
      maxDays,
      zeroShare,
      worstProvince,
    });
  }

  return { generatedAt: new Date().toISOString(), items };
}

export function reportCoverage(): number {
  const tracked = new Set(trackedBenefits());
  return REPORT_BENEFITS.filter((b) => tracked.has(b.benefit)).length;
}
