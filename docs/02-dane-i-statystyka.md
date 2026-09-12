# 📊 Dane otwarte i statystyka — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ dane.gov.pl — Portal Otwartych Danych (katalog + dostęp do danych)

Centralny katalog otwartych danych administracji publicznej: tysiące zbiorów (transport, zdrowie, geodezja, finanse...). **Uwaga: to NIE jest klasyczny CKAN** — stary schemat `/3/action/*` zwraca 404.

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.dane.gov.pl` |
| **Auth** | brak |
| **Format** | JSON:API 1.4 |
| **CORS** | ✅ odbija dowolny `Origin` — działa wprost z przeglądarki |
| **Specyfikacja** | zapisana lokalnie: [api-specs/dane-gov-pl.json](api-specs/dane-gov-pl.json) · Swagger UI: [/doc](https://api.dane.gov.pl/doc) |

### Endpointy (20 ścieżek w specyfikacji)

`/institutions`, `/institutions/{id}/datasets`, `/datasets`, `/datasets/{id}/resources`, `/resources/{id}/data` (**bezpośredni odczyt danych!**), `/resources/{id}/data/{row_id}`, `/search`, `/showcases`, `/dga-aggregated`

### Przykład (przetestowany na żywo)

```bash
curl 'https://api.dane.gov.pl/search?q=jakosc%20powietrza&page=1&per_page=2'
```

```json
{
  "links": { "next": ".../search?page=2&per_page=2&q=jakosc%20powietrza", "last": ".../search?page=157..." },
  "data": [ { "type": "common",
              "links": { "self": "https://api.dane.gov.pl/resources/19566,portal-jakosci-powietrza" } } ]
}
```

### Pomysły na projekt

- Meta-wyszukiwarka danych publicznych z podglądem (`/resources/{id}/data`) i AI, które tłumaczy "co jest w tym zbiorze".
- Źródło uzupełniające dla dowolnego projektu: zamiast budować własny scraper, znajdź gotowy zbiór.

---

## 🟡 GUS — Bank Danych Lokalnych (BDL)

Najbogatsze źródło statystyki publicznej (demografia, gospodarka, budżety gmin, bezrobocie — tysiące wskaźników do poziomu gmin!). **Nie udało się zweryfikować z tego środowiska (DNS nie rozwiązuje domeny) — API istnieje i jest oficjalne, sprawdź przed hackathonem.**

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.bdl.stat.gov.pl/api/v1` |
| **Auth** | **darmowy klucz** (nagłówek `X-Client-Id`) — rejestracja: [api.bdl.stat.gov.pl](https://api.bdl.stat.gov.pl/) |
| **Format** | JSON |
| **CORS** | ⚠️ do sprawdzenia (zaplanuj proxy) |
| **Dokumentacja** | [api.bdl.stat.gov.pl](https://api.bdl.stat.gov.pl/) (opis + uzyskanie klucza) |

### Logika zapytań (hierarchia)

```bash
# 1. Szukaj tematu/wskaźnika
GET /subjects?name=bezrobocie
# 2. Zmieienne w temacie
GET /subjects/{id}/variables
# 3. Jednostki terytorialne (gminy/powiaty/województwa)
GET /units?name=Warszawa
# 4. DANE dla jednostki + zmiennej (metryka roczna)
GET /data/by-unit/{unitId}/{variableId}
```

### Pomysły na projekt

- Mapy/heatmapy wskaźników (bezrobocie, demografia, budżety) — idealne do Smart City i "Comparinator" gmin.
- AI analityk: "które powiaty mają najbardziej zadłużone samorządy?" → zapytania + wykresy.

---

## ⚠️ PKW — wyniki wyborów

Brak REST API; oficjalne pliki **CSV/XML/XLSX** z wynikami wszystkich wyborów: [wybory.gov.pl](https://wybory.gov.pl/) (sekcja "dane") + zbiory na [dane.gov.pl](https://dane.gov.pl). Świetne do wizualizacji (mapy wyników po gminach), wymaga parsowania plików.

## ⚠️ eTeryt (GUS) — rejestry TERYT

Oficjalne API TERYT jest oparte o **SOAP/WSDL** ([eteryt.stat.gov.pl](https://eteryt.stat.gov.pl/)) — uciążliwe w 24h hackathonie. Do prostych zamian nazwa↔TERYT lepsze: **ULDK GUGiK** (patrz [08-geodane.md](08-geodane.md)).
