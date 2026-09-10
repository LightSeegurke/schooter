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
  - WASD/Pfeile bewegen, Maus zielen, Klick/Leertaste schießen
  - 3 Waffen: Pistole, Gewehr, Schrotflinte (per Powerup)
  - Powerups (Heilung + Waffen), Hindernisse, Respawn, Scoreboard, Kill-Feed
  - In-Game-Chat pro Raum

## Schnellstart

```bash
npm install
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

Zum Testen mehrerer Spieler einfach mehrere Browser-Tabs / -Fenster (oder Geräte im selben Netzwerk) öffnen und je einen Account registrieren.

## Steuerung

| Taste            | Aktion            |
|------------------|-------------------|
| W A S D / Pfeile | Bewegen           |
| Maus             | Zielen            |
| Linksklick / Leertaste | Schießen    |
| Enter            | Chat fokussieren  |

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
  db.js      JSON-Persistenz (Nutzer, IDs)
  game.js    Räume, Physik, Waffen, Game-Loop
public/
  index.html Screens: Auth, Lobby, Game, Admin
  js/app.js  Client-Logik & Socket-Verdrahtung
  js/game.js Canvas-Rendering & Eingabe
  css/style.css
```
