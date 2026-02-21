# FlatWiki

FlatWiki ist ein modernes, durchsuchbares Flat-File-Wiki mit Login, Rollen, Admin-Benutzerverwaltung und Markdown-Seiten.
Aktueller Release-Stand: `v0.8.1` ([Release Notes](docs/releases/v0.8.1.md))

## Open Source

- Lizenz: [MIT](LICENSE)
- Drittanbieter-Hinweise: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
- Sicherheitsmeldungen: [SECURITY.md](SECURITY.md)
- Mitwirken: [CONTRIBUTING.md](CONTRIBUTING.md)

## Features

- Flat-File-Wiki (Markdown bleibt Quelle der Wahrheit)
- Wiki-Seiten als Markdown (`data/wiki/*.md`)
- Login/Logout
- Optionaler öffentlicher Lesemodus (Admin-Schalter unter `/admin/ui`)
  - Gäste können lesen + suchen ohne Login
  - Schreiben/Bearbeiten/Löschen bleibt nur für angemeldete Nutzer
- Admin-Bereich für Benutzerverwaltung
  - Benutzer anlegen, bearbeiten, deaktivieren, löschen
  - Rollen (`admin`, `user`)
  - Passwort-Reset
- Admin TLS/SSL-Statusseite (`/admin/ssl`)
  - erkennt Forwarded-/Proxy-Header read-only
  - zeigt HTTPS-Status + To-do-Checkliste
- Benutzerkonto-Funktionen
  - eigenes Passwort ändern
  - eigene Daten exportieren (inkl. eigener Artikelübersicht + Markdown-Speicherdump)
  - Übersicht über selbst erstellte Artikel im Konto-Bereich
- Kategorien (eine Kategorie pro Artikel)
- Zugriff pro Artikel (`alle` oder `nur ausgewählte Benutzer/Gruppen`)
- Sensibel-Modus pro Artikel
  - erzwingt eingeschränkten Zugriff + Verschlüsselung
  - Inhalt wird nicht in der Volltextsuche indiziert (nur Metadaten)
  - Bild-Upload ist für sensible Artikel deaktiviert
- Gruppen/Rechte-Modell (Admin-Gruppenverwaltung unter `/admin/groups`)
- Optionale AES-256-Verschlüsselung pro Artikel
- Integritätsschutz für Artikeldateien per HMAC-SHA256 (`CONTENT_INTEGRITY_KEY`)
- Verschlüsselte Artikel werden ohne Klartext-Inhalt indiziert (nur Metadaten wie Titel/Tags)
- Versionshistorie pro Artikel mit Restore (Admin)
  - Diff-Ansicht zwischen Versionen und aktuellem Stand
- Automatische Historienpflege pro Artikel
  - Retention-Limit (ältere Versionen werden gelöscht)
  - Gzip-Kompression älterer Versionen (`.json.gz`)
- Volltextsuche
- Live-Vorschläge im Suchfeld während der Eingabe
- Suchoperatoren für präzisere Suchabfragen (z. B. Feld-/Tag-Filter)
- Interne Wiki-Links per `[[Seite]]` oder `[[Seite|Label]]`
- Backlinks pro Artikel ("Verlinkt von")
- Defekte interne Links prüfen im Admin-Bereich (`/admin/links`)
- Pagination für Übersicht, Inhaltsverzeichnis und Suche
- Inhaltsverzeichnis (`/toc`)
- Bild-Upload im Editor (1-x Dateien, automatische eindeutige Dateinamen)
- Kategoriebezogene Upload-Pfade (`/uploads/<kategorie-ordner>/...`)
- Visueller Markdown-Editor (Toolbar + Live-Vorschau)
- Bearbeitungskonflikt-Erkennung beim Speichern (Schutz vor Überschreiben fremder Änderungen)
- Schnell-Assistent für neue Seiten (3 Schritte: Inhaltstyp, Kategorie, Schutz)
- Vorlagen für Alltag/Firma: Idee, Dokumentation, Reisebericht, Finanznotiz
- Admin-Vorlagenverwaltung unter `/admin/templates` (aktivieren, sortieren, bearbeiten, eigene Vorlagen anlegen)
- Wikitext-Importer im Admin-Bereich (`/admin/import/wikitext`)
  - konvertiert MediaWiki/Wikitext nach Markdown
  - unterstützt u. a. Überschriften, Listen, Tabellen, Datei/Bild-Links und `<syntaxhighlight>`
