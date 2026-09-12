# ⚖️ Prawo i państwo — publiczne API

> Statusy: ✅ zweryfikowane na żywo · 🟡 częściowo zweryfikowane · ⚠️ do weryfikacji przed użyciem
> Data weryfikacji: **2026-09-07**

---

## ✅ Kancelaria Sejmu — api.sejm.gov.pl (ELI + legislacja)

Prawo w strukturze: akty prawne od 1918 r., pełny przebieg procesów legislacyjnych, interpelacje, głosowania. **Działa wprost z przeglądarki** (CORS odbija dowolny Origin).

| Parametr | Wartość |
|---|---|
| **Baza** | `https://api.sejm.gov.pl` |
| **Auth** | brak |
| **Format** | JSON, pliki PDF/HTML/DOCX do pobrania |
| **CORS** | ✅ odbija dowolny `Origin` |
| **Dokumentacja** | Swagger UI: [/swagger](https://api.sejm.gov.pl/swagger) + strona główna API |

### Usługi

| Ścieżka | Zawartość |
|---|---|
| `/eli/acts` | **akty prawne** (Dziennik Ustaw + Monitor Polski, od 1918) |
| `/sejm/term{N}/processes` | **procesy legislacyjne** (druki, etapy, daty) |
| `/sejm/term{N}/sittings` | posiedzenia Sejmu |
| `/sejm/term{N}/interpellations` | interpelacje i odpowiedzi |
| `/sejm/term{N}/voting` | głosowania (jak głosowali posłowie) |

### Przykłady (przetestowane na żywo)

```bash
# Rejestr publikatorów + liczba aktów
curl 'https://api.sejm.gov.pl/eli/acts?limit=1'
# → [ { "actsCount": 97769, "code": "DU", "name": "Dziennik Ustaw",
#      "years": [1918, 1919, ... 2026] } ]

# Procesy legislacyjne 10. kadencji
curl 'https://api.sejm.gov.pl/sejm/term10/processes?page=1&limit=1'
# → [ { "ELI": "MP/2023/1261", "displayAddress": "M.P. 2023 poz. 1261",
#      "documentType": "projekt uchwały", "documentTypeEnum": "DRAFT_RESOLUTION",
#      "links": [ { "href": "https://isap.sejm.gov.pl/..." } ] } ]
```

⚠️ Ścieżki pobierania treści (np. `text.pdf` wg wzorca ELI `{wydawca}/{rok}/{pozycja}`) i parametry usług `voting`/`sittings` — doprecyzuj w Swaggerze przed implementacją.

### Pomysły na projekt

- **Śledzik legislacyjny**: obserwuj temat ("AI", "podatki") → AI streszcza etapy projektu i przewiduje co dalej; alert mailem.
- **Kto głosował jak**: wizualizacje głosowań po klubach + wyszukiwarka.
- Chatbot prawnik-lite: pytanie po polsku → ELI → AI cytuje odpowiednie akty (z zastrzeżeniem "to nie porada prawna").
- Kategoria HackYeah: Artificial Intelligence, Smart City (civic tech).
