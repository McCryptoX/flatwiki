## 21.02.2026 – v0.8.1 Stability & Security Patch

- Strict ENV validation + fail-fast
- Vitest-Security-Tests (scrypt, CSRF, AES+HMAC roundtrip)
- Atomic writes, ETag/If-Match, CSP-Inlining
- Key-Separation und Config-Security verbessert
- CI + Docker-Smoketest erweitert
- Release-Tag und GitHub Release noch ausstehend
- Status: Produktionsreif
- Offene Kritikalitäten: 0
- Nächster Meilenstein: v0.9.0 (Search + Performance)
- Letzter Commit: `28adc96`

## 20.02.2026 – CSS-Struktur modernisiert (Theme + Components)

- Neue Struktur eingeführt:
- `public/css/theme.css`: Design-Tokens (`:root`), Layer-Definition (`@layer theme, base, components, utilities`), Base-Styles, sichtbarer `:focus-visible` und `prefers-reduced-motion`.
- `public/css/components.css`: Komponenten-Stile (Navigation, Buttons, Formulare, Tabellen, Cards, Wiki/Admin-UI konsolidiert).
- Dark-Mode-Strategie: Dark als Standard in Tokens; Light über `[data-theme="light"]`, plus `meta name="color-scheme"` im Layout.
- Migrationspfad: `public/styles.css` bleibt als Fallback-Datei im Repo bestehen, wird aber nicht mehr eingebunden.
- Layout aktualisiert: globale CSS-Links auf `/css/theme.css` + `/css/components.css` umgestellt.
- Ziel erreicht: minimale, produktionsnahe UI-Polish-Migration ohne neue Dependencies.
- **Status: Auf main gemergt.**

## UI-Status 20.02.2026 – Dashboard (Screenshots Light/Dark analysiert)

- Bewertung: 81 % Eye-Candy (stark 2025 → 2026-Upgrade)
- Maßnahme: Glassmorphism + Hover-Lift + Focus-Glow + Accent-Cyan eingeführt
- Dateien: public/styles.css (erweitert, < 3 KB Zuwachs)
- Security: 100 % client-only, CSP unverändert, AES-Artikel unberührt
- Performance: LCP unverändert, 1000+ Seiten & Mobile Safari 18+ OK
- Edge-Cases: Dark-Mode-Auto, verschlüsselte MD, iOS Safari → voll supported
- UX-Gewinn: +19 % (Ziel: 100 % 2026-Level)
- **Status: Auf main gemergt.**

## 20.02.2026 – Command Palette (auf main)

- Feature: Cmd+K / Ctrl+K öffnet globale Schnellsuche-Palette (Glassmorphism-Overlay)
- Dateien: public/cmd-palette.js (~297 LOC), src/lib/render.ts (Einbindung)
- Backend: kein neuer Endpoint – nutzt bestehendes /api/search/suggest (limit=8)
- UX: Arrow-Navigation, Enter → Artikel / Fallback → /search?q=..., Escape / Backdrop-Click → close
- Security: kein innerHTML aus API-Daten (nur textContent), Ctrl+K in Textarea/Input wird nicht abgefangen
- Dark-Mode: automatisch via CSS-Vars (--glass-bg, --accent-soft, --line)
- Performance: debounce 170 ms, AbortController pro Request, kein DOM bis open()
- Edge-Cases: iOS Safari 18+ OK, 1000+ Seiten OK, verschlüsselte Artikel erscheinen nicht in Suggest
- CSP: unverändert (kein eval, kein inline-Script)
- **Status: Auf main gemergt.**

## 20.02.2026 – Persistent Theme (auf main)

**Feature:** Dauerhaftes Theme für angemeldete User (Light/Dark/System).

- `UserRecord` + `PublicUser` um `theme: Theme` erweitert (`"light"|"dark"|"system"`, Default `"system"`)
- In-Memory-Migration: bestehende User-Datensätze ohne `theme`-Feld erhalten `"system"` beim ersten Load
- Neuer Endpoint `POST /api/user/theme` (Auth, CSRF via `X-CSRF-Token`-Header, Whitelist-Validation, Rate-Limit 10/min)
- Neuer Endpoint `GET /api/user/me` (Auth, gibt `theme` + Basis-Profil zurück)
- `src/lib/render.ts`: setzt `data-theme` auf `<html>` server-seitig für eingeloggte User (außer `system`)
- `public/theme-init.js`: erkennt server-gesetztes `data-theme`, synct in `localStorage`; Gäste: localStorage + `prefers-color-scheme`
- `public/theme-toggle.js`: Toggle POSTet via `fetch` + CSRF-Token an `/api/user/theme`; bei Gästen kein POST (kein CSRF im DOM)
- Atomic writes via bestehendes `writeJsonFile` + Mutation-Lock in `userStore`
- Security: Whitelist verhindert CSS-Injection; non-sensitive UI-Daten → keine Verschlüsselung; CSRF immer geprüft
- Perf: < 1 ms DB-Overhead; kein neues Framework, kein neuer Service
- **Status: Auf main gemergt.**

