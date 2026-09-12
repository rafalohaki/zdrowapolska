import { useEffect, useRef, useState } from 'react';
import { FacilitiesView } from './FacilitiesView';
import type { GslCategoryKey } from '../lib/types';

type Need = 'now' | 'plan' | 'close';

const NEEDS: { key: Need; title: string; desc: string }[] = [
  { key: 'now', title: 'Jest źle TERAZ', desc: 'Zadzwoń — rozmowa trwa kilka minut.' },
  { key: 'plan', title: 'Szukam pomocy planowo', desc: 'Mapa poradni + realne kolejki NFZ.' },
  { key: 'close', title: 'Szukam dla bliskiej osoby', desc: 'Jak być obok i nie zaszkodzić.' },
];

const CRISIS_LINES = [
  {
    number: '116111',
    display: '116 111',
    label: 'Telefon Zaufania dla Dzieci i Młodzieży',
    note: 'Bezpłatny, całodobowy',
  },
  {
    number: '116123',
    display: '116 123',
    label: 'Telefon wsparcia dla dorosłych w kryzysie',
    note: 'Bezpłatny',
  },
  {
    number: '112',
    display: '112',
    label: 'Bezpośrednie zagrożenie życia lub zdrowia',
    note: 'Numer alarmowy',
  },
];

const PRESETS: {
  key: string;
  label: string;
  category: GslCategoryKey;
  name: string;
  hint: string;
  queueBenefit: string;
}[] = [
  {
    key: 'poradnie',
    label: 'Poradnie zdrowia psychicznego',
    category: 'aos',
    name: 'psychicznego',
    hint: 'Poradnie i centra wsparcia — pierwszy krok, bez skierowania.',
    queueBenefit: 'PORADNIA ZDROWIA PSYCHICZNEGO',
  },
  {
    key: 'szpitale',
    label: 'Szpitale psychiatryczne',
    category: 'szpitale',
    name: 'psychiatryczny',
    hint: 'Opieka całodobowa i oddziały psychiatryczne.',
    queueBenefit: 'ODDZIAŁ PSYCHIATRYCZNY (OGÓLNY)',
  },
];

const QUEUE_PRESETS = [
  { label: 'Kolejki: poradnia zdrowia psychicznego', benefit: 'PORADNIA ZDROWIA PSYCHICZNEGO' },
  { label: 'Kolejki: poradnia dla dzieci', benefit: 'PORADNIA ZDROWIA PSYCHICZNEGO DLA DZIECI' },
];

