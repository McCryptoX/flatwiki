# FlatWiki Homepage (Upload-ready, Caddy)

Dieser Ordner ist der komplette Upload-Ordner für die Homepage.

## Upload

- Den **Inhalt von `_homepage/sites`** als Webroot hochladen.
- `index.html` muss im Ziel direkt im Webroot liegen.
- Wenn du Caddy nutzt: `Caddyfile.example` als Vorlage verwenden.

## Struktur

- `index.html` – Landingpage (SEO + Schema.org)
- `datenschutz.html` – Datenschutzhinweise
- `impressum.html` – Impressum
- `404.html` – Fehlerseite für nicht gefundene URLs
- `robots.txt`
- `sitemap.xml`
- `assets/` – CSS, JS, Bilder
- `favicon.svg`, `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `android-chrome-*.png`
- `site.webmanifest`, `browserconfig.xml`
- `references/` – Screenshots/Quelldateien (nicht für Live-Auslieferung erforderlich)
- `scripts/` – Homepage-spezifische Build-Skripte (z. B. Bildpipeline)
- `docs/` – Homepage-spezifische Doku (z. B. Performance/Image-Checks)
- `Caddyfile.example` – Caddy-Optimierung (Compression + Cache-Control)
- `lighthouse-check.sh` – Lighthouse Gate für Mobile + Desktop (alle Kategorien 100)
- `.htaccess` – optional für Apache
- `nginx-site.conf.snippet` – optional für Nginx

## SEO / Performance Status

Bereits enthalten:
- `meta description`, `canonical`, `robots`
- Open Graph und Twitter Cards
- JSON-LD (`SoftwareApplication`)
- `sitemap.xml` und `robots.txt`
- Responsive Bilder (`srcset`) und AVIF
- `defer` für JavaScript, Lazy-Loading für nicht-kritische Bilder

## Bildpipeline (nur Homepage)

- Build/Optimierung der Landingpage-Bilder:

```bash
cd _homepage/sites
bash ./scripts/build-images.sh
```

- Details und Verifikation: `docs/perf-images.md`

## ETag mit Caddy

- ETag wird bei statischen Dateien in Caddy serverseitig gehandhabt.
- Zusätzliche Optimierung erfolgt über Compression (`encode`) und `Cache-Control` Header (siehe `Caddyfile.example`).

## Lighthouse Check

Beispiel:

```bash
cd _homepage/sites
./lighthouse-check.sh https://flatwiki.de
```

Der Check schlägt fehl, wenn nicht alle vier Kategorien (`performance`, `accessibility`, `best-practices`, `seo`) auf Mobile und Desktop jeweils `100` erreichen.
