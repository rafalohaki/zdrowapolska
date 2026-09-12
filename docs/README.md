# 🇵🇱 Polskie publiczne API — baza wiedzy na hackathon

Praktyczny, **zweryfikowany na żywo** przegląd wartościowych polskich publicznych API (dane.gov.pl, GUS, NFZ, GIOŚ, IMGW, NBP, MF, Sejm, PSE, CEPiK, GUGiK...). Każde API ma przykłady zapytań z prawdziwymi odpowiedziami, informacje o CORS, autoryzacji i pułapkach — wszystko po to, żeby na hackathonie (HackYeah 2026: **3–4.10, Kraków**) nie tracić godzin na odkrywanie oczywistego.

> **Metodyka:** wszystkie API ze statusem ✅/🟡 odpytane na żywo **2026-09-07** (curl, Linux). Fragmenty odpowiedzi w dokumentach są prawdziwe, nie wymyślone. Statusy: ✅ zweryfikowane w pełni · 🟡 częściowo · ⚠️ do weryfikacji przed użyciem.

## 📁 Dokumenty po kategoriach

| Plik | Zawartość |
|---|---|
| [01-zdrowie.md](01-zdrowie.md) | **NFZ Terminy Leczenia** (główne API zdrowotne) + rejestry MZ |
| [02-dane-i-statystyka.md](02-dane-i-statystyka.md) | **dane.gov.pl**, **GUS BDL**, PKW, eTeryt |
| [03-srodowisko-pogoda.md](03-srodowisko-pogoda.md) | **GIOŚ** (powietrze), **IMGW** (pogoda + hydro) |
| [04-finanse-gospodarka.md](04-finanse-gospodarka.md) | **NBP** (kursy, złoto), **MF Biała Lista VAT**, CEIDG/KRS/CRBR |
| [05-prawo-panstwo.md](05-prawo-panstwo.md) | **api.sejm.gov.pl** (prawo, legislacja, głosowania) |
| [06-energetyka.md](06-energetyka.md) | **PSE** (ceny energii, bilansowanie — 180 zasobów) |
| [07-transport-smart-city.md](07-transport-smart-city.md) | **CEPiK**, ZTM Warszawa, otwarte dane miast, GTFS |
| [08-geodane.md](08-geodane.md) | **GUGiK**: ULDK, EMUiA, Geoportal, NMT |
| [api-specs/](api-specs/) | **zapisane specyfikacje OpenAPI/Swagger** (NFZ, dane.gov.pl, PSE) |

## 🎯 Ściąga decyzyjna — "co użyć?"

| Chcę... | Użyj | CORS z przeglądarki? |
|---|---|---|
| Znaleźć najszybszy termin do lekarza | NFZ ITL ([01](01-zdrowie.md)) | ❌ proxy |
| Pogoda / stany rzek na żywo | IMGW ([03](03-srodowisko-pogoda.md)) | ✅ `*` |
| Jakość powietrza | GIOŚ ([03](03-srodowisko-pogoda.md)) | ⚠️ tylko dla `powietrze.gios.gov.pl` → proxy |
| Kursy walut / złoto | NBP ([04](04-finanse-gospodarka.md)) | ✅ `*` |
| Statystyki (gminy, powiaty...) | GUS BDL ([02](02-dane-i-statystyka.md)) | ⚠️ sprawdź; wymaga darmowego klucza |
| Katalog + dane otwarte | dane.gov.pl ([02](02-dane-i-statystyka.md)) | ✅ odbija Origin |
| Weryfikacja kontrahenta VAT | MF Biała Lista ([04](04-finanse-gospodarka.md)) | ✅ odbija Origin |
| Prawo, ustawy, głosowania | Sejm ELI ([05](05-prawo-panstwo.md)) | ✅ odbija Origin |
| Ceny prądu (RDN, 15-min) | PSE ([06](06-energetyka.md)) | ✅ `*` |
| Pojazdy, prawa jazdy | CEPiK ([07](07-transport-smart-city.md)) | ❌ proxy + łata TLS |
| Geokodowanie / mapy | GUGiK ULDK/EMUiA ([08](08-geodane.md)) | ⚠️ sprawdź |

## 🔑 Najważniejsze wnioski z weryfikacji (2026-09-07)

1. **CORS to filtr wyboru API.** Z przeglądarki wprost działają: NBP, IMGW, PSE (`*`) oraz Sejm, MF, dane.gov.pl (odbijają Origin). **NFZ, CEPiK i GIOŚ wymagają proxy serwerowego** — zaplanuj miniproxy z cache'em w architekturze od minuty zero.
2. **API NFZ nie zwraca konkretnych terminów wizyt** — zwraca statystyki kolejek (oczekujący, średni czas, `pcus` "X dni"). Sprzedawaj projekt jako *porównywarkę czasów oczekiwania*, nie wyszukiwarkę slotów. Paginacja: max **25** rekordów.
3. **Kody województw ≠ TERYT**: w NFZ `06` = małopolskie, `07` = mazowieckie. Sprawdzaj słowniki, nie zgaduj.
4. **CEPiK ma słabe szyfrowanie TLS** (DH) — curl/Node wymagają obniżenia `SECLEVEL`; trzymaj to w proxy.
5. **dane.gov.pl to nie CKAN** — nowy JSON:API (`/search`, `/resources/{id}/data`), stara składnia `/3/action/*` zwraca 404.
6. **PSE mówi OData** (`$filter`, `$first`, `$after`), rynek rozliczany co **15 minut**.
7. Zapisz sobie specyfikacje (`docs/api-specs/`) — świetny kontekst dla agenta AI i generatora klientów.

## 🏗️ Sugerowana architektura apki

```
React/Vite (frontend)
   │  (bezpośrednio: NBP, IMGW, PSE, Sejm, MF, dane.gov.pl)
   ▼
Mini-proxy (Express / serverless, cache 10-60 min)   ← NFZ, GIOŚ, CEPiK, GUS BDL
   │
   └── AI layer (Groq/OpenRouter): analiza wyników, doradca, streszczenia
```

## 🧭 Mapowanie na kategorie HackYeah 2026 (3–4.10, Kraków)

| Kategoria | Naturalne API |
|---|---|
| Sport & Healthcare | NFZ, GIOŚ, IMGW |
| Smart City | IMGW hydro, PSE, dane miast, GUGiK |
| Artificial Intelligence | Sejm (asystent prawny), NFZ (doradca), dane.gov.pl (meta-search) |
| Defense | GUGiK (geoanalizy), PSE (krytyczna infrastruktura) |
