import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchProvinceQueues } from './lib/api';
import { toFacility } from './lib/wait';
import { provinceName } from './lib/provinces';
import { pushHistory, loadHistory, type HistoryItem } from './lib/history';
import type { A11yKey, Facility, ProvinceData } from './lib/types';
import { SearchPanel } from './components/SearchPanel';
import { FacilityCard } from './components/FacilityCard';
import { CompareChart, provinceStats } from './components/CompareChart';
import { DetailModal } from './components/DetailModal';
import { AiPanel } from './components/AiPanel';
import { EmptyState, ErrorState, ResultsSkeleton } from './components/States';
import { AboutSection, Footer, Header } from './components/Footer';
import { modeFromUrl, paramsToState, sortFacilities, syncUrl, matchesA11y, DEFAULT_STATE, type AppMode, type SearchState } from './lib/search';
import { CheckIcon, LinkIcon } from './components/Icons';
import { TrendChip } from './components/TrendChip';
import { downloadCsv, facilitiesCsv } from './lib/csv';
import { lazy, Suspense } from 'react';

// code-splitting: widoki trybów ładowane na żądanie (mniejszy bundle startowy)
const FacilitiesView = lazy(() => import('./components/FacilitiesView').then((m) => ({ default: m.FacilitiesView })));
const ReportView = lazy(() => import('./components/ReportView').then((m) => ({ default: m.ReportView })));
const MentalHealthView = lazy(() => import('./components/MentalHealthView').then((m) => ({ default: m.MentalHealthView })));
const AirView = lazy(() => import('./components/AirView').then((m) => ({ default: m.AirView })));
import { TerminyMap } from './components/TerminyMap';

// kolejność pobierania: najludniejsze województwa pierwsze (szybciej użyteczne wyniki)
const FETCH_ORDER = ['07', '12', '15', '06', '01', '05', '11', '02', '16', '03', '09', '14', '13', '10', '04', '08'];
const CLIENT_CONCURRENCY = 4;

function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-busy="true">
      <span className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
    </div>
  );
}

