import { expect, test } from '@playwright/test';

test('triage pokazuje właściwe panele', async ({ page }) => {
  await page.goto('/?mode=wsparcie');
  await expect(page.getByRole('heading', { name: 'Wsparcie psychiczne' })).toBeVisible();

  await page.getByRole('button', { name: /Szukam dla bliskiej osoby/ }).click();
  await expect(page.getByText('Jak być obok:')).toBeVisible();

  await page.getByRole('button', { name: /Jest źle TERAZ/ }).click();
  await expect(page.getByText(/wystarczy powiedzieć/)).toBeVisible();
});

test('triage „planowo" przewija do listy', async ({ page }) => {
  await page.goto('/?mode=wsparcie');
  await page.getByRole('button', { name: /Szukam pomocy planowo/ }).click();
  await expect(page.getByRole('heading', { name: 'Poradnie zdrowia psychicznego' })).toBeInViewport({
    timeout: 10_000,
  });
});

test('kryzysowe telefony i lista z kolejkami', async ({ page }) => {
  await page.goto('/?mode=wsparcie');

  for (const href of ['tel:116111', 'tel:116123', 'tel:112']) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
  }

  // lista placówek z żywego GSL (chwilę trwa: sesja NFZ + Nominatim)
  await expect(page.locator('ul.facilities-print-list > li').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Kolejka: \d+ (dzień|dni)|Kolejka: ~\d+ mies\./).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/Twój plan w 3 krokach/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Drukuj listę' })).toBeVisible();
});
