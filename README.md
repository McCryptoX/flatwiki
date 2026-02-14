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

### Option B: Docker

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

## Wichtige Hinweise

- Bei Docker muss in `config.env` `HOST=0.0.0.0` gesetzt sein.
- `BOOTSTRAP_ADMIN_PASSWORD` wird nur beim Erststart genutzt (wenn `data/users.json` leer ist).
- `PASSWORD_PEPPER` nach dem ersten produktiven Start nicht mehr ändern, sonst funktionieren bestehende Passwörter nicht mehr.
- `config.env` nie ins Repository committen.

## Erstes Admin-Konto

Beim ersten Start wird ein Admin erstellt, wenn `data/users.json` leer ist.

- Benutzername: `admin` (oder `BOOTSTRAP_ADMIN_USERNAME`)
- Passwort:
  - aus `BOOTSTRAP_ADMIN_PASSWORD`, falls gesetzt
  - sonst temporär im Server-Log

Danach Passwort direkt ändern.

### Admin-Passwort per CLI zurücksetzen (Docker)

Wenn das Login nicht mehr funktioniert, kannst du das Admin-Passwort direkt neu setzen:

```bash
cd /pfad/zu/FlatWiki
NEW_ADMIN_PASSWORD='DeinSicheresPasswort123!'
docker compose exec -T -e NEW_ADMIN_PASSWORD="$NEW_ADMIN_PASSWORD" flatwiki node - <<'NODE'
const fs = require('fs');
const crypto = require('crypto');

const usersPath = '/app/data/users.json';
const username = 'admin';
const newPassword = process.env.NEW_ADMIN_PASSWORD;
const pepper = process.env.PASSWORD_PEPPER || '';
const N = 1 << 14, R = 8, P = 1, KEYLEN = 64, MAX_MEM = 64 * 1024 * 1024;

if (!newPassword) throw new Error('NEW_ADMIN_PASSWORD ist leer');

const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
const user = users.find((u) => (u.username || '').toLowerCase() === username);
if (!user) throw new Error('Admin-User nicht gefunden');

const salt = crypto.randomBytes(16);
crypto.scrypt(`${newPassword}${pepper}`, salt, KEYLEN, { cost: N, blockSize: R, parallelization: P, maxmem: MAX_MEM }, (err, dk) => {
  if (err) throw err;
  user.passwordHash = `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${Buffer.from(dk).toString('base64')}`;
  user.updatedAt = new Date().toISOString();
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2) + '\n');
  console.log('Admin-Passwort neu gesetzt.');
});
NODE
```

## Konfiguration

Datei: `config.env`

Pflicht in Produktion:

- `COOKIE_SECRET` (langes zufälliges Secret)

Optional:

- `PASSWORD_PEPPER`
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `WIKI_TITLE`

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
