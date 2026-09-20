import { useEffect, useRef, useState } from 'react';
import { Logo, MoonIcon, SunIcon } from './Icons';
import { getInstallPrompt, isStandalone, onInstallPrompt } from '../lib/pwa';

import type { AppMode } from '../lib/search';
export type { AppMode };

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('zp_theme', next ? 'dark' : 'light');
    } catch {}
  };

  return (
    <button
      type="button"
      id="theme-toggle" onClick={toggle}
      aria-label={dark ? 'Włącz tryb jasny' : 'Włącz tryb ciemny'}
      className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:border-brand-300 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-brand-500"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function InstallButton() {
  const [ready, setReady] = useState(() => getInstallPrompt() !== null);
  useEffect(() => onInstallPrompt(() => setReady(getInstallPrompt() !== null)), []);
  if (!ready || isStandalone()) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        const p = getInstallPrompt();
        if (!p) return;
        await p.prompt();
        setReady(false);
      }}
      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700"
    >
      Zainstaluj
    </button>
  );
}

const MODES: { key: AppMode; label: string }[] = [
  { key: 'terminy', label: 'Terminy leczenia' },
  { key: 'raport', label: 'Raport PL' },
  { key: 'wsparcie', label: 'Wsparcie psychiczne' },
  { key: 'powietrze', label: 'Jakość powietrza' },
  { key: 'placowki', label: 'Placówki NFZ' },
];

/** Menu mobilne — bez niego na telefonie były tylko 2 z 5 trybów. */
function MobileMenu({
  mode,
  onMode,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative md:hidden">
      <button
        type="button"
        aria-label="Menu nawigacji"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:border-brand-300 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
          {open ? (
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lift dark:border-slate-700 dark:bg-slate-900"
        >
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onMode(m.key);
              }}
              className={`block w-full px-4 py-2.5 text-left text-sm transition ${
                mode === m.key
                  ? 'bg-brand-50 font-semibold text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
                  : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              {m.label}
            </button>
          ))}
          <a
            href="https://dane.gov.pl"
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            className="block px-4 py-2.5 text-left text-sm text-slate-700 transition hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Dane otwarte ↗
          </a>
        </div>
      )}
    </div>
  );
}

export function Header({
  mode,
  onMode,
  onHome,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
  onHome: () => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-slate-50/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <button type="button" onClick={onHome} className="flex items-center gap-2.5">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">
            Zdrowa<span className="text-brand-600 dark:text-brand-400">Polska</span>
          </span>
        </button>
        <nav className="flex items-center gap-4 text-sm font-medium text-slate-600 dark:text-slate-300">
          <button
            type="button"
            id="nav-terminy" onClick={() => onMode('terminy')}
            className={`hidden transition md:block ${
              mode === 'terminy' ? 'text-brand-700 dark:text-brand-400' : 'hover:text-brand-700 dark:hover:text-brand-400'
            }`}
          >
            Terminy leczenia
          </button>
          <button
            type="button"
            id="nav-raport" onClick={() => onMode('raport')}
            className={`hidden transition md:block ${
              mode === 'raport' ? 'text-brand-700 dark:text-brand-400' : 'hover:text-brand-700 dark:hover:text-brand-400'
            }`}
          >
            Raport PL
          </button>
          <button
            type="button"
            id="nav-wsparcie" onClick={() => onMode('wsparcie')}
            className={`hidden transition md:block ${
              mode === 'wsparcie' ? 'text-brand-700 dark:text-brand-400' : 'hover:text-brand-700 dark:hover:text-brand-400'
            }`}
          >
            Wsparcie psychiczne
          </button>
          <button
            type="button"
            onClick={() => onMode('powietrze')}
            className={`hidden transition md:block ${
              mode === 'powietrze' ? 'text-brand-700 dark:text-brand-400' : 'hover:text-brand-700 dark:hover:text-brand-400'
            }`}
          >
            Jakość powietrza
          </button>
          <button
            type="button"
            id="nav-placowki" onClick={() => onMode('placowki')}
            className={`hidden transition md:block ${
              mode === 'placowki' ? 'text-brand-700 dark:text-brand-400' : 'hover:text-brand-700 dark:hover:text-brand-400'
            }`}
          >
            Placówki NFZ
          </button>
          <a
            href="https://dane.gov.pl"
            target="_blank"
            rel="noreferrer"
            className="hidden transition hover:text-brand-700 dark:hover:text-brand-400 md:block"
          >
            Dane otwarte
          </a>
          <InstallButton />
          <ThemeToggle />
          <MobileMenu mode={mode} onMode={onMode} />
        </nav>
      </div>
    </header>
  );
}


export function Footer() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-slate-500 dark:text-slate-400">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <Logo className="h-6 w-6" />
            <span className="font-semibold text-slate-700 dark:text-slate-200">ZdrowaPolska</span>
          </div>
          <p className="text-xs">
            Źródło danych: <span className="font-medium text-slate-600 dark:text-slate-300">Narodowy Fundusz Zdrowia — API „Terminy Leczenia"</span> (aktualizacje
            miesięczne)
          </p>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Projekt hackathonowy. Aplikacja pokazuje oficjalne statystyki kolejek (w tym prognozę PCUS),
          a nie konkretne wolne terminy wizyt — ostateczną dostępność potwierdź telefonicznie w placówce.
          Serwis nie stanowi porady medycznej; w nagłych przypadkach dzwoń na 112 lub 999.
        </p>
      </div>
    </footer>
  );
}

export function AboutSection() {
  return (
    <section id="o-projekcie" className="mx-auto mt-16 max-w-6xl scroll-mt-20 px-4">
      <h2 className="text-center text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Jak to działa?</h2>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card dark:border-slate-800 dark:bg-slate-900">
          <span className="text-2xl">🏛️</span>
          <h3 className="mt-3 font-semibold text-slate-900 dark:text-white">Oficjalne dane NFZ</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Korzystamy z publicznego API NFZ „Terminy Leczenia": liczba osób w kolejce, średni czas
            oczekiwania i prognoza PCUS dla tysięcy placówek w 16 oddziałach wojewódzkich.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card dark:border-slate-800 dark:bg-slate-900">
          <span className="text-2xl">⚖️</span>
          <h3 className="mt-3 font-semibold text-slate-900 dark:text-white">Porównanie, nie rezerwacja</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            NFZ publikuje statystyki kolejek (aktualizowane miesięcznie), a nie wolne sloty. Dlatego
            pokazujemy, <strong>gdzie kolejka jest najkrótsza</strong> — i jak do tego porównania doszło.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card dark:border-slate-800 dark:bg-slate-900">
          <span className="text-2xl">♿</span>
          <h3 className="mt-3 font-semibold text-slate-900 dark:text-white">Dostępność i AI</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Filtrujesz placówki po rampie, windzie, toalecie dostosowanej i dojeździe komunikacją, a
            doradca AI podsumowuje dane i podpowiada wybór. Zawsze z zastrzeżeniem: to nie porada
            medyczna.
          </p>
        </div>
      </div>
    </section>
  );
}
