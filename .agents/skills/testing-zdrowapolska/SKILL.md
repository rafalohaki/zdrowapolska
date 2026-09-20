---
name: testing-zdrowapolska
description: Jak przetestować UI ZdrowaPolska (hackyeah) — dev server na minifast + tunel SSH do lokalnego Chrome.
---

# Testowanie ZdrowaPolska (rafalohaki/zdrowapolska, repo na minifast `/root/hackyeah`)

Aplikacja NIE buduje się lokalnie na Macu (brak node/bun) — frontend i backend uruchamia się na minifast, a podgląd idzie przez tunel SSH do lokalnego Chrome.

## Setup

1. **Dev servery na minifast** (one-shot, tło):
   ```
   ssh minifast 'export PATH=/root/.bun/bin:$PATH && cd /root/hackyeah && (bun run dev > /tmp/vite.log 2>&1 &) && sleep 3 && tail -5 /tmp/vite.log'
   ```
   UWAGA: `bun run dev` (vite) realnie bindowało **:5173**, nie 5179.

2. **Backend**: zaszłość `zdrowapolska-backend` (docker) trzyma **:2363** i lock WAL na produkcyjnej bazie — `bun run dev:backend` crashuje `SQLITE_BUSY_RECOVERY`. Ominąć własnym backendem na innym porcie i kopii bazy:
   ```
   ssh minifast 'export PATH=/root/.bun/bin:$PATH && cd /root/hackyeah && cp *.sqlite* /tmp/zp-test/ 2>/dev/null; mkdir -p /tmp/zp-test && cp <db>.sqlite /tmp/zp-test/ && (DB_PATH=/tmp/zp-test/<db>.sqlite PORT=2364 bun run server/index.ts > /tmp/api.log 2>&1 &)'
   ```

3. **Tunel SSH** na tej maszynie: `ssh -N -L 5179:localhost:5173 -L 2363:localhost:2364 minifast &` → Chrome: `http://localhost:5179` (Vite dev default `VITE_API_BASE=http://localhost:2363` trafi w tunelowany backend testowy).

## Pułapki środowiskowe

- **NFZ/GSL często nieosiągalne z minifast** — `api.nfz.gov.pl` i `gsl.nfz.gov.pl/GSLAdapt` potrafią zwracać 000/timeout. Placówki NFZ wtedy pokazują graceful ErrorState (to poprawne zachowanie, nie bug). Terminy działają z cache `queue_snapshots`.
- **Deterministyczne testowanie ścieżki stale/degradacji**: apka ma circuit breaker `nfzDown()` (45 s po błędzie NFZ) + serwowanie snapshotów. Żeby to przetestować na żywo bez czekania na prawdziwą awarię, odpal backend z `NFZ_BASE=https://127.0.0.1:9/dead` — pierwsze zapytanie potrzebuje ~30 s żeby „zapalić" obwód, kolejne serwują stale natychmiast. UWAGA: realny `apinfz.nfz.gov.pl` bywa osiągalny nawet gdy `api.nfz.gov.pl`/`gsl.nfz.gov.pl` leżą.
- Po teście z `NFZ_BASE=…dead` zrestartuj backend bez tej zmiennej, żeby przywrócić live NFZ.
- **Stare snapshoty**: `SNAPSHOT_TTL_H=24` — jeśli `queue_snapshots.fetched_at` starsze, kod leci live do NFZ i pada. Na kopii bazy testowej można podbić `fetched_at` (UPDATE … SET fetched_at = strftime('%s','now')*1000), nigdy na produkcyjnej.
- GIOŚ (jakość powietrza) zwykle działa live nawet gdy NFZ leży.
- AI (`/api/ai`) bez klucza zwraca lokalny fallback — sprawdzać, że nie crashuje, nie że treść jest "AI".

## Co testować (golden path)

- ~390px: hamburger ma wszystkie 5 trybów; karty/siatki bez scrolla w bok; Raport PL grid 3-kol.
- Terminy: wyszukaj frazę (np. „kardiolog") → mapa województw + ranking + wykres; przełącznik Cała Polska↔woj. refetchuje; klik w wiersz wykresu wybiera województwo.
- Comboboxy: `↑↓` podświetla, `Enter` wybiera; locality `Enter` przy zamkniętej liście submituje.
- DetailModal: focus trap (Tab nie ucieka), Esc zamyka, focus wraca do triggera.
- Jakość powietrza: miejscowość + Enter bez wyboru z listy; nieistniejąca → empty state.
- Placówki NFZ: jeśli NFZ osiągalne — lista + mapa OSM, „Pokaż więcej" dokleja, zmiana frazy resetuje.
- Dark mode: ErrorState, chips, zaznaczony wiersz wykresu.

## Porządki

Zamknąć tunel (`kill %<job>` / `pkill -f 'ssh -N -L 5179'`), zabić testowy backend na minifast (`pkill -f 'PORT=2364'` / `lsof` :2364), usunąć `/tmp/zp-test`. Worktree `/root/hackyeah` przywrócić do czystego `main`.
