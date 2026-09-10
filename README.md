# 🔫 Schooter

Ein browserbasierter **Multiplayer-Top-Down-Shooter** mit Accounts, Räumen, Admin-System und Echtzeit-Gameplay über WebSockets.

## Features

- **Login & Registrierung** mit JWT-Auth und gehashten Passwörtern (bcrypt)
- **Erster Account = Admin** – der allererste registrierte Nutzer wird automatisch Server-Admin
- **Adminpanel** – Nutzer sperren/entsperren, Admin-Rechte vergeben, Räume schließen, Server-Statistiken
- **Räume**
  - **Öffentliche Räume** – für alle gelistet und beitretbar
  - **Private Räume** – einladungspflichtig, nicht gelistet, Beitritt per Einladung oder 6-stelligem Code
  - **Eigentümer & Moderatoren** verwalten Räume (kicken, bannen, einladen, umbenennen, öffentlich/privat schalten)
  - Nur der Eigentümer (oder ein Admin) kann Moderatoren ernennen und den Raum schließen
- **Echtzeit-Shooter** – server-autoritative Bewegung, Schüsse und Schadensberechnung bei 30 Ticks/s
- **Spielmodi**: Jeder-gegen-jeden (FFA) und Team-Deathmatch (Rot vs. Blau, kein Friendly Fire)
- **Match-System**: Kill-Limit + Zeitlimit, Siegbildschirm mit Rangliste, automatischer Neustart der Runde
- **3 Karten**: Arena, Bunker, Säulen – bei der Raumerstellung wählbar (oder zufällig)
- **7 Waffen** mit Munition, Magazin und Nachladen: Messer (Nahkampf), Pistole, MP, Gewehr,
  Schrotflinte, Scharfschützengewehr und Raketenwerfer (mit Flächenschaden)
- **Granaten** (werfbar, Flächenschaden) und **Dash/Ausweichen**
- **Powerups**: Heilung, Schild, Schadensboost, Tempoboost, Munition
- **KI-Bots** – Eigentümer/Moderatoren können Bots hinzufügen/entfernen (mit Sichtlinien-KI,
  die Hindernisse umläuft); ideal zum Testen oder Auffüllen von Räumen
- **Fortschritt**: persistente Statistiken, XP & Level, **globale Rangliste**
- **Hindernisse, Respawn, Scoreboard, Kill-Feed, Killstreak-Ansagen**
- **Minimap**, Partikel-Effekte, Screen-Shake und synthetisierte Soundeffekte (Web Audio, ohne Asset-Dateien)
- **In-Game-Chat** pro Raum

## Schnellstart

```bash
npm install
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

Zum Testen mehrerer Spieler einfach mehrere Browser-Tabs / -Fenster (oder Geräte im selben Netzwerk) öffnen und je einen Account registrieren.

## Steuerung

| Taste                  | Aktion                         |
|------------------------|--------------------------------|
| W A S D / Pfeile       | Bewegen                        |
| Maus                   | Zielen                         |
| Linksklick / Leertaste | Schießen                       |
| 1 – 7                  | Waffe direkt wählen            |
| Q / Mausrad            | Waffe durchwechseln            |
| R                      | Nachladen                      |
| G                      | Granate werfen                 |
| Shift                  | Dash / Ausweichen              |
| Enter                  | Chat                           |

## Konfiguration

| Env-Variable | Standard | Beschreibung |
|--------------|----------|--------------|
| `PORT`       | `3000`   | HTTP-Port    |
| `JWT_SECRET` | Dev-Wert | Signierschlüssel für Tokens – **in Produktion setzen!** |

## Technik

- **Backend:** Node.js, Express, Socket.IO, JWT, bcryptjs
- **Persistenz:** einfache JSON-Datei (`data/db.json`) – keine nativen Abhängigkeiten
- **Frontend:** Vanilla JS + HTML5 Canvas

### Projektstruktur

```
server/
  index.js   REST-API + Socket.IO-Handler
  auth.js    Registrierung, Login, JWT, Middleware
  db.js      JSON-Persistenz (Nutzer, Stats, XP/Level)
  game.js    Räume, Physik, Waffen, Bots, Modi, Match-System, Game-Loop
  maps.js    Kartendefinitionen (Hindernisse, Spawns, Powerups)
public/
  index.html Screens: Auth, Lobby, Game, Admin
  js/app.js  Client-Logik & Socket-Verdrahtung
  js/game.js Canvas-Rendering & Eingabe
  css/style.css
```
