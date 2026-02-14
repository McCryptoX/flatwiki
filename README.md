<<<<<<< HEAD
# FlatWiki

FlatWiki ist ein modernes, durchsuchbares Flat-File-Wiki mit Login, Rollen, Admin-Benutzerverwaltung und Markdown-Seiten.

## Open Source

- Lizenz: [MIT](LICENSE)
- Drittanbieter-Hinweise: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
- Sicherheitsmeldungen: [SECURITY.md](SECURITY.md)
- Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md)

## Features

- Flat-File statt SQL-Datenbank
- Wiki-Seiten als Markdown (`data/wiki/*.md`)
- Login/Logout
- Admin-Bereich für Benutzerverwaltung
  - Benutzer anlegen, bearbeiten, deaktivieren, löschen
  - Rollen (`admin`, `user`)
  - Passwort-Reset
- Benutzerkonto-Funktionen
  - eigenes Passwort ändern
  - eigene Daten exportieren
- Volltextsuche
- Inhaltsverzeichnis (`/toc`)
- Sicherheitsgrundlagen: `scrypt`, CSRF, Rate-Limit, Security-Header, Audit-Log

## Screenshot

Lege deinen Screenshot als `screenshot.png` im Projekt-Root ab.

![FlatWiki Screenshot](./screenshot.png)

## Starten

### Option A: Node.js + npm

Voraussetzungen: Node.js 20+, npm

```bash
cp config.env.example config.env
npm install
npm run dev
```

Produktion:

```bash
npm run build
npm start
```

### Option B: Docker (ohne npm auf macOS)

Voraussetzungen: Docker Desktop

```bash
cp config.env.example config.env
docker compose up -d --build
```

Logs:

```bash
docker compose logs -f
```

Stoppen:

```bash
docker compose down
```

Aufruf:

- [http://127.0.0.1:3000](http://127.0.0.1:3000)

## Erstes Admin-Konto

Beim ersten Start wird ein Admin erstellt, wenn `data/users.json` leer ist.

- Benutzername: `admin` (oder `BOOTSTRAP_ADMIN_USERNAME`)
- Passwort:
  - aus `BOOTSTRAP_ADMIN_PASSWORD`, falls gesetzt
  - sonst temporär im Server-Log

Danach Passwort direkt ändern.

## Konfiguration

Datei: `config.env`

Pflicht in Produktion:

- `COOKIE_SECRET` (langes zufälliges Secret)

Optional:

- `PASSWORD_PEPPER`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `WIKI_TITLE`

## GitHub Upload Checkliste

Vor öffentlichem Upload prüfen:

1. `config.env` nicht committen (ist ignoriert).
2. Laufzeitdaten nicht committen (`data/users.json`, `data/sessions.json`, `data/audit.log`).
3. Keine Secrets in Commits/History.
4. README + Lizenz + Security-Datei vorhanden.

## GitHub About Vorschlag

Description:

`DSGVO-bewusstes Flat-File-Wiki mit Login, Rollen, Admin-Userverwaltung und Markdown-Speicherung.`

Topics:

`wiki`, `flat-file`, `markdown`, `fastify`, `typescript`, `self-hosted`, `docker`, `gdpr`

## Repository-Struktur

```txt
.
├─ .github/
│  └─ workflows/
│     └─ ci.yml
├─ .gitattributes
├─ .dockerignore
├─ .editorconfig
├─ Dockerfile
├─ docker-compose.yml
├─ config.env.example
├─ data/
│  └─ wiki/
├─ public/
├─ src/
├─ LICENSE
├─ README.md
├─ SECURITY.md
└─ CONTRIBUTING.md
```
=======
# FlatWiki
>>>>>>> d2b11d88bf6530cec5187134f3298b9f0e0f3562
