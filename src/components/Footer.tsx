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
      className="rounded-lg border border-slate-200 p-2.5 min-h-10 min-w-10 text-slate-500 transition hover:border-brand-300 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-brand-500"
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function InstallButton() {
  const [ready, setReady] = useState(() => getInstallPrompt() !== null);
  const [showIosHint, setShowIosHint] = useState(false);
  useEffect(() => onInstallPrompt(() => setReady(getInstallPrompt() !== null)), []);
  if (isStandalone()) return null;
  // iOS Safari nie emituje beforeinstallprompt — instalacja tylko ręcznie
  // przez „Udostępnij → Dodaj do ekranu początkowego"; pokaż podpowiedź
  const ios = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
  if (!ready && !ios) return null;
  return (
    <span className="relative">
      <button
        type="button"
        onClick={async () => {
          const p = getInstallPrompt();
          if (!p) {
            setShowIosHint((v) => !v);
            return;
          }
          await p.prompt();
          setReady(false);
        }}
        className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
      >
        Zainstaluj
      </button>
      {showIosHint && (
        <span className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-3 text-left text-xs leading-relaxed text-slate-600 shadow-card dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          Na iPhonie: otwórz <strong>Udostępnij</strong> (ikona kwadratu ze strzałką) i wybierz
          <strong> „Dodaj do ekranu początkowego"</strong>.
        </span>
      )}
    </span>
  );
}

const MODES: { key: AppMode; label: string }[] = [
  { key: 'terminy', label: 'Terminy leczenia' },
  { key: 'raport', label: 'Raport PL' },
  { key: 'wsparcie', label: 'Wsparcie psychiczne' },
  { key: 'powietrze', label: 'Jakość powietrza' },
  { key: 'placowki', label: 'Placówki NFZ' },
];

/** Menu mobilne — pokazuje wszystkie tryby, gdy nie mieszczą się na pasku (do lg). */
function MobileMenu({
  mode,
  onMode,
}: {
  mode: AppMode;
  onMode: (m: AppMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // po otwarciu fokus wchodzi do menu (wzorzec menu), po Escape wraca na trigger
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []),
    ];
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <div ref={ref} className="relative lg:hidden">
      <button
        type="button"
        ref={triggerRef}
        aria-label="Menu nawigacji"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-200 p-2.5 min-h-10 min-w-10 text-slate-600 transition hover:border-brand-300 hover:text-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
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
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKey}
          className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lift dark:border-slate-700 dark:bg-slate-900"
        >
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              aria-current={mode === m.key ? 'page' : undefined}
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
        <nav className="flex items-center gap-3 text-sm font-medium text-slate-600 dark:text-slate-300 md:gap-4">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              id={`nav-${m.key}`}
              onClick={() => onMode(m.key)}
              aria-current={mode === m.key ? 'page' : undefined}
              className={`hidden whitespace-nowrap transition ${
                // najdłuższe etykiety od lg — na md łamały wiersz nawigacji;
                // do lg sięga wtedy hamburger (MobileMenu)
                m.key === 'wsparcie' || m.key === 'powietrze' ? 'lg:block' : 'md:block'
              } ${
                mode === m.key
                  ? 'font-semibold text-brand-700 dark:text-brand-400'
                  : 'hover:text-brand-700 dark:hover:text-brand-400'
              }`}
            >
              {m.label}
            </button>
          ))}
          <a
            href="https://dane.gov.pl"
            target="_blank"
            rel="noreferrer"
            className="hidden whitespace-nowrap transition hover:text-brand-700 dark:hover:text-brand-400 md:block"
          >
            Dane otwarte ↗
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
        <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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
          <span className="text-2xl" role="img" aria-label="urząd">🏛️</span>
          <h3 className="mt-3 font-semibold text-slate-900 dark:text-white">Oficjalne dane NFZ</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Korzystamy z publicznego API NFZ „Terminy Leczenia": liczba osób w kolejce, średni czas
            oczekiwania i prognoza PCUS dla tysięcy placówek w 16 oddziałach wojewódzkich.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card dark:border-slate-800 dark:bg-slate-900">
          <span className="text-2xl" role="img" aria-label="waga">⚖️</span>
          <h3 className="mt-3 font-semibold text-slate-900 dark:text-white">Porównanie, nie rezerwacja</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            NFZ publikuje statystyki kolejek (aktualizowane miesięcznie), a nie wolne sloty. Dlatego
            pokazujemy, <strong>gdzie kolejka jest najkrótsza</strong> — i jak do tego porównania doszło.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card dark:border-slate-800 dark:bg-slate-900">
          <span className="text-2xl" role="img" aria-label="dostępność">♿</span>
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