export function MentalHealthView({ onCheckQueues }: { onCheckQueues: (benefit: string) => void }) {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [need, setNeed] = useState<Need | null>(null);
  const [province, setProvince] = useState('06');
  const phonesRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pickNeed = (key: Need) => setNeed(key);
  // scroll dopiero po commicie (panele warunkowe zmieniają layout powyżej celu)
  useEffect(() => {
    if (!need) return;
    const el = need === 'plan' ? listRef.current : phonesRef.current;
    if (!el) return;
    const y0 = window.scrollY;
    el.scrollIntoView({ behavior: 'smooth', block: need === 'plan' ? 'start' : 'center' });
    // fallback: gładki scroll bywa dławiony (karta w tle) — gdy po 700 ms nic nie drgnęło, dociągnij ostro
    const t = window.setTimeout(() => {
      if (Math.abs(window.scrollY - y0) > 4) return;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.top <= window.innerHeight * 0.6) return;
      const top =
        need === 'plan'
          ? window.scrollY + r.top - 96 // scroll-mt-24 pod sticky header
          : window.scrollY + r.top - (window.innerHeight - r.height) / 2;
      window.scrollTo({ top, behavior: 'auto' });
    }, 700);
    return () => window.clearTimeout(t);
  }, [need]);
  return (
    <div>
      <section className="mx-auto max-w-4xl px-4 pt-8 pb-2">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          Wsparcie psychiczne
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Kryzys psychiczny to też nagły stan. Wszystko poniżej jest{' '}
          <strong className="text-slate-700 dark:text-slate-200">bezpłatne w ramach NFZ</strong> —
          dane placówek: oficjalny serwis NFZ „Gdzie się leczyć".
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-3" role="group" aria-label="Wybierz swoją sytuację">
          {NEEDS.map((n) => (
            <button
              key={n.key}
              type="button"
              aria-pressed={need === n.key}
              onClick={() => pickNeed(n.key)}
              className={`rounded-2xl border p-4 text-left shadow-card transition active:scale-[0.98] ${
                need === n.key
                  ? 'border-brand-500 bg-brand-50 dark:border-brand-500 dark:bg-brand-500/10'
                  : 'border-slate-200 bg-white hover:border-brand-300 dark:border-slate-800 dark:bg-slate-900'
              }`}
            >
              <span className="block text-sm font-bold text-slate-900 dark:text-white">{n.title}</span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{n.desc}</span>
            </button>
          ))}
        </div>
        <div aria-live="polite">
        {need === 'close' && (
          <div className="mt-3 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm leading-relaxed text-slate-700 shadow-card dark:border-brand-900 dark:bg-brand-500/10 dark:text-slate-200">
            <strong>Jak być obok:</strong> słuchaj bez oceniania („jestem tu, wierzę ci"), nie
            minimalizuj („weź się w garść" szkodzi). Zaproponuj konkret: „zadzwonimy razem na{' '}
            <a href="tel:116123" className="font-bold underline underline-offset-2">
              116 123
            </a>
            ?". Gdy pada zagrożenie życia — dzwoń na <a href="tel:112" className="font-bold underline underline-offset-2">112</a>.
          </div>
        )}
        {need === 'now' && (
          <p className="mt-3 rounded-2xl border border-red-300 bg-red-50 p-4 text-sm leading-relaxed text-red-800 shadow-card dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
            Nie musisz układać zdań — wystarczy powiedzieć „jest mi bardzo źle". Połączenie trwa
            kilka minut i nic nie kosztuje. Jeśli boisz się dzwonić, poproś kogoś, by był obok.
          </p>
        )}
        </div>

        <div ref={phonesRef} className="mt-4 grid scroll-mt-24 gap-2 sm:grid-cols-3" role="group" aria-label="Telefony kryzysowe">
          {CRISIS_LINES.map((line) => (
            <a
              key={line.number}
              href={`tel:${line.number}`}
              className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-card transition hover:border-red-400 active:scale-[0.98] dark:border-red-900 dark:bg-red-950/40"
            >
              <span className="block text-2xl font-extrabold tracking-tight text-red-700 dark:text-red-300">
                {line.display}
              </span>
              <span className="mt-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
                {line.label}
              </span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">{line.note}</span>
            </a>
          ))}
        </div>
        <p className="mt-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-600 shadow-card dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          Wizyta jest <strong>bezpłatna</strong> — placówki rozlicza NFZ, nic nie płacisz, i{' '}
          <strong>nie potrzebujesz skierowania</strong>. Zadzwoń do rejestracji i powiedz: „chcę
          umówić pierwszą wizytę" — numery znajdziesz przy każdej placówce poniżej. Ta strona nie
          zastępuje pomocy specjalisty; w nagłym kryzysie dzwoń na 112.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset.key === p.key}
              onClick={() => setPreset(p)}
              className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                preset.key === p.key
                  ? 'border-brand-500 bg-brand-500 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {QUEUE_PRESETS.map((q) => (
            <button
              key={q.benefit}
              type="button"
              onClick={() => onCheckQueues(q.benefit)}
              className="rounded-full border border-dashed border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-brand-400 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300"
            >
              {q.label} →
            </button>
          ))}
        </div>
      </section>

      <div ref={listRef} className="scroll-mt-24">
        <FacilitiesView
          key={preset.key}
          initialCategory={preset.category}
          initialName={preset.name}
          lockFilters
          title={preset.label}
          subtitle={preset.hint}
          queueBenefit={preset.queueBenefit}
          province={province}
          onProvinceChange={setProvince}
        />
      </div>
    </div>
  );
}
