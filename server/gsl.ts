/**
 * Integracja z „Gdzie się leczyć" (GSL) — placówki i pomoc NFZ poza terminami leczenia.
 *
 * GSL nie ma publicznego REST API — używamy jego AJAX-owych endpointów wyszukiwania
 * (te same, które obsługuje oficjalna strona) i parsujemy fragmenty HTML.
 * Zapytania są jednostkowe (1 województwo = 1 żądanie), cache'owane w Redisie.
 */

const GSL_BASE = 'https://gsl.nfz.gov.pl/GSL/GSLAdapt';

export const GSL_CATEGORIES = {
  poz: { route: 'POZSearch', label: 'POZ — rodzinny lekarz', group: 'leczenie' },
  aos: { route: 'AOSSearch', label: 'Przychodnie specjalistyczne (AOS)', group: 'leczenie' },
  szpitale: { route: 'SzpitaleSearch', label: 'Szpitale i opieka całodobowa', group: 'leczenie' },
  stomatologia: { route: 'LeczenieStomatologiczneSearch', label: 'Leczenie stomatologiczne', group: 'leczenie' },
  diagnostyka: { route: 'BadaniaDiagnostyczneSearch', label: 'Badania diagnostyczne', group: 'leczenie' },
  sor: { route: 'SORSearch', label: 'SOR', group: 'pomoc' },
  izba: { route: 'IzbaPrzyjecSearch', label: 'Izby przyjęć', group: 'pomoc' },
  nocna: { route: 'PomocNocnaSearch', label: 'Nocna i świąteczna pomoc', group: 'pomoc' },
  pomocMedyczna: { route: 'PomocMedycznaSearch', label: 'Pomoc medyczna nagła', group: 'pomoc' },
  ambulatoryjne: { route: 'LeczenieAmbulatoryjneDorazneSearch', label: 'Ambulatoryjna pomoc doraźna', group: 'pomoc' },
  apteki: { route: 'AptekiReceptySearch', label: 'Apteki (z receptą)', group: 'apteki' },
  zpo: { route: 'ZPOSearch', label: 'Zaopatrzenie (ortopedia, optyka)', group: 'programy' },
  profilaktyka: { route: 'ProgramyProfilaktyczneSearch', label: 'Programy profilaktyczne', group: 'programy' },
  programyLekowe: { route: 'ProgramyLekoweSearch', label: 'Programy lekowe', group: 'programy' },
  opieka: { route: 'OpiekaKoordynowanaSearch', label: 'Opieka koordynowana', group: 'programy' },
  onkologia: { route: 'SciezkaOnkologicznaSearch', label: 'Szybka ścieżka onkologiczna (DiLO)', group: 'programy' },
  pozostale: { route: 'PozostaleSwiadczeniaSearch', label: 'Pozostałe świadczenia', group: 'programy' },
} as const;

export type GslCategory = keyof typeof GSL_CATEGORIES;

export type GslFacility = { name: string; address: string; phone: string };

export type GslResult = {
  category: GslCategory;
  province: string;
  total: number;
  results: GslFacility[];
  page: number;
};

/**
 * GSL trzyma wyniki wyszukiwania w sesji — paginacja ({Kategoria}Page) działa tylko
 * z ciasteczkami sesji, w której wykonano Search. Utrzymujemy słoiki cookies per kontekst.
 */
const sessions = new Map<string, string>();

function sessionCookie(key: string): string | undefined {
  return sessions.get(key);
}

function storeCookies(key: string, res: Response): void {
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!setCookies.length) return;
  const jar = new Map<string, string>();
  for (const existing of (sessions.get(key) ?? '').split('; ').filter(Boolean)) {
    const [n, ...v] = existing.split('=');
    jar.set(n, v.join('='));
  }
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  sessions.set(key, [...jar].map(([n, v]) => `${n}=${v}`).join('; '));
  if (sessions.size > 200) sessions.delete(sessions.keys().next().value as string);
}

/** Wyjątki od reguły Search→Page: GSL używa liczby pojedynczej / innej nazwy. */
const PAGE_ROUTE_OVERRIDE: Partial<Record<GslCategory, string>> = {
  szpitale: 'SzpitalPage',
};

/** Trasa paginacji wykryta z HTML (najbardziej odporne na zmiany po stronie NFZ). */
const discoveredPageRoutes = new Map<GslCategory, string>();

function searchToPageRoute(route: string): string {
  return route.endsWith('Search') ? `${route.slice(0, -6)}Page` : route;
}

function pageRouteFor(category: GslCategory): string {
  return (
    discoveredPageRoutes.get(category) ??
    PAGE_ROUTE_OVERRIDE[category] ??
    searchToPageRoute(GSL_CATEGORIES[category].route)
  );
}

