# 🏥 Zdrowie — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07** (środowisko: Linux, curl)

---

## ✅ NFZ — API Terminy Leczenia (ITL) v1.4

Najbardziej wartościowe publiczne API zdrowotne w Polsce: **realne czasy oczekiwania** do lekarzy specjalistów i szpitali, w całym kraju, bez klucza.

| Parametr | Wartość |
|---|---|
| **Baza** | `https://apinfz.nfz.gov.pl/app-itl-api-pcus/` |
| **Auth** | brak (w pełni publiczne) |
| **Format** | JSON (struktura `meta` / `links` / `data`) |
| **CORS** | ❌ **BRAK** — wymagane proxy serwerowe (preflight `OPTIONS` → 405) |
| **Limity** | paginacja `limit` **1–25** (400 przy większym), `page` |
| **Świeżość danych** | aktualizacje **miesięczne** (`date-situation-as-at`), nie real-time |
| **Specyfikacja** | zapisana lokalnie: [api-specs/nfz-itl-v1.4.json](api-specs/nfz-itl-v1.4.json) · [Swagger UI](https://apinfz.nfz.gov.pl/app-itl-api-pcus/) |
| **Kategoria HackYeah** | Sport & Healthcare |

### Endpointy

| Endpoint | Rola |
|---|---|
| `GET /benefits?name=...` | słownik świadczeń (zwraca **nazwy jako stringi**) |
| `GET /places?name=...` / `GET /localities?...` / `GET /streets?...` | słowniki geograficzne |
| `GET /providers?province=...&name=...` | placówki (lecznicy, szpitale) |
| `GET /queues?benefit=...&province=...` | **główne wyszukiwanie** — kolejki + czasy oczekiwania |
| `GET /queues/{id}` · `GET /many-places/{id}` | szczegóły pojedynczej kolejki |
| `GET /version` | wersja API (np. `1.4.0`) |

### Przykład (przetestowany na żywo)

```bash
# 1. Znajdź dokładną nazwę świadczenia (dopasowanie po fragmencie)
curl 'https://apinfz.nfz.gov.pl/app-itl-api-pcus/benefits?name=kardiolog&limit=10&format=json'
# → data: ["KARDIOLOGICZNA TELEREHABILITACJA...", "ODDZIAŁ KARDIOLOGICZNY", ...]

# 2. Wyszukaj kolejki (06 = małopolskie!)
curl 'https://apinfz.nfz.gov.pl/app-itl-api-pcus/queues?benefit=ODDZIA%C5%81%20KARDIOLOGICZNY&province=06&limit=2&format=json'
```

Fragment prawdziwej odpowiedzi (`/queues`, 24 rekordy dla małopolskiego):

```json
{
  "type": "queue",
  "id": "5987e024-7796-22b6-e063-b4200a0a288a",
  "attributes": {
    "benefit": "ODDZIAŁ KARDIOLOGICZNY",
    "provider": "ZESPÓŁ OPIEKI ZDROWOTNEJ W SUCHEJ BESKIDZKIEJ",
    "address": "SZPITALNA 22", "locality": "SUCHA BESKIDZKA",
    "phone": "+48 33 872 31 00",
    "ramp": "Y", "elevator": "Y", "toilet": "Y", "wheelchairs": "Y",
    "ac": "Y", "automatic-door": "Y", "public-transport-lines": "BUS",
    "benefits-for-children": "N",
    "statistics": { "provider-data": { "awaiting": 0, "average-period": 0, "update": "2026-07" } },
    "dates": { "pcus": "0 dni", "date-situation-as-at": "2026-08-07" }
  }
}
```

### Kody województw (oddziały NFZ — uwaga, NIE TERYT!)

`01` dolnośląskie · `02` kujawsko-pomorskie · `03` lubelskie · `04` lubuskie · `05` łódzkie · **`06` małopolskie** · **`07` mazowieckie** · `08` opolskie · `09` podkarpackie · `10` podlaskie · `11` pomorskie · **`12` śląskie** · `13` świętokrzyskie · `14` warmińsko-mazurskie · `15` wielkopolskie · `16` zachodniopomorskie

### Pułapki (zweryfikowane praktyką)

- **Brak CORS** — czysta apka frontendowa nie zadziała; potrzebne małe proxy (Express / serverless function) + cache słowników.
- **API NIE zwraca konkretnych terminów wizyt** (nie ma parametrów zakresu dat). Zwraca statystyki kolejek: liczba oczekujących, średni czas oczekiwania, `pcus` (np. "0 dni", "3 miesiące"). Pitch: **porównywarka czasów oczekiwania**, nie wyszukiwarka wolnych slotów.
- `/benefits` zwraca zwykłe stringi; do `/queues` trzeba podać **dokładną** nazwę świadczenia ("PORADNIA KARDIOLOGICZNA" → 0 wyników, bo taka nazwa nie istnieje w słowniku).
- `latitude`/`longitude` często `null` → mapa wymaga osobnego geokodowania (patrz [08-geodane.md](08-geodane.md)).
- Imperva WAF przed API — nie odpytuj agresywnie, cache'uj słowniki.

### Pomysły na projekt

- **Porównywarka czasów oczekiwania**: "kardiolog najszybciej" — sortowanie po `average-period` / `awaiting`.
- **Filtr dostępności dla osób z niepełnosprawnościami** (`ramp`, `elevator`, `wheelchairs`...) — realny wyróżnik, mało kto to eksponuje.
- **Agent AI doradca**: analizuje dostępność, dojazd (`public-transport-lines`), statystyki i odpowiada na pytania o przygotowanie do wizyty.

---

## ⚠️ Rejestry medyczne MZ (RPL — Rejestr Produktów Leczniczych itp.)

Portal: [rejestrymedyczne.ezdrowie.gov.pl](https://rejestrymedyczne.ezdrowie.gov.pl/) (z tego środowiska odpowiada redirectem 302; API do sprawdzenia).
Zbiory produktów leczniczych, podmiotów odpowiedzialnych, refundacji — często dostępne też jako pliki przez dane.gov.pl. Sprawdź przed hackathonem, czy jest wygodne API czy tylko pliki.

## ⚠️ Inne (bez publicznego API REST)

- **ZUS** — statystyki i dane o świadczeniach jako pliki/raporty: [zus.pl](https://www.zus.pl/) → dane statystyczne.
- **e-ZLA** — brak publicznego API (dane dla lekarzy/pracodawców po autoryzacji).
- Zbiory zdrowotne na [dane.gov.pl](https://dane.gov.pl) (szukaj: "NFZ", "świadczenia", "infekcje") — patrz [02-dane-i-statystyka.md](02-dane-i-statystyka.md).
