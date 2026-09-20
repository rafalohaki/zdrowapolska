/**
 * Doradca AI: Groq lub OpenRouter (OpenAI-compatible) + tryb lokalny (heurystyka),
 * żeby demo działało nawet bez kluczy API.
 */

export type CompactRecord = {
  provider: string;
  locality: string;
  address: string;
  benefit: string;
  days: number | null;
  awaiting: number | null;
  phone: string;
  flags: {
    ramp: boolean;
    elevator: boolean;
    toilet: boolean;
    wheelchairs: boolean;
    ac: boolean;
    automaticDoor: boolean;
    bus: boolean;
    forChildren: boolean;
  };
};

export type AiRequest = {
  benefit: string;
  question?: string;
  results: CompactRecord[];
  /** 1 = zwykła kolejka, 2 = przypadek pilny — SYSTEM_PROMPT ma osobną regułę */
  kase?: 1 | 2;
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `Jesteś doradcą pacjenta w aplikacji ZdrowaPolska. Otrzymujesz listę placówek
z OFICJALNYCH statystyk kolejek NFZ (świadczenia funduszowe). Twoje zadanie: pomóc wybrać placówkę
z najkrótszym czasem oczekiwania, uwzględniając dostępność architektoniczną i dojazd.

Zasady:
- Odpowiadaj ZAWSZE po polsku, zwięźle (maks. 150 słów), w punktach.
- Rekomenduj konkretne placówki: nazwa + miejscowość + czas oczekiwania (z podanych danych).
- "days: null" oznacza brak danych — nie zmyślaj liczb. Nigdy nie podawaj danych spoza listy.
- Zwróć uwagę na dostępność (rampa, winda, toaleta dostosowana) jeśli pacjent tego potrzebuje.
- NIE udzielaj porad medycznych dotyczących leczenia ani leków. Dodaj na końcu jedno zdanie:
  "Ostateczny wybór placówki warto skonsultować z lekarzem POZ."
- Jeśli przypadek jest pilny (case=2), przypomnij, że przy nagłym pogorszeniu zdrowia
  należy wybrać się na SOR lub zadzwonić na 112/999.`;

function providerConfig(): { url: string; key: string; model: string } | null {
  // 'groq/compound' zweryfikowany na żywo w GET /openai/v1/models (09.2026);
  // stare 'llama-3.3-70b-versatile' zostało wycofane i zwraca 404
  const model = process.env.AI_MODEL ?? 'groq/compound';
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  const groqKey = process.env.GROQ_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  if (provider === 'openrouter' && orKey) return { url: OPENROUTER_URL, key: orKey, model };
  if (groqKey) return { url: GROQ_URL, key: groqKey, model };
  if (orKey) return { url: OPENROUTER_URL, key: orKey, model };
  return null;
}

function userPrompt(req: AiRequest): string {
  const list = req.results
    .slice(0, 12)
    .map((r, i) => {
      const flags = Object.entries(r.flags)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      return [
        `${i + 1}. ${r.provider} — ${r.locality}, ${r.address}`,
        `   czas oczekiwania: ${r.days === null ? 'brak danych' : `${r.days} dni`}; oczekujący: ${r.awaiting ?? 'bd'}`,
        `   telefon: ${r.phone || 'bd'}; dostępność: ${flags || 'brak informacji'}`,
      ].join('\n');
    })
    .join('\n');
  const base = `Świadczenie: "${req.benefit}". Lista placówek (posortowana wg czasu oczekiwania):\n\n${list}`;
  const urgent =
    req.kase === 2
      ? '\n\nUWAGA: to jest PRZYPADEK PILNY (case=2) — zastosuj regułę z instrukcji systemowej.'
      : '';
  if (req.question?.trim()) {
    return `${base}${urgent}\n\nPytanie pacjenta: "${req.question.trim()}"\nOdpowiedz na pytanie, opierając się na liście.`;
  }
  return `${base}${urgent}\n\nZaproponuj najlepszą placówkę (i jedną alternatywę), krótko uzasadniając.`;
}

async function callProvider(
  cfg: { url: string; key: string; model: string },
  prompt: string,
): Promise<string> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI: pusta odpowiedź');
  return text;
}

/** Heurystyka lokalna — ta sama rola co LLM, bez kluczy. */
export function localAdvice(req: AiRequest): string {
  const usable = req.results.filter((r) => r.days !== null || r.awaiting !== null);
  if (!usable.length) {
    return 'Brak danych o kolejkach dla tego świadczenia. Sprawdź inne świadczenie lub skontaktuj się z placówką telefonicznie.';
  }
  const sorted = [...usable].sort((a, b) => {
    const da = a.days ?? 9999;
    const db = b.days ?? 9999;
    return da - db || (a.awaiting ?? 9e9) - (b.awaiting ?? 9e9);
  });
  const best = sorted[0];
  const alt = sorted[1];
  const fmt = (r: CompactRecord) =>
    `${r.provider} (${r.locality}) — ${r.days === null ? 'brak danych o czasie' : `${r.days} dni oczekiwania`}${r.awaiting !== null ? `, ${r.awaiting} os. w kolejce` : ''}`;
  const flags = Object.entries(best.flags)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  const lines = [
    `**Rekomendacja:** ${fmt(best)}.`,
    alt ? `**Alternatywa:** ${fmt(alt)}.` : null,
    best.phone ? `**Telefon:** ${best.phone} — warto potwierdzić dostępność przed wizytą.` : null,
    flags ? `**Udogodnienia:** ${flags}.` : null,
    req.question?.trim() ? `Pytanie: "${req.question.trim()}" — na podstawie danych NFZ najlepiej wypada powyższa placówka.` : null,
    req.kase === 2
      ? 'Przypadek jest pilny — przy nagłym pogorszeniu zdrowia udaj się na SOR lub zadzwoń na 112/999.'
      : null,
    'Ostateczny wybór placówki warto skonsultować z lekarzem POZ.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function advise(req: AiRequest): Promise<{ text: string; provider: string }> {
  const cfg = providerConfig();
  if (!cfg) return { text: localAdvice(req), provider: 'local' };
  try {
    return { text: await callProvider(cfg, userPrompt(req)), provider: cfg.model };
  } catch (err) {
    console.error('[ai] provider failed, falling back to local:', err);
    return { text: localAdvice(req), provider: 'local (fallback)' };
  }
}
