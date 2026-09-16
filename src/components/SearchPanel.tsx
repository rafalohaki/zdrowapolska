import { useEffect, useRef, useState } from 'react';
import { fetchBenefits, fetchLocalities } from '../lib/api';
import { PROVINCES } from '../lib/provinces';
import { A11Y_FILTERS, type A11yKey, type SortKey } from '../lib/types';
import { AlertIcon, PinIcon, SearchIcon, WheelchairIcon } from './Icons';

const HINTS = ['kardiolog', 'ortoped', 'okulistyka', 'rehabilitacja', 'endokrynolog', 'urolog'];

type Props = {
  benefit: string;
  locality: string;
  province: string;
  kase: 1 | 2;
  a11y: A11yKey[];
  sort: SortKey;
  hero?: boolean;
  onChange: (patch: Partial<SearchStatePatch>) => void;
  onSubmit: (benefit: string, locality?: string) => void;
};

export type SearchStatePatch = {
  benefit: string;
  locality: string;
  province: string;
  kase: 1 | 2;
  a11y: A11yKey[];
  sort: SortKey;
};

export function SearchPanel({
  benefit,
  locality,
  province,
  kase,
  a11y,
  sort,
  hero = false,
  onChange,
  onSubmit,
}: Props) {
  const [query, setQuery] = useState(benefit);
  const [items, setItems] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loadingDict, setLoadingDict] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // miejscowość: osobne pole + autouzupełnianie
  const [locQuery, setLocQuery] = useState(locality);
  const [locItems, setLocItems] = useState<string[]>([]);
  const [locOpen, setLocOpen] = useState(false);
  const [locHighlight, setLocHighlight] = useState(-1);
  const locBoxRef = useRef<HTMLDivElement>(null);

  // debounced słownik NFZ
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setItems([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoadingDict(true);
      fetchBenefits(q, ctrl.signal)
        .then((res) => {
          setItems(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if ((err as Error).name !== 'AbortError') setError('Nie udało się pobrać słownika świadczeń.');
        })
        .finally(() => setLoadingDict(false));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  // debounced słownik miejscowości
  useEffect(() => {
    const q = locQuery.trim();
    if (q.length < 3) {
      setLocItems([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetchLocalities(q, ctrl.signal)
        .then((res) => setLocItems(res))
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [locQuery]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
      if (!locBoxRef.current?.contains(e.target as Node)) setLocOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (name: string) => {
    setQuery(name);
    setOpen(false);
    // przekazuj lokalnie wpisaną miejscowość — bez tego search() użyłby starej wartości stanu
    onSubmit(name, locQuery.trim());
  };

  const submit = () => {
    const q = query.trim();
    if (q.length >= 3) onSubmit(q, locQuery.trim());
    else inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open || !items.length) {
      if (e.key === 'Enter') submit();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      pick(highlight >= 0 ? items[highlight] : items[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className={hero ? 'w-full max-w-3xl' : 'w-full'}>
      <div ref={boxRef} className="relative">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_minmax(140px,180px)_minmax(130px,150px)_minmax(140px,150px)_auto]">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-5 w-5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setHighlight(-1);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKey}
              placeholder="Specjalizacja, np. kardiolog…"
              aria-label="Szukaj świadczenia NFZ"
              aria-expanded={open}
              role="combobox"
              id="benefit-input" aria-controls="benefit-listbox"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-3 pr-4 pl-11 text-base shadow-card outline-none transition placeholder:text-slate-400 dark:text-slate-100 focus:border-brand-400"
            />
            {loadingDict && (
              <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-slate-400 dark:text-slate-500">szukam…</span>
            )}
          </div>

          <div ref={locBoxRef} className="relative">
            <PinIcon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              value={locQuery}
              onChange={(e) => {
                setLocQuery(e.target.value);
                setLocOpen(true);
                setLocHighlight(-1);
              }}
              onFocus={() => setLocOpen(true)}
              onKeyDown={(e) => {
                if (!locOpen || !locItems.length) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setLocHighlight((h) => (h + 1) % locItems.length);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setLocHighlight((h) => (h - 1 + locItems.length) % locItems.length);
                } else if (e.key === 'Enter' && locHighlight >= 0) {
                  e.preventDefault();
                  onChange({ locality: locItems[locHighlight] });
                  setLocQuery(locItems[locHighlight]);
                  setLocOpen(false);
                } else if (e.key === 'Escape') {
                  setLocOpen(false);
                }
              }}
              placeholder="Miejscowość (opcjonalnie)"
              aria-label="Miejscowość"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-3 pr-3 pl-10 text-sm shadow-card outline-none transition placeholder:text-slate-400 dark:text-slate-100 focus:border-brand-400"
            />
            {locOpen && locQuery.trim().length >= 3 && locItems.length > 0 && (
              <ul className="absolute z-30 mt-2 max-h-64 w-full min-w-56 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-1 shadow-lift">
                {locItems.map((name, i) => (
                  <li key={name}>
                    <button
                      type="button"
                      onMouseEnter={() => setLocHighlight(i)}
                      onClick={() => {
                        onChange({ locality: name });
                        setLocQuery(name);
                        setLocOpen(false);
                      }}
                      className={`block w-full px-4 py-2 text-left text-sm ${
                        i === locHighlight ? 'bg-brand-50 text-brand-800' : 'text-slate-700 dark:text-slate-200'
                      }`}
                    >
                      {name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <select
            value={province}
            onChange={(e) => onChange({ province: e.target.value })}
            aria-label="Województwo"
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-3 text-sm shadow-card outline-none focus:border-brand-400"
          >
            <option value="all">Cała Polska</option>
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            value={kase}
            onChange={(e) => onChange({ kase: e.target.value === '2' ? 2 : 1 })}
            aria-label="Typ przypadku"
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-3 text-sm shadow-card outline-none focus:border-brand-400"
          >
            <option value={1}>Przypadek stabilny</option>
            <option value={2}>Przypadek pilny</option>
          </select>

          <button
            type="button"
            id="szukaj-btn"
            onClick={submit}
            className="rounded-xl bg-brand-600 px-6 py-3 text-base font-semibold text-white shadow-card transition hover:bg-brand-700 active:scale-[0.98]"
          >
            Szukaj
          </button>
        </div>

        {open && query.trim().length >= 3 && (items.length > 0 || loadingDict) && (
          <ul
            id="benefit-listbox"
            role="listbox"
            className="absolute z-30 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-1 shadow-lift"
          >
            {items.map((name, i) => (
              <li key={name} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(name)}
                  className={`block w-full px-4 py-2 text-left text-sm ${
                    i === highlight ? 'bg-brand-50 text-brand-800' : 'text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {open && query.trim().length < 3 && (
          <div className="absolute z-30 mt-2 flex max-w-full flex-wrap gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 shadow-lift">
            {HINTS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => {
                  setQuery(h);
                  inputRef.current?.focus();
                }}
                className="rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 transition hover:bg-brand-100 hover:text-brand-800"
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-rose-600">
          <AlertIcon className="h-4 w-4" /> {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtr dostępności">
          {A11Y_FILTERS.map((f) => {
            const active = a11y.includes(f.key);
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    a11y: active ? a11y.filter((k) => k !== f.key) : [...a11y, f.key],
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? 'border-brand-500 bg-brand-500 text-white'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-brand-300'
                }`}
              >
                <WheelchairIcon className="h-3.5 w-3.5" />
                {f.label}
              </button>
            );
          })}
        </div>

        <label className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          Sortuj:
          <select
            value={sort}
            onChange={(e) => onChange({ sort: e.target.value as SortKey })}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-xs outline-none focus:border-brand-400"
          >
            <option value="wait">czas oczekiwania</option>
            <option value="awaiting">liczba oczekujących</option>
            <option value="name">nazwa placówki</option>
          </select>
        </label>
      </div>
    </div>
  );
}
