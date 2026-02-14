# Third-Party Licenses

FlatWiki nutzt Open-Source-Abhängigkeiten aus dem npm-Ökosystem.

## Wichtiger Hinweis

Die genauen Lizenztexte der installierten Abhängigkeiten können je nach Version variieren.
Bitte prüfe für Releases oder redistributable Builds die tatsächlich installierten Pakete in `node_modules`.

## Lizenzprüfung (lokal)

Empfohlenes Vorgehen:

1. Abhängigkeiten installieren:

```bash
npm install
```

2. Lizenzreport erzeugen (Beispiel mit `license-checker`):

```bash
npx license-checker --production --summary
```

3. Bei Bedarf vollständigen Report erzeugen:

```bash
npx license-checker --production --json > licenses-report.json
```

## Projektlizenz

FlatWiki selbst steht unter der MIT-Lizenz, siehe [`LICENSE`](LICENSE).
