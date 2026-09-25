import type { WaitLevel } from './wait';

/**
 * Jeden kanon kolorów poziomów oczekiwania dla całej aplikacji — mapy czytają
 * surowe hexy (inline HTML w Leaflet divIcon + legenda), UI klasy Tailwind.
 * Hue-wise spójnie: „długa kolejka" wszędzie rose (nie red), „brak danych"
 * wszędzie ten sam slate #64748b (≥3:1 na bieli jako kropka legendy i na
 * slate-900 w dark mode).
 */

/** Hexy pinezek/kropek na mapach (TerminyMap, FacilitiesMap + legendy). */
export const WAIT_PIN_COLORS: Record<WaitLevel, string> = {
  great: '#059669',
  ok: '#65a30d',
  slow: '#f59e0b',
  bad: '#f43f5e',
  unknown: '#64748b',
};

/** Miękkie pigułki WaitBadge — tinty zamiast solidów (biały tekst na lime-500
 *  miał kontrast ~2:1, poniżej AA). */
export const WAIT_BADGE_CLASSES: Record<WaitLevel, string> = {
  great: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  ok: 'bg-lime-100 text-lime-800 dark:bg-lime-500/15 dark:text-lime-300',
  slow: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  bad: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  unknown: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

/** Pigułki „Kolejka: N dni" (FacilitiesView) — jeszcze jaśniejsze tinty. */
export const WAIT_PILL_CLASSES: Record<WaitLevel, string> = {
  great: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  ok: 'bg-lime-50 text-lime-700 dark:bg-lime-500/10 dark:text-lime-300',
  slow: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  bad: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
  unknown: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

/** Solidne słupki wykresu porównania (CompareChart). */
export const WAIT_BAR_CLASSES: Record<WaitLevel, string> = {
  great: 'bg-emerald-500',
  ok: 'bg-lime-500',
  slow: 'bg-amber-400',
  bad: 'bg-rose-500',
  unknown: 'bg-slate-300 dark:bg-slate-600',
};
