\# SmartRelay – Claude munkautasítások



\## A projektről

SmartRelay.ro egy kétfunkciós szolgáltatás:

1\. \*\*Regionális riasztóközpont\*\* – Harghita/Gyergyó időjárás, áramszünet, útviszony figyelmeztetések

2\. \*\*CMMS-lite\*\* – Kis üzemek/gazdaságok karbantartási emlékeztető rendszere



\## Tech stack

\- PHP 8.x + MySQL (Ubuntu/Nginx szerveren)

\- GitHub Actions automatizálás

\- Telegram bot értesítések

\- Cron-alapú napi adatgyűjtés



\## Kódolási szabályok

\- Minden PHP fájl UTF-8, ékezetes szöveg támogatással

\- Romániai és magyar nyelvű kimenetek egyaránt szükségesek

\- Minden változtatáshoz unit teszt szükséges

\- Érzékeny adatok (API kulcsok, DB jelszavak) CSAK .env fájlban



\## Mit tehet Claude ÖNÁLLÓAN (auto-merge)

\- Adatgyűjtő parserek javítása ha egy forrás megváltoztatta a formátumát

\- Riasztás-tartalmak generálása és frissítése

\- Tesztfájlok frissítése

\- Dokumentáció frissítése



\## Mit kell EMBERI JÓVÁHAGYÁS (PR review szükséges)

\- Adatbázis séma változtatások

\- Értesítés küldési logika módosítása

\- Bármilyen külső API integráció

\- Fizetési vagy felhasználói adat érintő változtatások



\## Napi automatizálási ciklus

Minden nap éjjel 2:00-kor (román idő szerint):

1\. Ellenőrizd az adatforrások elérhetőségét

2\. Javítsd az eltört parsereket

3\. Generáld a napi riasztás tartalmakat

4\. Futtasd a teszteket

5\. Küldj összefoglalót Telegramon

