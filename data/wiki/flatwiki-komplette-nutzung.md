---
title: FlatWiki - Komplette Nutzung
tags:
  - handbuch
  - anleitung
  - admin
  - benutzer
createdAt: 2026-02-14T13:30:00.000Z
updatedAt: 2026-02-14T13:30:00.000Z
updatedBy: system
---

# FlatWiki - Komplette Nutzung

Diese Seite ist eine vollständige Demo-Anleitung für Benutzer und Admins.

## 1. Login und Startseite

1. Rufe die Login-Seite auf (`/login`).
2. Melde dich mit Benutzername und Passwort an.
3. Nach dem Login landest du auf der Wiki-Übersicht.

Auf der Startseite siehst du:

- alle vorhandenen Wiki-Seiten
- den Suchbereich
- den Button **Neue Seite**
- die Navigation zu **Konto** und (für Admins) **Admin**

## 2. Wiki-Seiten lesen

1. Klicke auf eine Seite in der Übersicht.
2. Die Seite wird gerendert (Markdown -> HTML) angezeigt.
3. Bilder, Listen, Code-Blöcke und Überschriften werden unterstützt.

## 3. Neue Seite erstellen

1. Klicke auf **Neue Seite**.
2. Fülle folgende Felder aus:

- **Titel**: sichtbarer Seitentitel
- **Slug**: URL-Name, z. B. `betriebshandbuch`
- **Tags**: kommagetrennt, z. B. `intern,prozess`
- **Inhalt (Markdown)**: eigentlicher Text

3. Speichern mit **Seite erstellen**.

Hinweise:

- Slug darf nur `a-z`, `0-9` und `-` enthalten.
- Besteht der Slug bereits, wird die Seite nicht überschrieben.

## 4. Seite bearbeiten

1. Öffne eine Wiki-Seite.
2. Klicke auf **Bearbeiten**.
3. Ändere Titel, Tags oder Inhalt.
4. Speichere mit **Änderungen speichern**.

## 5. Seite löschen (nur Admin)

1. Öffne die gewünschte Seite.
2. Klicke auf **Löschen**.
3. Bestätige den Dialog.

Nur Benutzer mit Rolle `admin` dürfen Seiten löschen.

## 6. Suche nutzen

1. Gib oben im Suchfeld einen Begriff ein.
2. Klicke auf **Suchen**.
3. FlatWiki durchsucht:

- Titel
- Tags
- Seiteninhalt
- Auszüge aus Markdown-Text

## 7. Mein Konto

Unter **Konto** kannst du:

- deine Kontodaten einsehen
- dein Passwort ändern
- deine Daten als JSON exportieren

### Passwort ändern

1. Altes Passwort eingeben.
2. Neues Passwort zweimal eingeben.
3. Speichern.

Danach werden aktive Sessions beendet und du meldest dich neu an.

## 8. Admin-Bereich: Benutzerverwaltung

Unter **Admin** -> **Benutzerverwaltung** kann ein Admin:

- neue Benutzer anlegen
- Rollen ändern (`user`/`admin`)
- Benutzer deaktivieren
- Passwörter zurücksetzen
- Benutzer löschen

Sicherheitsregeln:

- ein Admin kann sein eigenes Konto nicht löschen
- es muss mindestens ein aktiver Admin übrig bleiben

## 9. Dateibasiertes Datenmodell

FlatWiki speichert Daten ohne SQL-Datenbank:

- `data/wiki/*.md` -> Wiki-Seiten
- `data/users.json` -> Benutzerkonten
- `data/sessions.json` -> Sessions
- `data/audit.log` -> Audit-Ereignisse

## 10. Backup und Restore

### Backup

Regelmäßig den Ordner `data/` sichern.

Beispiel:

```bash
tar -czf flatwiki-backup-$(date +%F).tar.gz data
```

### Restore

1. Dienst stoppen.
2. `data/` aus Backup zurückspielen.
3. Dienst neu starten.

## 11. DSGVO-orientierter Betrieb

FlatWiki enthält technische Schutzmechanismen:

- Passwort-Hashing (`scrypt`)
- CSRF-Schutz
- Rate-Limiting
- Audit-Log
- Datenexport für Benutzer

Für den produktiven Betrieb zusätzlich organisatorisch klären:

- Rechtsgrundlagen
- Aufbewahrungs- und Löschfristen
- Verantwortlichkeiten
- Impressum und finale Datenschutzhinweise

## 12. Tipps für den Alltag

- Tags konsequent verwenden (z. B. `prozess`, `faq`, `it`, `hr`).
- Seiten kurz und thematisch getrennt halten.
- Für Änderungen an sensiblen Inhalten Freigabeprozess definieren.
- `data/` in Backups aufnehmen, aber niemals öffentlich veröffentlichen.

## 13. Beispiel-Markdown

```md
## Team-Regel

- Anfragen über das Ticket-System
- Antwortzeit: 24h
- Eskalation bei Priorität "hoch"
```

Damit hast du eine vollständige Referenz für die Nutzung von FlatWiki.
