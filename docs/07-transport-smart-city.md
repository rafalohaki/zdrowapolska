# 🚌 Transport i Smart City — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ CEPiK 2.0 — pojazdy, prawa jazdy, uprawnienia

Krajowy rejestr pojazdów: dane ogólne pojazdów (marka, model, rok, typ paliwa), statystyki, uprawnienia.

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.cepik.gov.pl/` |
| **Auth** | brak |
| **Format** | JSON-LD |
| **CORS** | ❌ **BRAK** → wymagane proxy |
| **Uwaga TLS** | serwer używa słabych parametrów Diffie-Hellman — curl/Node odrzucają połączenie domyślnie; obejście: `--ciphers 'DEFAULT@SECLEVEL=1'` (w proxy: obniżenie `SECLEVEL` lub inna biblioteka TLS) |
| **Dokumentacja** | lista metod: `GET /` (zwraca JSON z przykładami!) · `GET /doc` |

### Metody (zweryfikowana lista z API)

```bash
curl --ciphers 'DEFAULT@SECLEVEL=1' 'https://api.cepik.gov.pl/'
# → /pojazdy?wojewodztwo=XX&data-od=YYYYMMDD&data-do=YYYYMMDD   (per kod województwa, zakres rejestracji)
# → /statystyki
# → /prawa-jazdy
# → /uprawnienia
# → /slowniki   /pliki   /doc   /version
```

### Pułapki

- Zapytania o pojazdy **wymagają** województwa + zakresu dat rejestracji (kody województw wg CEPiK, np. `06`).
- TLS + brak CORS → koniecznie przez własne proxy.
- Dane osobowe: API zwraca dane ogólne pojazdów, nie dane właścicieli.

### Pomysły na projekt

- Statystyki floty aut w Polsce: elektryki vs spalinowe per województwo, trendy rejestracji EV (dane do map).
- "Historia pojazdu lite" — demokratyzacja danych o pojeździe przed zakupem (dane ogólne).

---

## 🟡 Warszawa — api.um.warszawa.pl (ZTM, live pozycje)

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.um.warszawa.pl/` |
| **Auth** | **darmowy klucz** (panel API na stronie miasta) |
| **Certy** | m.in. `busestrams_get` — **pozycje busów/tramwajów na żywo**; rozkłady jazdy ZTM |
| **Status** | portal odpowiada (HTML); konkretne akcje do potwierdzenia z kluczem |

### Pomysły

- Live mapa komunikacji + AI "kiedy realnie dojadę?" (połączenie z rozkładem).

---

## ⚠️ Otwarte dane miast (klucze darmowe / pliki)

| Miasto | Adres | Co jest |
|---|---|---|
| Gdańsk | [opendata.gdansk.pl](https://opendata.gdansk.pl/) | katalog zbiorów, API CKAN |
| Wrocław | [wroclaw.pl/open-data](https://www.wroclaw.pl/open-data/) | zbiory, GTFS, środowisko |
| Kraków | [dane-publiczne.e-malopolska.pl](https://dane-publiczne.e-malopolska.pl/) | zbiory Małopolski + GTFS-RT |
| Warszawa | [api.um.warszawa.pl](https://api.um.warszawa.pl/) | ZTM, klucz darmowy |

## ⚠️ Rozkłady jazdy / GTFS

Zbiory GTFS/GTFS-RT przewoźników (PKP Intercity, Koleje Mazowieckie, ZTM-y) — szukaj przez [dane.gov.pl](https://dane.gov.pl) (fraza "GTFS"). GTFS-RT daje **pozycje pojazdów na żywo** (protobuf!). Idealne pod: tracker pociągów, "gdzie jest mój pociąg", analizy punktualności.
