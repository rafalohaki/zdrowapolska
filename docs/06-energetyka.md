# ⚡ Energetyka — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ PSE — Dane raportowe (Polskie Sieci Elektroenergetyczne)

Pełne dane polskiego systemu elektroenergetycznego: **ceny rynku dnia następnego (w PLN!)**, bilansowanie, generacja JWCD, zapotrzebowanie KSE. Ponad **180 zasobów** w specyfikacji OpenAPI.

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.raporty.pse.pl/api/` |
| **Auth** | brak |
| **Format** | JSON |
| **CORS** | ✅ `Access-Control-Allow-Origin: *` |
| **Składnia zapytań** | **OData-style**: `$filter`, `$first`, `$after` (paginacja przez `nextLink`) |
| **Specyfikacja** | zapisana lokalnie: [api-specs/pse-raporty.json](api-specs/pse-raporty.json) (665 KB, 180 ścieżek) · live: [`/api/openapi`](https://api.raporty.pse.pl/api/openapi) |

### Przykład (przetestowany na żywo) — ceny RDN w PLN

```bash
curl 'https://api.raporty.pse.pl/api/csdac-pln?$filter=business_date%20eq%20%272026-09-07%27&$first=2'
```

```json
{ "value": [
    { "dtime": "2026-09-07 00:15", "period": "00:00 - 00:15",
      "csdac_pln": 727.22, "business_date": "2026-09-07",
      "publication_ts": "2026-09-06 14:22:24.403" },
    { "dtime": "2026-09-07 00:30", "period": "00:15 - 00:30", "csdac_pln": 670.18 } ],
  "nextLink": "https://api.raporty.pse.pl/api/csdac-pln?...&$after=..." }
```

⚠️ Uwaga na składnię: encje nie przyjmują zwykłych parametrów (`?business_date=` → 400). Tylko `$filter` itd. W shellu cytuj `$` pojedynczymi cudzysłowami. Rynek rozliczany w **okresach 15-minutowych** (nie godzinowych!).

### Zasoby warte uwagi (spośród 180)

- `csdac-pln` — ceny RDN (PLN/MWh)
- `cmbp-tp`, `cmbu-tu` — bilansowanie, moc operacyjna
- `eb-rozl`, `crb-rozl` — rozliczenia rynku bilansującego
- Pełna lista: w zapisanej specyfikacji (pole `paths`).

### Pomysły na projekt

- **"Tanie prąd" alarm**: wykres cen na jutro + AI podpowiada godziny na pranie/ładowanie auta (integracja z taryfami dynamicznymi!). Bardzo "smart-home".
- Dashboard energetyczny: cena RDN + generacja + zapotrzebowanie w czasie rzeczywistym.
- Kategoria HackYeah: Smart City, Artificial Intelligence (optymalizacja zużycia).