function sortProvinces(list: ProvinceData[]): ProvinceData[] {
  const order = new Map(FETCH_ORDER.map((c, i) => [c, i]));
  return [...list].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
}
export default function App() {
  const [mode, setMode] = useState<AppMode>(() => modeFromUrl(location.search));
  const modeRef = useRef<AppMode>(modeFromUrl(location.search));
  const [state, setState] = useState<SearchState>(() => paramsToState(location.search));
  const [provinces, setProvinces] = useState<ProvinceData[]>([]);
  const [targetsTotal, setTargetsTotal] = useState(0);
  const [targetsDone, setTargetsDone] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // kody województw, które padły podczas pobierania — po loadingu pokazujemy
  // notkę z „dociągnij", żeby ranking nie udawał pełnych danych
  const [failedCodes, setFailedCodes] = useState<string[]>([]);
  const [selected, setSelected] = useState<Facility | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const startedFor = useRef<string>('');
  const provincesRef = useRef<ProvinceData[]>([]);
  provincesRef.current = provinces;

  const runSearch = useCallback(
    async (benefit: string, kase: 1 | 2, locality: string, province: string) => {
      if (benefit.length < 3) return;
      const key = `${benefit}:${kase}:${locality}:${province}`;
      startedFor.current = key;
      setLoading(true);
      setError(null);
      setProvinces([]);
      setTargetsDone(0);

      const targets = province === 'all' ? FETCH_ORDER : [province];
      setTargetsTotal(targets.length);
      setFailedCodes([]);
      const queue = [...targets];
      let failed = 0;
      let historyPushed = false;

      const worker = async () => {
        while (queue.length > 0) {
          if (startedFor.current !== key) return;
          const code = queue.shift()!;
          try {
            const data = await fetchProvinceQueues(benefit, code, kase, locality);
            if (startedFor.current !== key) return;
            if (!historyPushed) {
              historyPushed = true;
              setHistory(pushHistory(benefit, locality));
            }
            setFailedCodes((prev) => prev.filter((c) => c !== code));
            setProvinces((prev) => sortProvinces([...prev.filter((p) => p.code !== code), data]));
          } catch (err) {
            if (startedFor.current !== key) return;
            failed += 1;
            // województwo z błędem pomijamy, ale pokazujemy stan (0 rekordów)
            setFailedCodes((prev) => (prev.includes(code) ? prev : [...prev, code]));
            setProvinces((prev) => [
              ...prev.filter((p) => p.code !== code),
              { code, name: provinceName(code), total: 0, records: [] },
            ]);
          }
          if (startedFor.current !== key) return;
          setTargetsDone((c) => c + 1);
        }
      };

      await Promise.all(Array.from({ length: Math.min(CLIENT_CONCURRENCY, queue.length) }, worker));
      if (startedFor.current !== key) return;
      setLoading(false);
      // wszystkie województwa padły (backend/API NFZ niedostępne) — to błąd, nie „brak wyników"
      if (failed === targets.length) {
        setError('Nie udało się pobrać danych z NFZ. Sprawdź połączenie i spróbuj ponownie.');
      }
    },
    [],
  );

  // auto-start z URL (linki do wyników są współdzielone)
  useEffect(() => {
    if (state.benefit) void runSearch(state.benefit, state.kase, state.locality, state.province);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (patch: Partial<SearchState>) => {
    const next = { ...state, ...patch };
    setState(next);
    sync(next);
    // side-effecty poza updaterem stanu: w StrictMode updater działa dwukrotnie
    // i podwajałoby to zapytania do NFZ
    const refetch =
      (patch.kase !== undefined && patch.kase !== state.kase) ||
      (patch.locality !== undefined && patch.locality !== state.locality);
    if (refetch && next.benefit) {
      void runSearch(next.benefit, next.kase, next.locality, next.province);
    }
    // zmiana województwa: jeśli nie mamy dla niego realnych danych (brak wpisu lub
    // placeholder po błędzie), dociągnij je (z bazy lub NFZ)
    if (
      patch.province !== undefined &&
      patch.province !== state.province &&
      next.benefit
    ) {
      if (patch.province === 'all') {
        // deep-link ze scoped ?p=06 → powrót do „Cała Polska" musi dociągnąć resztę
        const loaded = new Set(
          provincesRef.current.filter((p) => p.records.length > 0).map((p) => p.code),
        );
        if (FETCH_ORDER.some((c) => !loaded.has(c))) {
          void runSearch(next.benefit, next.kase, next.locality, 'all');
        }
      } else if (!provincesRef.current.some((p) => p.code === patch.province && p.records.length > 0)) {
        void runSearch(next.benefit, next.kase, next.locality, patch.province);
      }
    }
  };

  const search = (benefit: string, locality?: string) => {
    const next = { ...state, benefit, ...(locality !== undefined ? { locality } : {}) };
    setState(next);
    // nowe zapytanie = wpis w historii przeglądarki (wstecz wraca do poprzednich
    // wyników); powtórzony submit tego samego query nie śmieci historii
    const changed = next.benefit !== state.benefit || next.locality !== state.locality;
    syncUrl(next, modeRef.current, changed);
    setHistory(pushHistory(benefit, next.locality));
    void runSearch(benefit, next.kase, next.locality, next.province);
  };

  /** Zmiana zakładki: wpis do historii (wstecz działa), tryb ląduje w URL. */
  const goMode = (m: AppMode) => {
    modeRef.current = m;
    setMode(m);
    if (m === 'terminy') {
      // powrót do terminów: stan w state — odtwórz parametry w URL,
      // bo wejście z ?mode=X już je wyczyściło (copyLink/refresh gubiły wyniki)
      syncUrl(state, 'terminy', true);
    } else {
      // inne tryby: parametry b/v/p/a/s są bez sensu — czysty ?mode=X
      window.history.pushState(null, '', `${location.pathname}?mode=${m}`);
    }
    window.scrollTo({ top: 0 });
  };
  const sync = (s: SearchState) => syncUrl(s, modeRef.current);
  // wstecz/dalej w przeglądarce: odtwórz tryb i stan z URL
  useEffect(() => {
    const onPop = () => {
      const m = modeFromUrl(location.search);
      modeRef.current = m;
      setMode(m);
      const next = paramsToState(location.search);
      setState(next);
      if (next.benefit.length >= 3) {
        void runSearch(next.benefit, next.kase, next.locality, next.province);
      } else {
        // wstecz do hero / b=<3 znaki — wyczyść wyniki, żeby nie wisiały pod nową frazą
        startedFor.current = '';
        setProvinces([]);
        setTargetsDone(0);
        setTargetsTotal(0);
        setError(null);
        setFailedCodes([]);
      }
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [runSearch]);

  const geoResolve = useCallback(
    (updates: { id: string; lat: number; lon: number }[] | { id: string }[]) => {
      setProvinces((prev) =>
        prev.map((p) => ({
          ...p,
          records: p.records.map((rec) => {
            const attrs = (rec.attributes ?? {}) as Record<string, unknown>;
            const rid =
              (rec.id as string | undefined) ??
              `${attrs['provider']}|${attrs['address']}|${attrs['benefit']}`;
            const hit = updates.find((u) => u.id === rid);
            if (!hit) return rec;
            const point = hit as { id: string; lat?: number; lon?: number };
            if (typeof point.lat === 'number' && typeof point.lon === 'number') {
              return {
                ...rec,
                attributes: { ...attrs, latitude: point.lat, longitude: point.lon },
              };
            }
            return {
              ...rec,
              attributes: { ...attrs, latitude: null, longitude: null, geo: 'miss' },
            };
          }),
        })),
      );
    },
    [],
  );

  const copyLink = async () => {
    // mobilne: natywny share sheet; desktop/brak wsparcia/błąd share: schowek
    try {
      if (navigator.share) {
        await navigator.share({ url: location.href, title: document.title });
        return;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // user zamknął sheet — nie kopiuj
      // inny błąd share (np. nieobsługiwane dane) → spadamy do schowka
    }
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* brak uprawnień do schowka — URL i tak jest w pasku adresu */
    }
  };
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  // dociąga województwa, które padły podczas pierwszego pobierania (429/sieć),
  // bez kasowania tego, co już jest na ekranie
  const retryMissing = () => {
    const key = startedFor.current;
    for (const code of failedCodes) {
      void fetchProvinceQueues(state.benefit, code, state.kase, state.locality)
        .then((data) => {
          if (startedFor.current !== key) return;
          setFailedCodes((prev) => prev.filter((c) => c !== code));
          setProvinces((prev) => sortProvinces([...prev.filter((p) => p.code !== code), data]));
        })
        .catch(() => undefined);
    }
  };

  // skrót „/" — focus na pole wyszukiwania (klasyczny pattern, zero kosztu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || modeRef.current !== 'terminy') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        return;
      e.preventDefault();
      document.getElementById('benefit-input')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const facilities = useMemo<Facility[]>(() => {
    if (provinces.length === 0) return [];
    const out: Facility[] = [];
    for (const p of provinces) {
      if (state.province !== 'all' && p.code !== state.province) continue;
      for (const rec of p.records) {
        const f = toFacility(rec, p.code, p.name);
        if (f && matchesA11y(f, state.a11y as A11yKey[])) out.push(f);
      }
    }
    return sortFacilities(out, state.sort);
  }, [provinces, state.province, state.a11y, state.sort]);

  // Porównanie województw liczone z PEŁNEGO zestawu — przy aktywnym filtrze
  // województwa wykres pokazywałby jeden pasek i tracił sens
  const statsFacilities = useMemo<Facility[]>(() => {
    const out: Facility[] = [];
    for (const p of provinces) {
      for (const rec of p.records) {
        const f = toFacility(rec, p.code, p.name);
        if (f && matchesA11y(f, state.a11y as A11yKey[])) out.push(f);
      }
    }
    return out;
  }, [provinces, state.a11y]);

  const stats = useMemo(() => provinceStats(statsFacilities), [statsFacilities]);

  const medianDays = useMemo(() => {
    const d = facilities.map((f) => f.days).filter((x): x is number => x !== null).sort((a, b) => a - b);
    if (d.length === 0) return null;
    const mid = Math.floor(d.length / 2);
    return d.length % 2 ? d[mid] : Math.round((d[mid - 1] + d[mid]) / 2);
  }, [facilities]);

  const started = Boolean(state.benefit) && (loading || provinces.length > 0 || error !== null);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#tresc"
        className="sr-only z-50 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Przejdź do treści
      </a>
      <Header
        mode={mode}
        onMode={goMode}
        onHome={() => {
          startedFor.current = ''; // wiszące worker'y NFZ przestaną zapisywać wyniki
          modeRef.current = 'terminy';
          setMode('terminy');
          setState(DEFAULT_STATE);
          setProvinces([]);
          setTargetsDone(0);
          setTargetsTotal(0);
          setError(null);
          setFailedCodes([]);
          syncUrl(DEFAULT_STATE, 'terminy');
          window.scrollTo({ top: 0 });
        }}
      />
      <main id="tresc" className="flex-1">
        {mode === 'raport' ? (
          <Suspense fallback={<PageLoader />}>
            <ReportView />
          </Suspense>
        ) : mode === 'placowki' ? (
          <Suspense fallback={<PageLoader />}>
            <FacilitiesView
              onQueueClick={(loc, benefit) => {
                goMode('terminy');
                if (benefit) {
                  search(benefit, loc);
                } else {
                  // bez powiązanego świadczenia: przenieś przynajmniej miejscowość do filtra
                  const next = { ...state, locality: loc };
                  setState(next);
                  sync(next);
                }
              }}
            />
          </Suspense>
        ) : mode === 'powietrze' ? (
          <Suspense fallback={<PageLoader />}>
            <AirView />
          </Suspense>
        ) : mode === 'wsparcie' ? (
          <Suspense fallback={<PageLoader />}>
            <MentalHealthView
              onCheckQueues={(benefit) => {
                goMode('terminy');
                search(benefit);
              }}
            />
          </Suspense>
        ) : (
          <>
        {!started ? (
          <section className="mx-auto flex max-w-3xl flex-col items-center px-4 pt-16 pb-10 text-center sm:pt-24">
            <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-5xl">
              Gdzie do <span className="text-brand-600">specjalisty</span> najszybciej?
            </h1>
            <p className="mt-4 max-w-xl text-lg text-slate-500 dark:text-slate-400">
              Porównujemy <strong>oficjalne czasy oczekiwania NFZ</strong> w 16 województwach. Wpisz
              specjalizację i zobacz, gdzie kolejka jest najkrótsza — z filtrem dostępności i doradcą AI.
            </p>
            <div className="mt-8 flex w-full justify-center">
              <SearchPanel
                benefit={state.benefit}
                locality={state.locality}
                province={state.province}
                kase={state.kase}
                a11y={state.a11y}
                sort={state.sort}
                hero
                onChange={update}
                onSubmit={search}
              />
            </div>
            {history.length > 0 && (
              <div id="history-chips" className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
                <span className="text-xs text-slate-500 dark:text-slate-400">Ostatnio szukane:</span>
                {history.map((h) => (
                  <button
                    key={`${h.benefit}|${h.locality}`}
                    type="button"
                    onClick={() => search(h.benefit, h.locality)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-card transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-brand-500"
                  >
                    {h.benefit}
                    {h.locality ? ` · ${h.locality}` : ''}
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="mx-auto max-w-6xl px-4 pt-6">
            <SearchPanel
              benefit={state.benefit}
              locality={state.locality}
              province={state.province}
              kase={state.kase}
              a11y={state.a11y}
              sort={state.sort}
              onChange={update}
              onSubmit={search}
            />
          </section>
        )}

        {started && (
          <section className="mx-auto max-w-6xl px-4 pt-6 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                  „{state.benefit}"
                  <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                    {state.locality ? state.locality : state.province === 'all' ? 'cała Polska' : `woj. ${provinceName(state.province)}`}
                    {state.kase === 2 && ' • przypadek pilny'}
                  </span>
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
                  {loading && facilities.length === 0
                    ? 'pobieram dane…'
                    : `${facilities.length} placówek`}
                  {state.a11y.length > 0 && ` (po filtrze dostępności)`} ·{" "}
                  <abbr title="Prognozowany Czas Udzielenia Świadczenia — statystyka NFZ, aktualizowana miesięcznie" className="underline decoration-dotted">
                    PCUS
                  </abbr>
                  {medianDays !== null && !loading && (
                    <>
                      {' · '}
                      <strong className="text-slate-700 dark:text-slate-200">
                        mediana oczekiwania: {medianDays} dni
                      </strong>
                    </>
                  )}
                  {loading && targetsTotal > 1 && (
                    <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                      dane NFZ: {targetsDone}/{targetsTotal} województw
                    </span>
                  )}
                </p>
                <TrendChip benefit={state.benefit} kase={state.kase} locality={state.locality} />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={copyLink}
                  title="Skopiuj link do tych wyników"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 shadow-card transition hover:border-brand-300 hover:text-brand-700"
                >
                  {copied ? <CheckIcon className="h-4 w-4 text-brand-600" /> : <LinkIcon className="h-4 w-4" />}
                  {copied ? 'Skopiowano' : 'Kopiuj link'}
                </button>
                {facilities.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsv(
                        `zdrowapolska-${state.benefit.toLowerCase().replace(/\s+/g, '-')}.csv`,
                        facilitiesCsv(facilities),
                      )
                    }
                    title="Pobierz ranking jako CSV (Excel)"
                    className="no-print inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 shadow-card transition hover:border-brand-300 hover:text-brand-700"
                  >
                    Eksport CSV
                  </button>
                )}
                <div className="flex rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1 shadow-card" role="tablist" aria-label="Widok">
                  {(['ranking', 'mapa', 'compare'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={state.view === v}
                      onClick={() => update({ view: v })}
                      className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
                        state.view === v ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:text-white'
                      }`}
                    >
                      {v === 'ranking' ? 'Ranking' : v === 'mapa' ? 'Mapa' : 'Porównanie województw'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {loading && provinces.length === 0 && (
              <div className="mt-6 space-y-3">
                <p className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800 dark:border-brand-800 dark:bg-brand-900/30 dark:text-brand-200">
                  Pobieram statystyki z oddziałów NFZ — pierwsze wyniki pojawią się za chwilę
                  {targetsTotal > 1 && ', reszta dołączy progresywnie'} (powtórne wyszukiwania są
                  błyskawiczne — dane trzymamy w własnej bazie)…
                </p>
                <ResultsSkeleton />
              </div>
            )}

            {!loading && error && (
              <div className="mt-6">
                <ErrorState
                  message={error}
                  onRetry={() => void runSearch(state.benefit, state.kase, state.locality, state.province)}
                />
              </div>
            )}

            {!loading && failedCodes.length > 0 && (
              <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                <span>
                  Brak danych z: {failedCodes.map((c) => provinceName(c)).join(', ')} — wyniki poniżej są
                  niepełne.
                </span>
                <button
                  type="button"
                  onClick={retryMissing}
                  className="font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
                >
                  Dociągnij
                </button>
              </p>
            )}

            {!loading && !error && targetsDone === targetsTotal && provinces.length > 0 && facilities.length === 0 && (
              <div className="mt-6">
                <EmptyState onPickHint={search} />
              </div>
            )}

            {facilities.length > 0 && (
              <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
                <div>
                  {state.view === 'ranking' ? (
                    <div className="space-y-3">
                      {facilities.slice(0, 30).map((f, i) => (
                        <FacilityCard key={f.id} facility={f} rank={i + 1} onDetails={setSelected} />
                      ))}
                      {facilities.length > 30 && (
                        <p className="pt-2 text-center text-sm text-slate-400 dark:text-slate-500">
                          Pokazuję 30 z {facilities.length} placówek — zawęź wyniki filtrem województwa lub
                          dostępności.
                        </p>
                      )}
                    </div>
                  ) : state.view === 'mapa' ? (
                    <TerminyMap
                      facilities={facilities.slice(0, 100)}
                      onResolve={geoResolve}
                      mapKey={`${state.benefit}|${state.kase}|${state.locality}|${state.province}`}
                    />
                  ) : (
                    <CompareChart
                      stats={stats}
                      selected={state.province}
                      onSelect={(code) => update({ province: code ?? 'all' })}
                      loadingProgress={loading && targetsTotal > 1 ? `${targetsDone}/${targetsTotal} woj.` : undefined}
                      reference={medianDays}
                    />
                  )}
                </div>
                <aside className="lg:sticky lg:top-20 lg:self-start">
                  <AiPanel benefit={state.benefit} kase={state.kase} facilities={facilities} />
                </aside>
              </div>
            )}
          </section>
        )}
          </>
        )}

        {mode === 'terminy' && <AboutSection />}
      </main>

      <Footer />

      {selected && <DetailModal facility={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
