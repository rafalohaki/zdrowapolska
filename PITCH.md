# 🎤 Pitch — 5 minut (HackYeah: Sport & Healthcare + AI)

## 0:00–0:45 — Problem (historia, nie statystyka)
„Twoja mama potrzebuje kardiologa. Lekarz mówi: kolejka pół roku. **Prawda jest taka, że w innym mieście — 0 dni.** NFZ publikuje te dane, ale w formie, której nikt nie umie porównać. My to zmieniamy."

Pokaż: hero → wyszukaj kardiolog → **ranking z 0-dniową kolejką na 1. miejscu** (dane żywe, z NFZ).

## 0:45–1:30 — Jak to działa (wiarygodność)
- Oficjalne API NFZ „Terminy Leczenia" v1.4 — **434 świadczenia, 16 oddziałów, tysiące placówek**
- Wyjaśnij uczciwie: to **statystyki kolejek i prognoza PCUS**, nie rezerwacja wizyt — i dlatego nasz ranking jest uczciwy
- Architektura: Cloudflare Workers + backend Bun/Hono w Dockerze + SQLite/Redis/Meilisearch + Effect v4
- Pokaż chwilę na **Reporcie PL**: „najdłuższe kolejki w Polsce wg specjalizacji" — dane, których nikt nie agreguje

## 1:30–2:30 — Funkcje, których nie ma nikt
1. **Filtr dostępności** ♿ (rampa/winda/toaleta/dostęp dla wózków) — dane są w API NFZ, nikt ich nie eksponuje
2. **Mapa** — pinezki kolorowane czasem oczekiwania
3. **Doradca AI** — pytasz po polsku, on analizuje statystyki i dostępność (groq/compound)
4. **Wszystko linkowalne** — wyślij wynik komuś z rodziny jednym kliknięciem
5. **PWA** — instaluje się jak aplikacja (ikona na pulpicie, offline shell)

Demo: filtr ♿ Rampa → mapa → AI „która placówka najlepsza dla osoby na wózku?"

## 2:30–3:30 — Technologia (dla jury technicznego)
- **Effect v4**: rate-limiting, retry i timeout jako typowane wartości —NFZ 429-uje, a nasza apka tego nawet nie zauważa
- **SQLite + Redis + Meilisearch**: odpowiedzi z bazy w ~20 ms zamiast 46 s z NFZ; pełny tekst z synonimami („dentysta" znajduje stomatologię)
- **Uczciwy scraper**: 1 żądanie/60 ms, harmonogram co 12 h — nie spamujemy publicznego API i świadomie nie rotujemy IP
- **Odporność**: rate-limit per IP na ciężkich endpointach, snapshoty zamiast żywych zapytań, graceful degradation (Redis/Meili/AI opcjonalne)
- **Trend kolejki** — historia dzienna snapshotów: „kolejka rośnie/maleje o N%" + alerty Discord przy istotnych zmianach
- 51 testów (46 jednostkowych + 5 E2E), TypeScript strict, CI na każdym pushu

## 3:30–4:15 — Uczciwość = zaufanie
- Widoczny disclaimer: statystyki miesięczne, potwierdź telefonicznie, to nie porada medyczna
- „Gdzie się leczyć" pokazuje placówkę po placówce — my pokazujemy **obraz Polski**, więc pacjent i lekarz POZ mogą realnie planować skierowania

## 4:15–5:00 — Wizja (co dalej po hackathonie)
- Powiadomienia gdy kolejka się skróci (mamy sync w tle — to już 90% infrastruktury)
- Integracja z e-rejestracją przychodni (OPEN API MED)
- Otwarte API jako publiczne dobro: nasz /api/insights dla dziennikarzy i badaczy
- Zespół: [imiona]. Stack: React 19, Bun, Hono, Effect, Cloudflare, Docker.

## Q&A — przygotowane odpowiedzi
- **„Skąd wiecie, że dane aktualne?"** → `date-situation-as-at` na każdej karcie + miesiąc aktualizacji statystyk w szczegółach placówki.
- **„A rezerwacja online?"** → NFZ nie udostępnia slotów rezerwacyjnych publicznym API; jesteśmy warstwą **decyzyjną** przed rejestracją.
- **„Koszt infrastruktury?"** → statyczny hosting na Workers (gratis), backend na własnym sprzęcie; NFZ API bezpłatne.
