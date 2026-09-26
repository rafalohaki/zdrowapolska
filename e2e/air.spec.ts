import { expect, test, type Page } from '@playwright/test';

// Smoke widoku „Powietrze” na mockach page.route — webServer w playwright.config.ts
// to wyłącznie `vite preview` (bez backendu), a API_BASE w buildzie preview jest
// absolutne (yeapi.wpme.pl, src/lib/api.ts:58-59). Glob **/api/air* łapie więc
// i /api/air, i /api/air-stations — niezależnie od domeny żądania. Mockujemy też
// żądania startowe: mount od razu ładuje Kraków (air?station=400, AirView.tsx),
// a debounce autouzupełniania odpytuje air-stations przy wpisywaniu.

const AIR_STATIONS = {
  items: [
    { id: 756, name: 'Busko-Zdrój, ul. Ożarów', city: 'Busko-Zdrój', brakNaZywo: true },
    { id: 400, name: 'Kraków, Aleja Krasińskiego', city: 'Kraków' },
  ],
};

const AIR_400 = {
  station: { id: 400, name: 'Kraków, Aleja Krasińskiego', city: 'Kraków', street: null },
  kategoria: 'Umiarkowany',
  kategoriaEfektywna: 'Umiarkowany',
  zrodloKategorii: 'gios',
  wartosc: 65,
  dataObliczen: '2026-09-26T12:00:00',
  dataZrodlowa: null,
  pollutants: [{ wskaznik: 'PM10', kategoria: 'Umiarkowany', wartosc: 65 }],
  advice: 'Możesz trenować na zewnątrz, ale osoby wrażliwe niech ograniczą intensywny wysiłek.',
  alternatives: [],
  distanceKm: 0,
  community: null,
  airly: null,
  sources: { gios: 'ok', community: 'empty', airly: 'off' },
};

// scena Buska po naprawach: stacja manualna 756 bez indeksu GIOŚ, kategoria
// efektywna z czujników obywatelskich (~36 km), klikalny Solec z żywym indeksem
const AIR_756 = {
  station: { id: 756, name: 'Busko-Zdrój, ul. Ożarów', city: 'Busko-Zdrój', street: null },
  kategoria: null,
  kategoriaEfektywna: 'Bardzo dobry',
  zrodloKategorii: 'community',
  wartosc: null,
  dataObliczen: null,
  dataZrodlowa: null,
  pollutants: [],
  advice: 'Idealne warunki do aktywności na zewnątrz — biegaj, jeździj, trenuj bez ograniczeń.',
  alternatives: [
    { id: 20568, name: 'Solec-Zdrój, ul. Buska', city: 'Solec-Zdrój', kategoria: 'Dobry', distanceKm: 6.9 },
  ],
  distanceKm: null,
  community: {
    count: 18,
    pm25: 8.4,
    pm10: 12.1,
    nearestKm: 36.3,
    kategoria: 'Bardzo dobry',
    measuredAt: '2026-09-26T10:00:00',
    radiusKm: 50,
  },
  airly: null,
  sources: { gios: 'ok', community: 'ok', airly: 'off' },
};

// Mock na globie **/api/air* (łapie też /api/air-stations) — rozgałęzienie
// po pathname + liczniki żądań do asercji.
async function mockAirApi(page: Page) {
  const counts = { station756: 0, locality: 0 };
  let station756Ok = true;
  await page.route('**/api/air*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/air-stations') {
      await route.fulfill({ json: AIR_STATIONS });
      return;
    }
    if (url.pathname !== '/api/air') {
      await route.fulfill({ json: {} }); // inne „air*” — test ich nie dotyka
      return;
    }
    const station = url.searchParams.get('station');
    if (station === '756') {
      counts.station756++;
      if (!station756Ok) {
        await route.fulfill({
          status: 502,
          json: { error: 'GIOŚ chwilowo niedostępna — spróbuj za chwilę.' },
        });
        return;
      }
      await route.fulfill({ json: AIR_756 });
      return;
    }
    if (url.searchParams.get('locality')) counts.locality++;
    await route.fulfill({ json: station === '400' ? AIR_400 : AIR_756 });
  });
  return {
    counts,
    setStation756Ok: (ok: boolean) => {
      station756Ok = ok;
    },
  };
}

/** Wpisz „busko” i wybierz podpowiedź stacji 756 (dokładna ścieżka użytkownika). */
async function pickBusko(page: Page): Promise<void> {
  await page.getByLabel('Miejscowość').fill('busko');
  await page.getByRole('option', { name: /Busko-Zdrój, ul\. Ożarów/ }).click();
}

test.describe('Widok Powietrze — stany z rundy napraw (mocki API, bez żywego GIOŚ)', () => {
  test('podpowiedź Buska ma adnotację „brak danych na żywo”', async ({ page }) => {
    await mockAirApi(page);
    await page.goto('/?mode=powietrze');
    // mount ładuje Kraków przez air?station=400 — karta startowa z mocka
    await expect(page.getByRole('heading', { name: 'Kraków, Aleja Krasińskiego' })).toBeVisible();

    await page.getByLabel('Miejscowość').fill('busko');
    const option = page.getByRole('option', { name: /Busko-Zdrój, ul\. Ożarów/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText('brak danych na żywo');
  });

  test('karta 756: pigułka z czujników (bez „indeks GIOŚ”) + klikalny Solec w alternatywach', async ({ page }) => {
    await mockAirApi(page);
    await page.goto('/?mode=powietrze');
    await expect(page.getByRole('heading', { name: 'Kraków, Aleja Krasińskiego' })).toBeVisible();
    await pickBusko(page);

    await expect(page.getByRole('heading', { name: 'Busko-Zdrój, ul. Ożarów' })).toBeVisible();
    // pigułka kategorii efektywnej z podpisem źródła (czujniki + dystans najbliższego)
    await expect(page.getByText('Bardzo dobry', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/szacunek z czujników obywatelskich \(najbliższy ~36\.3 km\)/),
    ).toBeVisible();
    // rozbieżność „indeks GIOŚ: —” pod pigułką nigdy nie może się renderować
    await expect(page.getByText(/indeks GIOŚ:/)).toHaveCount(0);
    // sekcja alternatyw z klikalnym Solecem (żywy indeks, ~6,9 km)
    await expect(page.getByText('Inne stacje w okolicy')).toBeVisible();
    await expect(page.getByRole('button', { name: /Solec-Zdrój, ul\. Buska/ })).toBeVisible();
  });

  test('502 na air?station= nie odpala fallbacku locality — banner i „Spróbuj ponownie”', async ({ page }) => {
    const mock = await mockAirApi(page);
    mock.setStation756Ok(false);
    await page.goto('/?mode=powietrze');
    await expect(page.getByRole('heading', { name: 'Kraków, Aleja Krasińskiego' })).toBeVisible();
    await pickBusko(page);

    await expect(page.getByText('GIOŚ chwilowo niedostępna — spróbuj za chwilę.')).toBeVisible();
    // poz. 5b: 5xx krótko trafia do bannera — dokładnie JEDNO żądanie station=,
    // ZERO drugiego pełnego żądania locality w tle
    expect(mock.counts.station756).toBe(1);
    expect(mock.counts.locality).toBe(0);
    await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible();

    // klik → ponowne żądanie z kontekstem (station=756), tym razem z danymi
    mock.setStation756Ok(true);
    await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
    await expect(page.getByRole('heading', { name: 'Busko-Zdrój, ul. Ożarów' })).toBeVisible();
    expect(mock.counts.station756).toBe(2);
  });
});
