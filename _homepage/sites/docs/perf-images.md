# Landingpage Image Pipeline (AVIF/WebP/JPG)

Diese Notiz dokumentiert die Bild-Pipeline der Landingpage für reproduzierbare Performance-Checks.

## Ziel
- Moderne Formate priorisieren (`AVIF`, dann `WebP`),
- `JPG` als Fallback behalten,
- CLS vermeiden über feste `width`/`height`.

## Build
Voraussetzungen:
- `bash`
- `python3`
- `Pillow` (optional: `avifenc` oder `pillow-avif-plugin` für AVIF-Encoding)

Kommandos:
```bash
cd /Users/marco/Documents/CMS/FlatWiki/_homepage/sites
bash ./scripts/build-images.sh
```

Hinweis:
- Das Script ist absichtlich unter `_homepage/sites/scripts/` abgelegt, da es nur die Landingpage betrifft.

Erwartung:
- Für Landingpage-Screenshots entstehen responsive Varianten als
  - `*.avif`
  - `*.webp`
  - `*.jpg`
- Zusätzlich werden WebP-Sidecars für alle verbleibenden `jpg/jpeg/png` in `_homepage/sites/assets/images` erzeugt.

## Markup-Regel
In `/Users/marco/Documents/CMS/FlatWiki/_homepage/sites/index.html` gilt pro Screenshot:

```html
<picture>
  <source type="image/avif" srcset="...avif ..." sizes="..." />
  <source type="image/webp" srcset="...webp ..." sizes="..." />
  <img src="...jpg" srcset="...jpg ..." sizes="..." width="..." height="..." alt="..." />
</picture>
```

Loading-Regel:
- Hero/LCP: `loading="eager"` + `fetchpriority="high"`
- Sonstige Bilder: `loading="lazy"` + `decoding="async"`

## Verifikation lokal
1) Lokalen Static-Server starten:
```bash
cd /Users/marco/Documents/CMS/FlatWiki/_homepage/sites
python3 -m http.server 4173
```

2) Content-Type prüfen:
```bash
curl -I http://127.0.0.1:4173/assets/images/ui-home-dark-960.webp
curl -I http://127.0.0.1:4173/assets/images/ui-home-dark-960.avif
curl -I http://127.0.0.1:4173/assets/images/ui-home-dark-960.jpg
```

Erwartung:
- `image/webp`
- `image/avif`
- `image/jpeg`

3) Browser prüfen (DevTools):
- Seite öffnen: `http://127.0.0.1:4173/index.html`
- Network-Filter: `Img`
- Bei AVIF-fähigem Browser soll bevorzugt `*.avif` geladen werden.
- WebP dient als Fallback vor JPG.

## Deploy-Check
Nach Deployment zusätzlich prüfen:
```bash
curl -I https://flatwiki.de/assets/images/ui-home-dark-960.webp
curl -I https://flatwiki.de/assets/images/ui-home-dark-960.avif
```

Wenn `.webp` noch `404` liefert, sind neue Assets noch nicht ausgerollt.