- Automatische Artikel-Navigation (links) aus Markdown-Überschriften
- Admin-Bildverwaltung mit Referenzprüfung (`/admin/media`)
  - zeigt pro Bild, ob es eingebunden ist und in welchen Artikeln
  - Scanner zum Löschen ungenutzter Bilder
  - optional erzwungenes Löschen auch bei aktiver Einbindung
- Admin-Suchindex-Verwaltung (`/admin/index`)
  - Backend umschalten: `flat` oder `sqlite` (Hybrid)
  - Suchindex manuell neu generieren
  - Live-Fortschritt mit Progress-Balken
- Admin-Versionsverwaltung (`/admin/versions`)
  - Speicherübersicht der Versionshistorie
  - Manuelle Bereinigung (Retention + Kompression)
- Beim Löschen eines Artikels: automatische Entfernung nicht mehr referenzierter Upload-Bilder
- Verschlüsselte Backups mit separatem Backup-Schlüssel (`scripts/backup-encrypted.sh`, `scripts/backup-decrypt.sh`)
- Admin-Backupverwaltung (`/admin/backups`) mit 1-Klick-Start, Progressbar, Download, Löschen und Restore-Wizard (Upload + Prüfung + explizite Bestätigung)
  - geplante automatische Backups (Intervall) + Retention (Anzahl/Alter)
- Admin-Kategorienverwaltung (`/admin/categories`)
- Admin-Gruppenverwaltung (`/admin/groups`)
- Visueller Setup-Assistent beim ersten Start (`/setup`)
- Sicherheitsgrundlagen: `scrypt`, CSRF, Rate-Limit, Security-Header, Audit-Log
- Kommentare mit Moderation und Admin-Queue (`/admin/comments`)
  - Status `pending` / `approved` / `rejected`
  - Bulk-Freigabe, Bulk-Ablehnung, Bulk-Löschen und Seitenweises Löschen
  - Konfigurierbare Modi: immer Freigabe nötig / alle auto-freigeben / nur Trusted User auto-freigeben
- Erwähnungen in Kommentaren (`@username`)
  - Live-Vorschläge im Kommentarfeld
  - Klick auf `@username` im Kommentar übernimmt Mention direkt ins Eingabefeld (Reply-Flow)
- Zusätzliche Kommentar-Härtung
  - Rate-Limits auf Kommentar-/Upload-Endpunkten
  - Link-/Mention-Limits pro Kommentar
  - Cooldown und Duplikat-Schutz gegen Spam
- Upload-Schutz für `/uploads/*` konsistent mit Auth/Public-Read-Modus
- E-Mail-Verwaltung im Admin (`/admin/mail`) inkl. SMTP-Testmail
  - SMTP- und User-E-Mail-Daten lokal verschlüsselt gespeichert (bei gesetztem `SECRET_ENCRYPTION_KEY`, sonst `CONTENT_ENCRYPTION_KEY`-Fallback)
- Stabilitäts-Checks in CI (Merge-Konfliktmarker, TypeScript-Build, Smoketest, Docker-Build)
- 1-Klick Domain/HTTPS-Setup-Script mit Caddy + Let's Encrypt (ACME): `scripts/deploy-caddy.sh`

## Screenshots

Startseite:

![FlatWiki Startseite](docs/screenshots/screenshot-home.png)

Artikelansicht:

![FlatWiki Artikelansicht](docs/screenshots/screenshot-article.png)

Inhaltsverzeichnis:

![FlatWiki Inhaltsverzeichnis](docs/screenshots/screenshot-toc.png)

Admin-Bereich:

![FlatWiki Admin](docs/screenshots/screenshot-admin.png)

Light-Mode:

![FlatWiki Light-Mode](docs/screenshots/screenshot-home-light.png)

## Starten