/** Wyciąga prawdziwą trasę paginacji z linków w HTML (np. SzpitalPage dla SzpitaleSearch). */
function discoverPageRoute(category: GslCategory, html: string): void {
  const m = html.match(/\/GSL\/GSLAdapt\/([A-Za-z]+Page)\?/);
  if (m) discoveredPageRoutes.set(category, m[1]);
}

function parseTotal(html: string): number {
  const m = html.match(/Znaleziono (\d+) wynik/);
  return m ? Number(m[1]) : 0;
}

function searchUrl(route: string, province: string, name: string): string {
  const params = new URLSearchParams({ wojewodztwo: province });
  if (name) params.set('nazwa', name);
  return `${GSL_BASE}/${route}?${params}`;
}

function pageUrl(pageRoute: string, page: number, total: number): string {
  const params = new URLSearchParams({
    Page: String(page),
    PageSize: '10',
    ShowProgress: 'False',
    TotalCount: String(total),
  });
  return `${GSL_BASE}/${pageRoute}?${params}`;
}


export async function gslFacilities(
  category: GslCategory,
  province: string,
  name = '',
  page = 1,
): Promise<GslResult> {
  const { route } = GSL_CATEGORIES[category];
  const sessKey = `${category}:${province}:${name.toLowerCase()}`;
  const safePage = Number.isFinite(page) ? Math.max(1, Math.min(Math.floor(page), 68)) : 1;
  let cookie = sessionCookie(sessKey);
  let total = 0;


  const doSearchWithCookies = async (): Promise<string> => {
    const res = await fetch(searchUrl(route, province, name), {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GSL ${res.status} dla ${category}/${province} str. 1`);
    storeCookies(sessKey, res);
    cookie = sessionCookie(sessKey) ?? cookie;
    const html = await res.text();
    total = parseTotal(html) || total;
    discoverPageRoute(category, html);
    return html;
  };

  if (safePage <= 1) {
    const html = await doSearchWithCookies();
    return { category, province, total: parseTotal(html), results: parseGslResults(html), page: 1 };
  }

  // Strona >1 wymaga sesji, w której wykonano Search. Brak ciasteczka (zimny start,
  // restart procesu, wygasły cache) → najpierw Search, potem Page w tym samym wywołaniu.
  if (!cookie) {
    await doSearchWithCookies();
    cookie = sessionCookie(sessKey);
  }

  const fetchPage = async (): Promise<string> => {
    const res = await fetch(pageUrl(pageRouteFor(category), safePage, total), {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html, */*; q=0.01',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = new Error(`GSL ${res.status} dla ${category}/${province} str. ${safePage}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      try {
        await res.text();
      } catch {
        /* ignorujemy treść błędu */
      }
      throw err;
    }
    storeCookies(sessKey, res);
    cookie = sessionCookie(sessKey) ?? cookie;
    const html = await res.text();
    total = parseTotal(html) || total;
    discoverPageRoute(category, html);
    return html;
  };

  try {
    const html = await fetchPage();
    return { category, province, total, results: parseGslResults(html), page: safePage };
  } catch (err) {
    // Przestarzała sesja (GSL trzyma wyniki w sesji ASP.NET) albo zła trasa paginacji
    // po stronie NFZ → odtwórz sesję przez Search i spróbuj Page raz jeszcze.
    sessions.delete(sessKey);
    cookie = undefined;
    await doSearchWithCookies();
    cookie = sessionCookie(sessKey);
    try {
      const html = await fetchPage();
      return { category, province, total, results: parseGslResults(html), page: safePage };
    } catch {
      throw err;
    }
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&#(\d+);/g, (_, code) => {
    const n = Number(code);
    // patologiczne encje z upstreamu nie mogą wywalić parse'a (RangeError)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  })
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Parsuje fragment HTML GSL na listę placówek (nazwa / adres / telefony z labelkami). */
export function parseGslResults(html: string): GslFacility[] {
  const chunks = html.split('class="ResultsDetails"').slice(1);
  const results: GslFacility[] = [];

  for (const chunk of chunks) {
    const text = decodeEntities(
      chunk
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, '|')
        .replace(/\|+/g, '|'),
    );
    const parts = text
      .split('|')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 1);
    if (parts.length === 0) continue;

    const name = parts[0];
    const address =
      parts.find((p) => /\d{2}-\d{3}\s/.test(p) || /^(ul\.|al\.|os\.|pl\.|rynek|ulica)/i.test(p)) ??
      '';
    // telefony: „Telefon do informacji:" preferowany, potem „do rejestracji" i inne
    const phones = [...text.matchAll(/Telefon do [a-ząęó]+:\s*([+\d][\d\s()-]{6,})/gi)].map((m) =>
      m[1].trim(),
    );
    const phone = phones[0] ?? '';

    if (name) results.push({ name, address, phone });
  }
  return results;
}

