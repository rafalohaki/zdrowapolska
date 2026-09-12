# 🌤️ Środowisko i pogoda — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ IMGW — dane meteorologiczne (SYNOP)

Aktualne pomiary ze ~stacji synoptycznych w całym kraju. **Działa wprost z przeglądarki** (CORS `*`).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://danepubliczne.imgw.pl/api/data/` |
| **Auth** | brak |
| **Format** | JSON (wartości jako stringi!) |
| **CORS** | ✅ `Access-Control-Allow-Origin: *` |

### Przykład (przetestowany na żywo)

```bash
curl 'https://danepubliczne.imgw.pl/api/data/synop'
```

```json
[ { "id_stacji": "12295", "stacja": "Białystok",
    "data_pomiaru": "2026-09-07", "godzina_pomiaru": "16",
    "temperatura": "16.2", "predkosc_wiatru": "1", "kierunek_wiatru": "210",
    "wilgotnosc_wzgledna": "74.8", "suma_opadu": "3", "cisnienie": "1023.4" },
  { "id_stacji": "12600", "stacja": "Bielsko Biała", "temperatura": "19.8", ... } ]
```

---

## ✅ IMGW — dane hydrologiczne

Stany wód na rzekach, z **progami alarmowymi i ostrzegawczymi** + współrzędnymi stacji. Ten sam host co synop (wspólne nagłówki CORS).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://danepubliczne.imgw.pl/api/data/hydro` |
| **Auth** | brak · **CORS**: ✅ `*` |

### Przykład (przetestowany na żywo)

```json
[ { "id_stacji": "151140030", "stacja": "Przewoźniki", "rzeka": "Skroda",
    "wojewodztwo": "lubuskie", "lon": "14.8217", "lat": "51.5253",
    "stan_alarmowy": "340", "stan_ostrzegawczy": "300",
    "stan_wody": "223", "stan_wody_data_pomiaru": "2026-09-07 15:50:00",
    "temperatura_wody": null } ]
```

### Pomysły na projekt

- **Alerty powodziowe** na żywo: `stan_wody` vs `stan_ostrzegawczy`/`stan_alarmowy` + mapa (stacje mają lat/lon!).
- Dashboard pogodowy z AI podsumowaniem ("dzisiaj lepiej nie biegać — smog + upał").
- Kategoria HackYeah: Smart City, Sport & Healthcare.

---

## ✅ GIOŚ — jakość powietrza (PJP API v1)

Oficjalne dane o jakości powietrza (PM10, PM2.5, SO₂, NO₂, O₃, C₆H₆, CO).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.gios.gov.pl/pjp-api/v1/rest/` |
| **Auth** | brak |
| **Format** | JSON-LD (dane w sekcji z `@context`) |
| **CORS** | ⚠️ **ograniczony** — nagłówek tylko dla `powietrze.gios.gov.pl` → **wymagane proxy** dla własnej apki |
| **Uwaga** | stare ścieżki `v0` (`/pjp-api/rest/...`) są **wyłączone (HTTP 410)** — używaj v1! |

### Przepływ zapytań

```bash
# 1. Lista stacji pomiarowych (przetestowane)
curl 'https://api.gios.gov.pl/pjp-api/v1/rest/station/findAll'

# 2. Czujniki stacji (parametry mierzone na stacji)
GET /pjp-api/v1/rest/station/sensors/{stationId}        # 🟡 ścieżka do potwierdzenia w dokumentacji

# 3. Seria pomiarów czujnika (przetestowane, id=3863)
curl 'https://api.gios.gov.pl/pjp-api/v1/rest/data/getData/3863'
# → {"@context":{...}, "Lista danych pomiarowych": [...wartości z indeksem jakości...]}
```

### Pomysły na projekt

- Smog mapa Polski z historią + alert "kiedy wietrzyć mieszkanie".
- Kombinacja: IMGW synop + GIOŚ + AI ("czy dziś bezpieczny trening na zewnątrz?") → Sport & Healthcare.

---

## ⚠️ IMGW — ostrzeżenia meteorologiczne i hydrologiczne

Ostrzeżenia IMGW publikowane jako pliki (XML/ZIP) na [danepubliczne.imgw.pl](https://danepubliczne.imgw.pl/) — sprawdź aktualną lokalizację plików i format (brak wygodnego REST). Wartość: alerty na mapę/dashboard.