### Schnellstart (Docker empfohlen)

Voraussetzungen: Docker Engine + Compose + Buildx

```bash
git clone https://github.com/McCryptoX/flatwiki && cd flatwiki && ./install.sh
```

Das Script erstellt `config.env` mit sicheren Zufallswerten und startet FlatWiki automatisch mit Docker.

Beim ersten Start den Setup-Assistenten aufrufen:

- [http://127.0.0.1:3000/setup](http://127.0.0.1:3000/setup)

---

### Option A: Node.js + npm

Voraussetzungen: Node.js 20+, npm

```bash
./install.sh
npm install
npm run dev
```

Danach im Browser öffnen und Setup abschließen:

- [http://127.0.0.1:3000/setup](http://127.0.0.1:3000/setup)

Produktion:

```bash
npm run build
npm start
```

### Option B: Docker

Voraussetzungen: Docker Engine + Compose + Buildx

```bash
./install.sh
docker compose up -d --build
```

Hinweis: `HOST=0.0.0.0` in `config.env` belassen (Standard in `config.env.example`).

### Docker auf Ubuntu installieren (inkl. Buildx)

Wenn `docker-buildx-plugin` in den Standard-Ubuntu-Repos fehlt, nutze das offizielle Docker-Repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker buildx version
docker compose version
```

Optional (ohne `sudo` für Docker-Kommandos):

```bash
sudo usermod -aG docker "$USER"
newgrp docker
```

Danach FlatWiki starten:

```bash
./install.sh
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
- beim ersten Start: [http://127.0.0.1:3000/setup](http://127.0.0.1:3000/setup)

### Docker-Fehlerbehebung

- Fehler `fork/exec ... docker-buildx: exec format error`: Es liegt oft ein falsches manuelles Plugin unter `~/.docker/cli-plugins/docker-buildx`.
- `docker compose pull` ist hier nicht erforderlich, da lokal gebaut wird. Nutze `docker compose up -d --build`.
- Fix:

```bash
rm -f ~/.docker/cli-plugins/docker-buildx
sudo apt-get install --reinstall -y docker-buildx-plugin
docker buildx version
docker compose up -d --build
```

## Domain + HTTPS (Let's Encrypt / ACME)

Empfohlen: FlatWiki hinter Caddy als Reverse-Proxy betreiben.

Vorteile:

- automatische TLS-Zertifikate via Let's Encrypt (ACME)
- automatische Verlängerung
- saubere Trennung: App bleibt intern, TLS liegt beim Proxy

Schnellstart:

```bash
cd /pfad/zu/FlatWiki
./scripts/deploy-caddy.sh --domain wiki.example.com --email admin@example.com
```

Das Script erzeugt lokal (nicht für Git):

- `deploy/Caddyfile`
- `deploy/logs/access.log`
- `docker-compose.caddy.yml`

Und startet:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

Danach prüfen:

- `https://wiki.example.com`
- Admin -> `TLS/SSL` (`/admin/ssl`)

Voraussetzungen:

- DNS (`A`/`AAAA`) zeigt auf den Server
- Ports `80` und `443` sind offen

### Optional: fail2ban für Caddy (Brute-Force/Scanner)

Für Docker-Caddy enthält FlatWiki ein passendes Setup-Script:

```bash
cd /pfad/zu/FlatWiki
sudo ./scripts/setup-fail2ban-caddy.sh
```

Das Script:

- richtet einen Filter für Caddy-Access-Logs ein
- legt eine Jail (`flatwiki-caddy`) an
- überwacht `deploy/logs/access.log`

Status prüfen:

```bash
sudo fail2ban-client status
sudo fail2ban-client status flatwiki-caddy
```

Mehrere Instanzen (Beispiel):

```bash
sudo ./scripts/setup-fail2ban-caddy.sh --instance-dir /opt/flatwiki-public --jail-name flatwiki-public
sudo ./scripts/setup-fail2ban-caddy.sh --instance-dir /opt/flatwiki-private --jail-name flatwiki-private
```

## Wichtige Hinweise

- Der erste Admin wird standardmäßig über den Setup-Assistenten (`/setup`) angelegt.
- `BOOTSTRAP_ADMIN_PASSWORD` ist optional für Headless-Bootstrap und wird nur beim Erststart genutzt (wenn `data/users.json` leer ist).
- `PASSWORD_PEPPER` nach dem ersten produktiven Start nicht mehr ändern, sonst funktionieren bestehende Passwörter nicht mehr.
- Kryptoschlüssel werden nicht separat im `data/`-Ordner persistiert. Quelle ist ausschließlich `config.env`.
- `CONTENT_ENCRYPTION_KEY` nach produktivem Start nicht mehr ändern, sonst können bestehende verschlüsselte Artikel nicht mehr gelesen werden.
- `SECRET_ENCRYPTION_KEY` nach produktivem Start nicht mehr ändern, sonst können gespeicherte SMTP-/User-Secrets nicht mehr gelesen werden.
- `CONTENT_INTEGRITY_KEY` nach produktivem Start nicht mehr ändern, sonst schlagen Integritätsprüfungen signierter Artikel fehl.
- `BACKUP_ENCRYPTION_KEY` nach produktivem Start nicht leichtfertig ändern, sonst sind ältere Backups u.U. nicht mehr entschlüsselbar.
- Sensibler Modus funktioniert nur mit `CONTENT_ENCRYPTION_KEY`; ohne Schlüssel ist die Option im Editor deaktiviert.
- `VERSION_HISTORY_RETENTION` bestimmt, wie viele Versionen pro Artikel behalten werden.
- `VERSION_HISTORY_COMPRESS_AFTER` bestimmt, ab welcher Position ältere Versionen komprimiert werden.
- Keine Secrets committen. `config.env` bleibt lokal; nur `config.env.example` wird versioniert.
- Uploads liegen in `data/uploads/` (pro Kategorie in Unterordnern) und werden als `/uploads/...` bereitgestellt.
- Für Backup-Verschlüsselung einen separaten Schlüssel nutzen (`BACKUP_ENCRYPTION_KEY`), nicht `CONTENT_ENCRYPTION_KEY`.
- Für Secret-Storage einen separaten Schlüssel nutzen (`SECRET_ENCRYPTION_KEY`), nicht `CONTENT_ENCRYPTION_KEY`.

## Erstes Admin-Konto

Beim ersten Start öffnest du `/setup` und legst dort den ersten Admin an:

- Admin-Benutzername
- Anzeigename
- Passwort

Optional (ohne UI): Wenn `BOOTSTRAP_ADMIN_PASSWORD` gesetzt ist, wird beim Erststart automatisch ein Admin erstellt.

Hinweis: Existiert bereits ein Konto in `data/users.json`, wird `/setup` übersprungen.

### Admin-Passwort per CLI zurücksetzen (Docker)

Wenn das Login nicht mehr funktioniert, kannst du das Admin-Passwort direkt neu setzen:

```bash
cd /pfad/zu/FlatWiki
# Diese Variable wird in der nächsten Zeile als $NEW_ADMIN_PASSWORD verwendet.
# Nur normale ASCII-Anführungszeichen verwenden: '...'
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

Installer:

- `./install.sh` erstellt/ergänzt `config.env` automatisch und generiert sichere Einmalwerte.
- Beim ersten App-Start ergänzt FlatWiki fehlende Schlüssel ebenfalls automatisch.

Pflicht in Produktion:

- `COOKIE_SECRET` (langes zufälliges Secret)
- `CONTENT_INTEGRITY_KEY` (64 Hex, wird für Erstellen/Bearbeiten von Artikeln benötigt)
- `BACKUP_ENCRYPTION_KEY` (Secret für verschlüsselte Backups, getrennt vom Content-Key)

Optional:

- `PASSWORD_PEPPER`
- `CONTENT_ENCRYPTION_KEY` (64 Hex, AES-256-GCM für Artikelinhalt)
- `SECRET_ENCRYPTION_KEY` (64 Hex, AES-256-GCM für SMTP-/User-Secrets; Fallback: `CONTENT_ENCRYPTION_KEY`)
- `BOOTSTRAP_ADMIN_USERNAME`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `WIKI_TITLE`
- `INDEX_BACKEND` (`flat` oder `sqlite`, Standard: `flat`)
- `VERSION_HISTORY_RETENTION` (Standard: `150`)
- `VERSION_HISTORY_COMPRESS_AFTER` (Standard: `30`, `0` = alles komprimieren)
- `BACKUP_AUTO_ENABLED` (`true`/`false`, Standard: `false`)
- `BACKUP_AUTO_INTERVAL_HOURS` (Standard: `24`)
- `BACKUP_RETENTION_MAX_FILES` (Standard: `30`, `0` = unbegrenzt)
- `BACKUP_RETENTION_MAX_AGE_DAYS` (Standard: `0`, `0` = deaktiviert)

Hybrid-Modus:

- Mit `INDEX_BACKEND=sqlite` bleiben Artikel weiterhin als Markdown-Dateien die Quelle der Wahrheit.
- Suche/Metadaten/Rechte-Index werden zusätzlich in `data/index/pages.sqlite` gehalten.
- Fallback bleibt aktiv: `data/index/pages.json` wird weiterhin gepflegt und bei SQLite-Problemen genutzt.
- Umschalten ist auch im Admin-Bereich unter `/admin/index` möglich (ohne manuelle Dateibearbeitung).
- Die Laufzeit-Umschaltung wird in `data/runtime-settings.json` gespeichert (nicht für Git gedacht).

## Git-Upload (ohne lokale Laufzeitdaten)

Folgende Dateien bewusst **nicht** committen: `config.env`, `data/users.json`, `data/sessions.json`, `data/audit.log`, `data/index/*`, `data/uploads/*`.

Empfehlung:

```bash
git status --short
```

## Stabilität prüfen (lokal)

Vor einem Release/Push kannst du die Kernchecks lokal ausführen:

```bash
./scripts/check-merge-markers.sh
npm run build
./scripts/smoke-test.sh
docker build -t flatwiki-local-check .
```

## Backup und Restore (verschlüsselt)

Automatische Backups + Retention:

- Steuerung über `config.env`:
  - `BACKUP_AUTO_ENABLED=true`
  - `BACKUP_AUTO_INTERVAL_HOURS=24`
  - `BACKUP_RETENTION_MAX_FILES=30`
  - `BACKUP_RETENTION_MAX_AGE_DAYS=0`
- Status, letzter Lauf und nächster Lauf werden unter `/admin/backups` angezeigt.
- Retention kann dort zusätzlich per Button **„Retention jetzt ausführen“** manuell gestartet werden.

Backup im Admin-Menü:

- Unter `/admin/backups` auf **„Backup jetzt erstellen“** klicken.
- Fortschritt und Ergebnisdatei werden live angezeigt.
- Backups liegen in `data/backups/`.

Restore im Admin-Menü (Wizard):

1. Unter `/admin/backups` eine `.tar.gz.enc` hochladen und mit Passphrase prüfen.
2. Nach erfolgreicher Prüfung die Wiederherstellung explizit bestätigen.
3. Restore läuft asynchron mit Fortschrittsanzeige.

Wichtig zur Passphrase:

- Die Restore-Passphrase ist **exakt** der Wert von `BACKUP_ENCRYPTION_KEY` aus `config.env`.
- Es ist **nicht** das FlatWiki-Login-Passwort.
- Im Admin-Bereich wird dazu ein gekürzter Fingerprint angezeigt (ohne Secret-Ausgabe).
- Schlüssel sicher dokumentieren (z. B. Passwortmanager), sonst sind Backups bei Schlüsselverlust nicht mehr nutzbar.

CLI-Backup mit separatem Schlüssel:

```bash
cd /pfad/zu/FlatWiki
export BACKUP_ENCRYPTION_KEY='separater-backup-key'
./scripts/backup-encrypted.sh
```

CLI-Restore (Entschlüsseln in Zielordner):

```bash
cd /pfad/zu/FlatWiki
export BACKUP_ENCRYPTION_KEY='separater-backup-key'
./scripts/backup-decrypt.sh ./backups/flatwiki-backup-YYYYMMDD-HHMMSS.tar.gz.enc /ziel/pfad
```

Hinweise:

- Backup-Schlüssel getrennt vom Content-Key halten.
- Bei vorhandener `.sha256` wird die Prüfsumme beim Restore verifiziert.
- Während eines laufenden Backup/Restore sind konkurrierende Aktionen gesperrt.

## Versionshistorie und Diff

- Historie pro Artikel: `/wiki/<seitenadresse>/history`
- Einzelne Version ansehen: `/wiki/<seitenadresse>/history/<versionId>`
- Diff anzeigen: `/wiki/<seitenadresse>/history/<versionId>/diff`
- Im Diff kann der Vergleichspartner gewählt werden:
  - aktueller Stand
  - andere gespeicherte Versionen
- Admins können aus der Historie direkt auf eine ältere Version zurücksetzen.

## Artikel-Editor

- Bilder können direkt im Editor hochgeladen werden.
- Pro Upload sind mehrere Dateien möglich (1-x).
- Bei verschlüsselten Artikeln ist der Bild-Upload bewusst deaktiviert.
- Bei sensiblen Artikeln wird Zugriff automatisch auf „nur ausgewählte Benutzer/Gruppen“ gesetzt und Verschlüsselung erzwungen.
- Inhalte sensibler Artikel werden nicht für die Volltextsuche indexiert.
- Dateinamen werden automatisch in eindeutige Namen umbenannt.
- Die Seitenadresse (URL-Pfad) wird aus dem Titel automatisch erzeugt und kann bei Bedarf angepasst werden.
- Nach dem Upload werden die Markdown-Bildlinks automatisch in den Artikelinhalt eingefügt.
- Toolbar für schnelle Formatierung (Überschriften, Listen, Links, Code, Tabelle).
- Live-Vorschau im Editor per Button auf "Vorschau".
- Überschriften (`##`, `###`, ...) erzeugen automatisch eine linke Artikel-Navigation.
- Beim Erstellen hilft ein 3-Schritte-Assistent inkl. Seitenvorlagen.
- Inhaltstyp-Vorlagen im Assistenten kommen aus der Admin-Vorlagenverwaltung (`/admin/templates`).
- Format-Hilfe als Wiki-Seite: `/wiki/markdown-formatierung-howto`

## Wikitext importieren (MediaWiki)

- Admin-Bereich: `/admin/import/wikitext`
- Du kannst Wikitext direkt einfügen oder als Datei hochladen (`.txt`, `.wiki`, `.wikitext`, `.mediawiki`).
- FlatWiki konvertiert in Markdown und speichert den Artikel regulär im Flat-File-Format.
- Wenn kein Titel gesetzt ist, wird die erste Hauptüberschrift (`= Titel =`) als Titel verwendet.
- Für sensible Altinhalte kannst du beim Import direkt `Vertraulich` wählen (verschlüsselt + eingeschränkter Zugriff).
- Nach dem Import bitte die Zielseite kurz prüfen, da sehr komplexe Wikitext-Sonderfälle je nach Quelle manuelle Nacharbeit brauchen können.

## Bildverwaltung und Cleanup

- Admins können unter `/admin/media` alle Upload-Dateien verwalten.
- Für jede Datei zeigt FlatWiki:
  - ob sie eingebunden ist
  - in welchen Artikeln sie referenziert wird
  - Dateigröße und Änderungszeit
- Der Button "Ungenutzte Bilder löschen" entfernt alle nicht referenzierten Dateien automatisch.
- Beim Löschen einer Wiki-Seite werden deren Bildreferenzen geprüft und danach ungenutzte Upload-Dateien ebenfalls automatisch entfernt.

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
├─ install.sh
├─ scripts/
│  ├─ backup-encrypted.sh
│  ├─ backup-decrypt.sh
│  ├─ deploy-caddy.sh
│  └─ setup-fail2ban-caddy.sh
├─ data/
│  └─ wiki/
├─ public/
├─ src/
├─ LICENSE
├─ README.md
├─ SECURITY.md
└─ CONTRIBUTING.md
```
