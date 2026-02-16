---
title: FlatWiki - Komplette Nutzung
tags:
  - handbuch
  - anleitung
  - admin
  - benutzer
createdAt: 2026-02-14T13:30:00.000Z
updatedAt: 2026-02-15T17:05:00.000Z
updatedBy: system
---

# FlatWiki - Komplette Nutzung

Diese Seite ist eine vollstaendige Anleitung fuer Benutzer und Admins.

## 1. Login und Startseite

1. Rufe die Login-Seite auf (`/login`).
2. Melde dich mit Benutzername und Passwort an.
3. Nach dem Login landest du auf der Wiki-Uebersicht.

Auf der Startseite findest du:

- die Uebersicht aller Wiki-Seiten
- die Suche mit Live-Vorschlaegen
- den Button **Neue Seite**
- die Navigation zu **Konto** und (fuer Admins) **Admin**
- Vollstaendige Anleitung: [FlatWiki - Komplette Nutzung](/wiki/flatwiki-komplette-nutzung)
- Formatierungsleitfaden: [Markdown-Formatierung HowTo](/wiki/markdown-formatierung-howto)

## 2. Wiki-Seiten lesen

1. Klicke auf eine Seite in der Uebersicht.
2. Die Seite wird gerendert (Markdown -> HTML) angezeigt.
3. Bilder, Listen, Code-Bloecke und Ueberschriften werden unterstuetzt.
4. Ab `##` wird automatisch die linke Artikel-Navigation aufgebaut.

## 3. Neue Seite erstellen

1. Klicke auf **Neue Seite**.
2. Nutze den **Schnell-Assistenten** (3 Schritte):

- **Inhaltstyp**: Idee, Dokumentation, Reisebericht, Finanznotiz oder Leer starten
- **Kategorie**: passende Kategorie waehlen
- **Schutz**: Standard oder Sensibel

3. Fuelle die Felder aus (oder passe die Vorlage an):

- **Titel**: sichtbarer Seitentitel
- **Seitenadresse (URL-Pfad)**: z. B. `betriebshandbuch`
- **Kategorie**: z. B. `Allgemein`
- **Zugriff**: alle Benutzer oder nur freigegebene Benutzer/Gruppen
- **Tags**: kommagetrennt, z. B. `intern,prozess`
- **Inhalt (Markdown)**: eigentlicher Text

4. Speichern mit **Seite erstellen**.

Hinweise:

- Die **Seitenadresse** wird beim Tippen des Titels automatisch erstellt.
- Erlaubt sind `a-z`, `0-9` und `-`.
- Existiert die Seitenadresse bereits, zeigt FlatWiki eine Fehlermeldung.
- Bei **Sensibel** wird Zugriff immer auf **nur ausgewaehlte Benutzer/Gruppen** gesetzt und Verschluesselung erzwungen.
- Ohne `CONTENT_ENCRYPTION_KEY` kann ein sensibler Artikel nicht gespeichert werden.

## 4. Seite bearbeiten

1. Oeffne eine Wiki-Seite.
2. Klicke auf **Bearbeiten**.
3. Aendere Titel, Tags oder Inhalt.
4. Speichere mit **Aenderungen speichern**.
5. Jede Aenderung erzeugt einen Historieneintrag.

## 5. Seite loeschen (nur Admin)

1. Oeffne die gewuenschte Seite.
2. Klicke auf **Loeschen**.
3. Bestaetige den Dialog.

Nur Benutzer mit Rolle `admin` duerfen Seiten loeschen.

## 6. Suche nutzen

1. Gib oben im Suchfeld einen Begriff ein.
2. Waehrend der Eingabe erscheinen Live-Vorschlaege.
3. Klicke auf **Suchen** oder bestaetige mit Enter.
4. FlatWiki durchsucht:

- Titel
- Tags
- Seiteninhalt
- Auszuege aus Markdown-Text

Hinweis:

- Bei sensiblen/verschluesselten Artikeln werden nur Metadaten (z. B. Titel/Tags) indexiert, kein Klartext-Inhalt.

## 7. Interne Links und Backlinks

FlatWiki unterstuetzt interne Wiki-Links:

- `[[Seitenname]]`
- `[[Seitenname|Eigener Linktext]]`

Zusaetzlich:

- Unter jedem Artikel siehst du den Bereich **Verlinkt von** (Backlinks).
- Defekte interne Links kann ein Admin unter **Admin -> Link-Check** pruefen.
- Dort kann direkt eine fehlende Zielseite angelegt werden.

## 8. Mein Konto

Unter **Konto** kannst du:

- deine Kontodaten einsehen
- dein Passwort aendern
- deine Daten als JSON exportieren

### Passwort aendern

1. Altes Passwort eingeben.
2. Neues Passwort zweimal eingeben.
3. Speichern.

Danach werden aktive Sessions beendet und du meldest dich neu an.

## 9. Bilder im Artikel

Im Editor kannst du Bilder direkt hochladen:

1. Datei auswaehlen (auch mehrere Dateien auf einmal).
2. Upload starten.
3. Den erzeugten Markdown-Block direkt in den Artikel uebernehmen.

Hinweise:

- Dateinamen werden automatisch sicher umbenannt.
- Uploads liegen je Kategorie in eigenen Ordnern.
- Nicht mehr verwendete Bilder koennen im Admin-Bereich bereinigt werden.

## 10. Admin-Bereich

Wichtige Admin-Seiten:

- **Benutzerverwaltung**: Benutzer anlegen, aendern, deaktivieren, loeschen
- **Bildverwaltung**: Einbindungen pruefen, ungenutzte Bilder loeschen
- **Kategorien**: Kategorien anlegen und umbenennen
- **Gruppen**: Benutzergruppen fuer Freigaben verwalten
- **Versionen**: Historie pruefen, Bereinigung starten
- **TLS/SSL**: Proxy-/HTTPS-Status read-only pruefen (`/admin/ssl`)
- **Link-Check**: defekte interne Links finden
- **Suchindex**: Index-Backend waehlen und Neuaufbau starten

Sicherheitsregeln in der Benutzerverwaltung:

- eigenes Konto kann nicht geloescht werden
- mindestens ein aktiver Admin muss erhalten bleiben

## 11. Zugriff und Verschluesselung

Pro Artikel kannst du:

- den Zugriff einschraenken (nur ausgewaehlte Benutzer/Gruppen)
- optional **Verschluesselung im Dateisystem (AES-256)** aktivieren
- den Modus **Sensibel** aktivieren

Wichtig:

- Sensibel erzwingt eingeschraenkten Zugriff und aktivierte Verschluesselung.
- Fuer Verschluesselung/Sensibel muss `CONTENT_ENCRYPTION_KEY` gesetzt sein.
- Ohne korrekten Schluessel koennen verschluesselte Seiten nicht gelesen werden.
- Sensible Inhalte werden nicht als Klartext in den Suchindex uebernommen.

## 12. Dateibasiertes Datenmodell

FlatWiki speichert ohne klassische SQL-Datenbank als primaere Quelle:

- `data/wiki/*.md` -> Wiki-Seiten (Quelle der Wahrheit)
- `data/users.json` -> Benutzerkonten
- `data/sessions.json` -> Sessions
- `data/audit.log` -> Audit-Ereignisse
- `data/uploads/` -> hochgeladene Dateien
- `data/versions/` -> Artikelhistorie

Optional kann der Suchindex im Hybrid-Modus in SQLite liegen:

- `data/index/pages.sqlite` (Index)
- `data/index/pages.json` (Fallback)

## 13. Backup und Restore

### Backup

FlatWiki kann Backups im Admin-Bereich erstellen:

1. Admin -> **Backups**
2. **Backup jetzt erstellen**
3. Datei aus `data/backups/` herunterladen (optional)

Automatische Backups + Retention:

- ueber `config.env` steuerbar (`BACKUP_AUTO_ENABLED`, `BACKUP_AUTO_INTERVAL_HOURS`, `BACKUP_RETENTION_MAX_FILES`, `BACKUP_RETENTION_MAX_AGE_DAYS`)
- Status und naechster Lauf sind in Admin -> Backups sichtbar

Beispiel:

```bash
export BACKUP_ENCRYPTION_KEY='dein_backup_key'
./scripts/backup-encrypted.sh
```

### Restore

Im Admin-Bereich:

1. Admin -> **Backups**
2. `.tar.gz.enc` hochladen und pruefen
3. Wiederherstellung explizit bestaetigen

Wichtig:

- Die Passphrase fuer Backup/Restore ist **genau** `BACKUP_ENCRYPTION_KEY` aus `config.env`.
- Das ist **nicht** dein Login-Passwort.
- Wenn dieser Schluessel verloren geht, koennen verschluesselte Backups nicht mehr wiederhergestellt werden.

## 14. Datenschutzfreundlicher Betrieb

FlatWiki enthaelt technische Schutzmechanismen:

- Passwort-Hashing (`scrypt`)
- CSRF-Schutz
- Rate-Limiting
- Audit-Log
- Datenexport fuer Benutzer

Fuer den produktiven Betrieb zusaetzlich organisatorisch klaeren:

- Rechtsgrundlagen
- Aufbewahrungs- und Loeschfristen
- Verantwortlichkeiten
- Impressum und finale Datenschutzhinweise

## 15. Tipps fuer den Alltag

- Tags konsequent verwenden (z. B. `prozess`, `faq`, `it`, `hr`).
- Seiten kurz und thematisch getrennt halten.
- Fuer Aenderungen an sensiblen Inhalten Freigabeprozess definieren.
- `data/` in Backups aufnehmen, aber niemals oeffentlich veroeffentlichen.

## 16. Beispiel-Markdown

```md
## Team-Regel

- Anfragen ueber das Ticket-System
- Antwortzeit: 24h
- Eskalation bei Prioritaet "hoch"
```

Damit hast du eine vollstaendige Referenz fuer die Nutzung von FlatWiki.