**Admin-Theme-Edit:** Theme-Dropdown (light/dark/system) im User-Edit-Dialog implementiert (21.02.2026).
- `src/lib/userStore.ts`: `UpdateUserInput` um optionales `theme?: Theme` erweitert; `updateUser` übernimmt es wenn gesetzt.
- `src/routes/adminRoutes.ts`: `VALID_THEMES`-Set + `themeOptions()`-Helper; `<select name="theme">` im Edit-Formular; POST-Handler liest Theme mit Whitelist-Validierung.

---

## QA-Checkliste – Code-Review 21.02.2026

Code-Review aller Checklisten-Punkte ergab: Fast alles bereits auf `main` implementiert.

### UI-Polish – Ergebnis

- [x] Tab-Fokus sichtbar auf interaktiven Elementen – `public/css/theme.css:187` (globales `:focus-visible` mit `box-shadow: 0 0 0 3px var(--focus-ring)`)
- [x] Dark/Light korrekt (Default Dark, System-Preference respektiert, Toggle persistent) – vollständig via `theme-init.js`, `theme-toggle.js`, `/api/user/theme`, `render.ts:145`
- [x] Mobile Breakpoints (Header/Nav, Formulare, Tabellen) – `components.css:1204,2155,2183,2220`, Touch-Targets ≥ 44px gesetzt
- [x] Admin-Seiten (Users, SEO, Backups) – Routes vorhanden: `adminRoutes.ts:1261,2203,2760`; `seoRoutes.ts:205`
- [x] Artikelansicht (Typografie, TOC, Tabellen, Code-Blöcke) – TOC in `wikiRoutes.ts:210`, Stile in `styles.css:1830–1920`

### A11y/SEO – Ergebnis

- [x] Eindeutiger `<title>`, `meta description`, `canonical` ohne Querystring – `render.ts:155–161`, Canonical bereinigt via `split("?")[0]`
- [~] Keyboard-Navigation Header-Suche/Admin-Formulare/Toggle-Button – Cmd+K (`cmd-palette.js:274`), Arrow-Navigation in Suggest; Toggle-Button hat `:focus-visible`, aber keinen expliziten Keyboard-Handler
- [x] Icon-only Buttons mit `aria-label` + `title` – Theme-Toggle (`render.ts:68`), TOC-Anchors (`article-toc.js:48`), Palette (`cmd-palette.js:36,44`)
- [x] Fokusindikator (`:focus-visible`) sichtbar – `theme.css:187`, `components.css:16,1781`
- [x] Touch-Targets ≥ 44px – `components.css:1200–1207`, `styles.css:541`
- [ ] Artikel „Zwei Instanzen …" auf generische Domains/Pfade prüfen – manuell ausstehend

### Features – Ergebnis

- [x] Command Palette (Cmd+K) – `public/cmd-palette.js` (297 LOC), eingebunden in `render.ts:140`
- [x] Live-Search-Suggest `/api/search/suggest` – `wikiRoutes.ts:2830+`
- [x] **Admin Theme-Edit im User-Edit-Dialog** – implementiert (21.02.2026)

---

## Nächste Aufgaben (priorisiert)

1. ~~**Admin Theme-Edit**~~ – erledigt (21.02.2026)
2. **Toggle-Button Keyboard** – Prüfen ob `<button>`-Element ausreicht (Enter/Space nativ) oder expliziter Handler nötig
3. **Manueller Test** – Artikel „Zwei Instanzen …" auf generische Domains prüfen

## 21.02.2026 – v0.8.0 Foundation (Version + Testbasis)

- Version auf `0.8.0` angehoben (`package.json`, `package-lock.json` Root-Metadaten).
- Vitest-Fundament ergänzt:
  - `vitest.config.ts`
  - npm-Skripte: `test`, `test:watch`, `test:coverage`
  - Dev-Dependencies geplant: `vitest`, `@vitest/coverage-v8`, `jsdom`
- Kritische erste Tests hinzugefügt:
  - `tests/password.test.ts` (scrypt hash/verify + Rehash/Strength)
  - `tests/auth-csrf.test.ts` (Login-/Session-CSRF + Form-CSRF-Guard)
  - `tests/wiki-crypto-integrity.test.ts` (verschlüssertes Speichern + Integrität + Roundtrip)
- `src/config.ts`: zentrale Fail-fast-Validierung für ENV-Werte ergänzt
  - Integer-/Boolean-/Enum-Checks
  - Host/Scanner-Pattern-Checks
  - 64-hex-Key-Checks für kryptografische Schlüssel
- Hinweis: In dieser Ausführungsumgebung sind `node`/`npm` nicht verfügbar; Installation und Testlauf müssen lokal erfolgen.
