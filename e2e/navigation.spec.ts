import { expect, test } from '@playwright/test';

// Regresja zgłoszonego błędu: nawigacja trybów gubiła się (URL kłamał, refresh cofał widok).
// Pigułka „Kryzys? 116 111” została usunięta z nagłówka (myląca bez kontekstu) —
// telefony kryzysowe żyją w widoku „Wsparcie psychiczne”.
test('Nawigacja trybów z pamięcią URL (bez pigułki w headerze)', async ({ page }) => {
  await page.goto('/?mode=terminy');
  await expect(page.getByRole('link', { name: /Kryzys psychiczny/ })).toHaveCount(0);

  await page.getByRole('navigation').getByRole('button', { name: 'Wsparcie psychiczne' }).click();
  await expect(page.getByRole('heading', { name: 'Wsparcie psychiczne' })).toBeVisible();
  await expect(page).toHaveURL(/mode=wsparcie/);

  // telefony kryzysowe są w widoku wsparcia (karty 116 111 / 116 123 / 112)
  await expect(page.getByRole('link', { name: /116 111/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /116 123/ }).first()).toBeVisible();

  // refresh nie cofa widoku (to był zgłaszany błąd)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Wsparcie psychiczne' })).toBeVisible();

  // wstecz wraca do terminów
  await page.goBack();
  await expect(page.getByRole('heading', { name: /Gdzie do.*najszybciej/ })).toBeVisible();
});

test('bezpośredni link ?mode=placowki otwiera placówki', async ({ page }) => {
  await page.goto('/?mode=placowki');
  await expect(page.getByRole('heading', { name: 'Placówki i pomoc NFZ' })).toBeVisible();
});
