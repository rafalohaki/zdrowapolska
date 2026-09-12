# 💰 Finanse i gospodarka — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ NBP — kursy walut i ceny złota

Klasyk, idealny "pierwszy endpoint" do demonstracji. **Działa wprost z przeglądarki** (CORS `*`).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.nbp.pl/api/` |
| **Auth** | brak |
| **Format** | JSON / XML / CSV (parametr `?format=`) |
| **CORS** | ✅ `Access-Control-Allow-Origin: *` |
| **Dokumentacja** | [api.nbp.pl](https://api.nbp.pl/) |

### Endpointy

| Endpoint | Co zwraca |
|---|---|
| `/exchangerates/tables/A` · `/B` | tabele kursów średnich (A: główne waluty) |
| `/exchangerates/rates/{A\|B}/{code}/{od}/{do}` | historia kursu waluty (max 367 dni/zapytanie) |
| `/cenyzlota` · `/cenyzlota/{od}/{do}` | cena złota (1 g, próba 1000) |

### Przykład (przetestowany na żywo, 2026-09-07)

```bash
curl 'https://api.nbp.pl/api/exchangerates/tables/A?format=json'
```

```json
[ { "table": "A", "no": "173/A/NBP/2026", "effectiveDate": "2026-09-07",
    "rates": [ { "currency": "dolar amerykański", "code": "USD", "mid": 3.7085 }, ... ] } ]
```

```bash
curl 'https://api.nbp.pl/api/cenyzlota?format=json'
# → [ { "data": "2026-09-07", "cena": 534.70 } ]
```

### Pomysły na projekt

- Kalkulator walut z historycznym wykresem i AI komentarzem ("USD najtaniej od X miesięcy").
- Komponent "przelicz" do dowolnej apki (np. porównywarki cen).

---

## ✅ Ministerstwo Finansów — Biała Lista VAT (wykaz podatników VAT)

Weryfikacja kontrahenta: status VAT, REGON, KRS, adresy, reprezentanci, rachunki bankowe. Kluczowe przy walidacji płatności (ubezpieczenie rozliczeń MPP).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://wl-api.mf.gov.pl/api/` |
| **Auth** | brak |
| **Format** | JSON |
| **CORS** | ✅ odbija dowolny `Origin` |

### Przykład (przetestowany na żywo)

```bash
curl 'https://wl-api.mf.gov.pl/api/search/nip/5261040828?date=2026-09-07'
```

```json
{ "result": { "subject": {
    "name": "GŁÓWNY URZĄD STATYSTYCZNY",
    "nip": "5261040828", "statusVat": "Czynny", "regon": "000331501",
    "workingAddress": "ALEJA NIEPODLAGŁOŚCI 208, 00-925 WARSZAWA",
    "registrationLegalDate": "1996-01-29", ... } } }
```

Uwagi:
- Błędny NIP → `{"code":"WL-115","message":"Nieprawidłowy NIP."}` (suma kontrolna sprawdzaj lokalnie przed zapytaniem).
- Zapytanie **partiami** (`/api/search/nips/{nip1,nip2,...}?date=`) — ⚠️ sprawdź aktualny limit paczki w dokumentacji MF.
- Daty tylko od 2019-09-08 (start rejestru).

### Pomysły na projekt

- **Walidator kontrahentów dla firm**: wklejasz listę NIP-ów → raport statusu VAT + rachunki + AI podsumowanie ryzyka.

---

## ⚠️ Kandydaci (warte sprawdzenia, bez pewnego REST)

- **CEIDG** — dane jednoosobowych działalności; API z **darmowym kluczem**: [datastore.ceidg.gov.pl](https://datastore.ceidg.gov.pl/).
- **eKRS** — przeglądarka spraw i dokumenty finansowe spółek: [ekrs.ms.gov.pl](https://ekrs.ms.gov.pl/) (brak wygodnego REST; odpisy do pobrania).
- **CRBR** — beneficjenci rzeczywisti: dane otwarte do pobrania ([crbr.gov.pl](https://www.crbr.gov.pl/)).
- **KRS Open / rejestr.io** — projekty społecznościowe z API (licencje/limity do sprawdzenia).
