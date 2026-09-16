import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchFacilities, fetchProvinceQueues } from '../lib/api';
import { PROVINCES } from '../lib/provinces';
import { GSL_CATEGORY_GROUPS, GSL_CATEGORIES, type GslCategoryKey, type GslFacility, type NfzRecord } from '../lib/types';
import { buildQueueIndex, gslCity, matchFacility, type QueueInfo } from '../lib/matchQueues';
import { formatDaysLong, formatDaysShort, waitLevel } from '../lib/wait';
import { ErrorState } from './States';
import { FacilitiesMap } from './FacilitiesMap';
import { PhoneIcon, PinIcon } from './Icons';
import type { WaitLevel } from '../lib/wait';

const WAIT_PILL: Record<WaitLevel, string> = {
  great: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  ok: 'bg-lime-50 text-lime-700 dark:bg-lime-500/10 dark:text-lime-300',
  slow: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  bad: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  unknown: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};
export function FacilitiesView(props?: {
  initialCategory?: GslCategoryKey;
  initialName?: string;
  lockFilters?: boolean;
  title?: string;
  subtitle?: string;
  /** Świadczenie ITL do doklejenia kolejek (np. PORADNIA ZDROWIA PSYCHICZNEGO) */
  queueBenefit?: string;
  /** Kontrolowane województwo (MentalHealthView trzyma je ponad presetami) */
  province?: string;
  onProvinceChange?: (code: string) => void;
  /** Cross-link: „sprawdź kolejkę" — przechodzi do trybu terminów z miastem/świadczeniem */
  onQueueClick?: (locality: string, benefit?: string) => void;
}) {
  const [category, setCategory] = useState<GslCategoryKey>(props?.initialCategory ?? 'apteki');
  const [innerProvince, setInnerProvince] = useState('06');
  const [name, setName] = useState(props?.initialName ?? '');
  const province = props?.province ?? innerProvince;
  const setProvince = (code: string) => {
    if (props?.onProvinceChange) props.onProvinceChange(code);
    else setInnerProvince(code);
  };
  const [results, setResults] = useState<GslFacility[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchKey, setSearchKey] = useState(
    `${props?.initialCategory ?? 'apteki'}:${props?.province ?? '06'}:${(props?.initialName ?? '').trim().toLowerCase()}`,
  );
  const run = (cat: GslCategoryKey, prov: string, nm: string) => {
    setLoading(true);
    setError(null);
    setMoreError(null);
    setSearched(true);
    setSearchKey(`${cat}:${prov}:${nm.trim().toLowerCase()}`);
    setPage(1);
    fetchFacilities(cat, prov, nm.trim(), 1)
      .then((res) => {
        setResults(res.results);
        setTotal(res.total);
        setPage(res.page);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Nieznany błąd'))
      .finally(() => setLoading(false));
  };

  const more = () => {
    const next = page + 1;
    setLoadingMore(true);
    setMoreError(null);
    fetchFacilities(category, province, name.trim(), next)
      .then((res) => {
        setResults((prev) => [...prev, ...res.results]);
        setTotal(res.total);
        setPage(res.page);
      })
      .catch((err: unknown) => setMoreError(err instanceof Error ? err.message : 'Nieznany błąd'))
      .finally(() => setLoadingMore(false));
  };

  const submit = () => run(category, province, name);

  // NFZ wystawia osobny wpis dla każdego programu/oddziału w tym samym budynku —
  // grupujemy po nazwie+adresie i łączymy telefony (inaczej lista to ściana duplikatów)
  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; name: string; address: string; phones: string[]; count: number }>();
    for (const f of results) {
      const key = `${f.name}|${f.address}`;
      const g = map.get(key);
      if (g) {
        if (f.phone && !g.phones.includes(f.phone)) g.phones.push(f.phone);
        g.count += 1;
      } else {
        map.set(key, { key, name: f.name, address: f.address, phones: f.phone ? [f.phone] : [], count: 1 });
      }
    }
    return [...map.values()];
  }, [results]);
  // Kolejki ITL dla tego województwa (best-effort: brak = lista bez badge'ów, nie błąd)
  const [queueRecords, setQueueRecords] = useState<NfzRecord[]>([]);
  const [queuesReady, setQueuesReady] = useState(false);
  useEffect(() => {
    setQueueRecords([]);
    setQueuesReady(false);
    if (!props?.queueBenefit) return;
    let alive = true;
    fetchProvinceQueues(props.queueBenefit, province, 1, '', 2)
      .then((res) => {
        if (alive) setQueueRecords(res.records);
      })
      .catch(() => {
        /* kolejki niedostępne — pokazujemy samą listę placówek */
      })
      .finally(() => {
        if (alive) setQueuesReady(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props?.queueBenefit, province]);

  const queueIndex = useMemo(() => buildQueueIndex(queueRecords), [queueRecords]);

  // dopasowana kolejka per grupa (budynek): najkrótsza ze znalezionych
  const waitByGroup = useMemo(() => {
    if (!props?.queueBenefit || queueRecords.length === 0) return new Map<string, QueueInfo>();
    const out = new Map<string, QueueInfo>();
    for (const g of grouped) {
      let best: QueueInfo | null = null;
      for (const phone of g.phones.length > 0 ? g.phones : ['']) {
        const hit = matchFacility({ name: g.name, address: g.address, phone }, queueIndex);
        if (hit && (!best || (hit.days !== null && (best.days === null || hit.days < best.days)))) best = hit;
      }
      // liczymy tylko dopasowania z czasem kolejki — sam „awaiting" nie daje badge'a
      if (best && best.days !== null) out.set(g.key, best);
    }
    return out;
  }, [grouped, queueIndex, queueRecords.length, props?.queueBenefit]);
  // mapa grupuje po adresie — pierwsza dopasowana kolejka dla adresu
  const waitByAddress = useMemo(() => {
    const out = new Map<string, number | null>();
    for (const g of grouped) {
      if (!g.address || out.has(g.address)) continue;
      const hit = waitByGroup.get(g.key);
      if (hit) out.set(g.address, hit.days);
    }
    return out;
  }, [grouped, waitByGroup]);

  // ranking: najkrótsza kolejka pierwsza (predykcja: użytkownik wybierze górę listy).
  // Mrożony per wyszukiwanie: spóźnione kolejki i „Pokaż więcej" nie przestawiają wierszy
  // pod czytnikiem — doklejane lądują na końcu.
  const rankRef = useRef<{ key: string; order: string[] | null }>({ key: '', order: null });
  if (rankRef.current.key !== searchKey) rankRef.current = { key: searchKey, order: null };
  const sortedGroups = useMemo(() => {
    if (!queuesReady || waitByGroup.size === 0) return grouped;
    const ranked = [...grouped].sort((a, b) => {
      const da = waitByGroup.get(a.key)?.days ?? null;
      const db = waitByGroup.get(b.key)?.days ?? null;
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
    const frozen = rankRef.current.key === searchKey ? rankRef.current.order : null;
    if (!frozen) return ranked;
    const pos = new Map(frozen.map((k, i) => [k, i]));
    const rankPos = (k: string) => pos.get(k) ?? Number.MAX_SAFE_INTEGER;
    return [...ranked].sort((a, b) => rankPos(a.key) - rankPos(b.key));
  }, [grouped, waitByGroup, queuesReady, searchKey]);
  useEffect(() => {
    if (queuesReady && waitByGroup.size > 0 && rankRef.current.order === null) {
      rankRef.current.order = sortedGroups.map((g) => g.key);
    }
  }, [sortedGroups, queuesReady, waitByGroup.size, searchKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(category, province, name); }, []);

  return (
    <section className="mx-auto max-w-4xl px-4 pt-8 pb-4">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        {props?.title ?? 'Placówki i pomoc NFZ'}
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {props?.subtitle ??
          'Wszystko, co NFZ finansuje — od rodzinnego lekarza, przez apteki i diagnostykę, po SOR — dane z oficjalnego serwisu „Gdzie się leczyć".'}
      </p>

      <div className="mt-5 space-y-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-card">
        {!props?.lockFilters &&
          GSL_CATEGORY_GROUPS.map((group) => (
          <div key={group.key}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {group.label}
            </p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={group.label}>
              {GSL_CATEGORIES.filter((cat) => cat.group === group.key).map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  aria-pressed={category === cat.key}
                  onClick={() => {
                    setCategory(cat.key);
                    run(cat.key, province, name);
                  }}
                  className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                    category === cat.key
                      ? 'border-brand-500 bg-brand-500 text-white'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-brand-300'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
          ))}

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_minmax(150px,170px)_auto]">
          {!props?.lockFilters && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="Nazwa (opcjonalnie), np. Alba…"
              aria-label="Nazwa placówki"
              className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 text-sm shadow-card outline-none transition placeholder:text-slate-400 dark:text-slate-100 focus:border-brand-400"
            />
          )}
          <select
            value={province}
            onChange={(e) => {
              setProvince(e.target.value);
              run(category, e.target.value, name);
            }}
            aria-label="Województwo"
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-3 text-sm shadow-card outline-none focus:border-brand-400"
          >
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={submit}
            className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-card transition hover:bg-brand-700 active:scale-[0.98]"
          >
            Szukaj
          </button>
        </div>
      </div>

      {loading && (
        <div className="mt-6 space-y-3" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="mt-6">
          <ErrorState message={error} onRetry={() => run(category, province, name)} />
        </div>
      )}

      {!loading && !error && searched && total !== null && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Znaleziono <strong className="text-slate-800 dark:text-slate-100">{total}</strong> placówek
            {total > results.length && ` — pokazuję ${results.length}, zawęź kryteria (np. nazwą)`}.
            {props?.queueBenefit &&
              (queuesReady
                ? ` Kolejki dopasowano dla ${waitByGroup.size} z ${grouped.length} placówek.`
                : ' Ładowanie kolejek…')}
          </p>
          {results.length > 0 && (
            <button
              type="button"
              onClick={() => window.print()}
              className="no-print rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-card transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              Drukuj listę
            </button>
          )}
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <>
          {(() => {
            const first = props?.queueBenefit ? sortedGroups[0] : undefined;
            const days = first ? (waitByGroup.get(first.key)?.days ?? null) : null;
            if (!first || days === null) return null;
            return (
              <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm leading-relaxed text-slate-700 shadow-card dark:border-brand-900 dark:bg-brand-500/10 dark:text-slate-200">
                <strong className="text-slate-900 dark:text-white">Twój plan w 3 krokach:</strong>{' '}
                1) Zadzwoń do <strong>{first.name}</strong> — najkrótsza kolejka (
                {formatDaysLong(days)}){first.phones[0] ? `, tel. ${first.phones[0]}` : ''}.
                {' '}2) Powiedz: „chcę umówić pierwszą wizytę". 3) Nie pasuje termin? Idź w dół listy —
                ułożona od najszybszej pomocy.
              </div>
            );
          })()}
          <FacilitiesMap facilities={results} province={province} resetKey={searchKey} waits={waitByAddress} />
          <ul className="facilities-print-list mt-3 space-y-3">
          {sortedGroups.map((g) => (
            <li
              key={g.key}
              className="animate-fade-up rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-card"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-slate-900 dark:text-white">{g.name}</h3>
                <span className="flex shrink-0 items-center gap-1.5">
                  {waitByGroup.get(g.key) && waitByGroup.get(g.key)!.days !== null && (
                    <span
                      title={formatDaysLong(waitByGroup.get(g.key)!.days!)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${WAIT_PILL[waitLevel(waitByGroup.get(g.key)!.days)]}`}
                    >
                      Kolejka: {formatDaysShort(waitByGroup.get(g.key)!.days)}
                    </span>
                  )}
                  {g.count > 1 && (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                      {g.count} wpisów NFZ
                    </span>
                  )}
                </span>
              </div>
              {g.address && (
                <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                  <PinIcon className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
                  {g.address}
                </p>
              )}
              {g.phones.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {g.phones.map((ph) => (
                    <a
                      key={ph}
                      href={`tel:${ph.replace(/\s/g, '')}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
                    >
                      <PhoneIcon className="h-4 w-4" />
                      {ph}
                    </a>
                  ))}
                </p>
              )}
              {props?.onQueueClick && (
                <button
                  type="button"
                  onClick={() => props.onQueueClick!(gslCity(g.address), props.queueBenefit)}
                  className="no-print mt-2.5 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-brand-500"
                >
                  {props.queueBenefit
                    ? 'Kolejka dla tego świadczenia →'
                    : 'Kolejki NFZ w tej miejscowości →'}
                </button>
              )}
            </li>
          ))}
          </ul>
          {total !== null && results.length < total && (
            <div className="no-print mt-4 text-center">
              <button
                type="button"
                onClick={more}
                disabled={loadingMore}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 shadow-card transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
              >
                {loadingMore
                  ? 'Doczytuję…'
                  : `Pokaż więcej (pozostało ${total - results.length})`}
              </button>
              {moreError && (
                <p className="mx-auto mt-2 max-w-md rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                  Nie udało się doczytać kolejnych ({moreError}) — lista powyżej zostaje.{' '}
                  <button type="button" onClick={more} className="font-semibold underline">
                    Spróbuj ponownie
                  </button>
                </p>
              )}
            </div>
          )}
        </>
      )}

      {!loading && !error && searched && total === 0 && (
        <p className="mt-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center text-sm text-slate-500 dark:text-slate-400 shadow-card">
          Brak placówek dla podanych kryteriów — zmień nazwę lub województwo.
        </p>
      )}
    </section>
  );
}
