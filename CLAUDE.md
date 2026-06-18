# SmartRelay – Claude munkautasítások

## A projektről

SmartRelay.ro egy kétfunkciós szolgáltatás:

1. **Regionális riasztóközpont** – Harghita/Gyergyó időjárás, áramszünet, útviszony figyelmeztetések
2. **CMMS-lite** – Kis üzemek/gazdaságok karbantartási emlékeztető rendszere

A rendszer szándékosan interfész-alapú és moduláris. Új adat forrás = új Collector. Új értesítési csatorna = új Notifier. A core szolgáltatások nem változnak amikor bővítünk.

---

## Tech stack

- PHP 8.1+ (PSR-4 autoloading, strict types mindenütt)
- PHPUnit 11 (kötelező tesztek minden változtatáshoz)
- MySQL (jövőbeli adat tárolás)
- GitHub Actions (napi automatizálás)
- Telegram Bot API (értesítések)
- Ubuntu/Nginx szerver (smartrelay.ro)

---

## Architektúra szabályok

### 1. Interfész-első tervezés
- Minden új modul implementál egy létező interfészt (CollectorInterface, NotifierInterface, ServiceInterface)
- Ha az interfész nem elég, nyiss PR-t az interfész bővítésére — ne kerüld meg

### 2. Flexibilitás megőrzése
- Kerüld a hardcoded értékeket — minden Config::get()-en keresztül
- Kerüld a szoros csatolást (tight coupling) — dependency injection-t használj
- Új funkciónál gondolj arra: "Mi lenne ha 10 ilyen kellene?" — úgy tervezd

### 3. Visszafelé kompatibilitás
- Meglévő publikus metódus szignatúrát NEM változtatsz breaking módon
- Ha változtatás szükséges: deprecated komment + új metódus, majd PR

---

## Kódminőség szabályok

- `declare(strict_types=1)` minden PHP fájlban kötelező
- Típusok (return type, parameter type) mindenhol kötelezők
- Docblock csak ha a típus önmagában nem elég magyarázat
- Ékezetes szöveg: csak stringekben, nem változónevekben
- Logolás: minden service action-t logolni kell (Logger osztályon keresztül)

---

## Tesztelési szabályok (KÖTELEZŐ)

### Amit Claude önállóan KÖTELES megcsinálni minden változtatásnál:
1. Lefuttatni a meglévő tesztcsomagot: `composer test`
2. Ha új kód kerül be: új unit teszt is kell hozzá
3. A teszt fájl neve: `{ClassName}Test.php` a megfelelő `tests/Unit/` alkönyvtárban
4. Minimum lefedettség: minden publikus metódus tesztelve legyen
5. Mock-okat használj külső függőségekre (API hívások, fájlrendszer, DB)

### Mit NEM szabad deployolni:
- Eltört (failing) tesztekkel rendelkező kód
- Teszteletlen publikus metódusok
- Hardcoded API kulcsok vagy jelszavak
- TODO kommentek éles kódban

---

## Peer review szabályok

### Claude saját kódján peer review-t végez mielőtt commit-ol:

**Ellenőrzőlista minden változtatás előtt:**
- [ ] Visszafelé kompatibilis-e?
- [ ] Van-e teszt hozzá?
- [ ] Minden teszt zöld?
- [ ] Config-ból olvas-e kulcsokat (nem hardcoded)?
- [ ] Logol-e megfelelő szinten?
- [ ] Az interfész kontraktust teljesíti-e?
- [ ] Ha eltörte bármi a meglévő funkcionalitást?

Ha bármelyik "nem" → javítás előbb, commit utána.

---

## Amit Claude önállóan tehet (auto-merge engedélyezett)

- Parser javítás ha egy külső forrás megváltoztatta a formátumát
- Riasztás szöveg generálás / frissítés
- Unit teszt bővítés, javítás
- Config kulcsok dokumentálása
- Log szint finomhangolás
- .env.example frissítés (valódi értékek nélkül!)

---

## Ami KÖTELEZŐ PR + emberi jóváhagyás

- Bármely interfész módosítás
- Adatbázis séma változtatás
- Értesítés küldési logika változtatás
- Új külső API integráció
- Deployment szkript módosítás
- Bármely biztonsági érintettségű változtatás

---

## Napi automatizálási ciklus

Minden nap 03:00 román idő szerint:

1. `composer test` — ha eltört valami, először azt javítsd
2. Ellenőrizd az adatforrások elérhetőségét
3. Javítsd az eltört parsereket (unit teszttel együtt)
4. Generáld/frissítsd a riasztás tartalmakat
5. Futtasd újra a teszteket — csak ha zöld, commitolj
6. Küldj összefoglalót mit csináltál (GitHub Actions log + Telegram ha be van állítva)

---

## Projekt mappaszerkezet

```
src/
  Core/           - Config, Logger, ServiceInterface (alap, ritkán változik)
  Collectors/     - Adatgyűjtők (CollectorInterface implementációk)
  Processors/     - Adatfeldolgozók (jövőbeli)
  Notifiers/      - Értesítési csatornák (TelegramNotifier, stb.)
  Services/       - Orchestrátorok (AlertService, MaintenanceService)
tests/
  Unit/           - Unit tesztek (mock-okkal, nincs valódi API hívás)
  Integration/    - Integrációs tesztek (valódi külső hívások, CI-ban skip-pelve)
config/
  equipment.json  - CMMS berendezések listája
```
