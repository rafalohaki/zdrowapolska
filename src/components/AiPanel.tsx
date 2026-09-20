import { useEffect, useRef, useState } from 'react';
import type { AiResponse, Facility } from '../lib/types';
import { fetchAdvice } from '../lib/api';
import { SparklesIcon } from './Icons';

/** Kompaktowy rekord dla doradcy (zgodny z server/ai.ts CompactRecord). */
function toCompact(f: Facility) {
  return {
    provider: f.provider,
    locality: f.locality,
    address: f.address,
    benefit: f.benefit,
    days: f.days,
    awaiting: f.awaiting,
    phone: f.phone,
    flags: f.flags,
  };
}

/** Mini-renderer markdown (pogrubienia + listy) — bez zewnętrznych zależności. */
function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
      {text.split('\n').map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const bullet = /^([-*•]|\d+\.)\s+/.test(trimmed);
        const content = trimmed.replace(/^([-*•]|\d+\.)\s+/, '');
        const parts = content.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <strong key={j} className="font-semibold text-slate-900 dark:text-white">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <span key={j}>{part}</span>
          ),
        );
        return bullet ? (
          <p key={i} className="flex gap-2 pl-1">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
            <span>{parts}</span>
          </p>
        ) : (
          <p key={i}>{parts}</p>
        );
      })}
    </div>
  );
}

export function AiPanel({
  benefit,
  kase,
  facilities,
}: {
  benefit: string;
  kase: 1 | 2;
  facilities: Facility[];
}) {
  const [answer, setAnswer] = useState<AiResponse | null>(null);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // stare rozmowy z poprzedniego świadczenia nie mogą wyglądać jak analiza nowych wyników
  const lastParams = useRef(`${benefit}|${kase}`);
  const reqSeq = useRef(0);
  useEffect(() => {
    const cur = `${benefit}|${kase}`;
    if (lastParams.current !== cur) {
      lastParams.current = cur;
      setAnswer(null);
      setError(null);
    }
  }, [benefit, kase]);

  const ask = (q?: string) => {
    setLoading(true);
    setError(null);
    const seq = ++reqSeq.current;
    fetchAdvice(benefit, facilities.slice(0, 12).map(toCompact), q, kase)
      .then((res) => {
        if (seq === reqSeq.current) setAnswer(res);
      })
      .catch((e: unknown) => {
        if (seq === reqSeq.current) setError(e instanceof Error ? e.message : 'Nieznany błąd');
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
  };

  const disabled = facilities.length === 0 || loading;

  return (
    <section className="animate-fade-up rounded-2xl border border-brand-200 bg-gradient-to-b from-brand-50/70 to-white p-5 shadow-card dark:border-brand-800/60 dark:from-brand-900/30 dark:to-slate-900">
      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
          <SparklesIcon />
        </span>
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Doradca AI</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Analizuje statystyki NFZ i pomaga wybrać placówkę</p>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Pytanie (opcjonalnie): np. „Która placówka ma najlepszy dojazd?”"
          className="w-full resize-none rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-sm outline-none placeholder:text-slate-400 dark:text-slate-100 focus:border-brand-400"
        />
        <button
          type="button"
          onClick={() => ask(question)}
          disabled={disabled}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              Analizuję dane NFZ…
            </>
          ) : (
            <>Poproś o rekomendację</>
          )}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {answer && !loading && (
        <div aria-live="polite" className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <RichText text={answer.text} />
          <p className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-2 text-[11px] text-slate-400 dark:text-slate-500">
            Źródło analizy: {answer.provider} · dane: NFZ · to nie jest porada medyczna
          </p>
        </div>
      )}
    </section>
  );
}
