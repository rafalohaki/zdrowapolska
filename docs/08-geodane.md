# 🗺️ Geodane (GUGiK i geoportal) — usługi publiczne

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## 🟡 ULDK GUGiK — Uniwersalna Lista Działek Katastralnych

Geokodowanie / odwrotne geokodowanie powiązane z TERYT i działkami katastralnymi (REST, bez klucza).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://uldk.gugik.gov.pl/` |
| **Auth** | brak |
| **Status** | endpoint żywy (odpowiada komunikatami PL ✅); dokładna składnia parametrów wymaga jeszcze dopracowania — pełny opis: [uldk.gugik.gov.pl/opis.html](https://uldk.gugik.gov.pl/opis.html) |

### Co potrafi (wg opisu usługi)

`GetAddress` (adres dla współrzędnych), `GetParcelByIdOrNr` (działka po numerze), `SnapToPoint`, `GetAggregateArea`, parametr `srid` (EPSG:2180 PUWG1992 / 4326 WGS84).

⚠️ Moje próby `?request=GetAddress&xy=lon,lat&srid=4326` zostały odrzucone ("niepoprawny parametr") — zajrzyj do `opis.html` i dostosuj format `xy` (kolejność/osobne parametry) przed implementacją.

### Zastosowanie w projekcie

- **Kluczowe dla NFZ**: w rekordach kolejek `latitude`/`longitude` często `null` — adresy (miejscowość + ulica) geokodujesz na współrzędne dla mapy.
- Zamiast płatnego Google Geocoding — darmowe i legalne (dane GUGiK).

---

## ⚠️ Pozostałe usługi GUGiK (stabilne, sprawdź parametry w docs)

| Usługa | Adres | Do czego |
|---|---|---|
| **EMUiA** | [emuia.gugik.gov.pl](https://emuia.gugik.gov.pl/) | Ewidencja miejscowości, ulic i adresów — najlepsze źródło adresów PL (usługi WMS/WFS/REST) |
| **Geoportal** | [geoportal.gov.pl](https://www.geoportal.gov.pl/) | mapy, ortofotomapa, usługi WMS/WFS/WMTS (setki warstw: działki, budynki, lasy...) |
| **NMT/NMPT** | przez Geoportal | Numeryczny Model Terenu — pobieranie arkuszy; analizy terenu, panoramy, cienie |
| **PRNG** | dane na Geoportalu | Państwowy Rejestr Nazw Geograficznych — nazwy miejscowości/fizjografii |
| **Zabytki (NID)** | [zabytek.gov.pl](https://zabytek.gov.pl/) + dane.gov.pl | rejestry zabytków, geoportale tematyczne |

### Pomysły na projekt

- "Smart adres": wpisz adres → TERYT + działka + ortofoto + otoczenie (połączenie EMUiA + ULDK + WMS).
- Analiza działki pod inwestycję z AI (zalewy? las? zabytek? skarp? — NMT + warstwy WMS).
- Kategoria HackYeah: Smart City, Defense (geoanalizy).
