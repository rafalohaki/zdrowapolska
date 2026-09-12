# 📦 Zapisane specyfikacje API (Swagger / OpenAPI)

Maszyny czytelne specyfikacje pobrane z oficjalnych źródeł — użyj ich do generowania klientów, eksploracji endpointów albo jako kontekst dla LLM-a ("co dokładnie potrafi to API?").

| Plik | API | Wersja | Rozmiar | Skąd | Pobrano |
|---|---|---|---|---|---|
| `nfz-itl-v1.4.json` | NFZ — Terminy Leczenia (ITL) | 1.4 | 73 KB | `apinfz.nfz.gov.pl/app-itl-api-pcus/swagger/v1.4/swagger.json` | 2026-09-07 |
| `dane-gov-pl.json` | dane.gov.pl — Portal Otwartych Danych | 1.4 | 318 KB | `api.dane.gov.pl/spec/1.4` | 2026-09-07 |
| `pse-raporty.json` | PSE — Dane raportowe (180 ścieżek) | OpenAPI 3.0.1 | 665 KB | `api.raporty.pse.pl/api/openapi` | 2026-09-07 |

## Jak odświeżyć

```bash
curl -sSL 'https://apinfz.nfz.gov.pl/app-itl-api-pcus/swagger/v1.4/swagger.json' -o nfz-itl-v1.4.json
curl -sSL 'https://api.dane.gov.pl/spec/1.4' -o dane-gov-pl.json
curl -sSL 'https://api.raporty.pse.pl/api/openapi' -o pse-raporty.json
```

## Szybki podgląd endpointów z pliku

```bash
python3 -c "
import json
d = json.load(open('pse-raporty.json'))
for p in sorted(d['paths']): print(p)
"
```

## Gdzie są dokumentacje pozostałych API

| API | Dokumentacja |
|---|---|
| NBP | https://api.nbp.pl/ (opisowa + przykłady) |
| GIOŚ PJP v1 | https://api.gios.gov.pl/ (opis zasobów) |
| IMGW | https://danepubliczne.imgw.pl/ (opis zasobów) |
| Sejm | https://api.sejm.gov.pl/swagger (Swagger UI) |
| MF Biała lista | https://wl-api.mf.gov.pl/ (opis + przykłady) |
| CEPiK | `GET https://api.cepik.gov.pl/` — lista metod z przykładami w JSON |
| GUS BDL | https://api.bdl.stat.gov.pl/ (opis + klucz) |
