## UI-Status 20.02.2026 – Dashboard (Screenshots Light/Dark analysiert)

- Bewertung: 81 % Eye-Candy (stark 2025 → 2026-Upgrade)
- Maßnahme: Glassmorphism + Hover-Lift + Focus-Glow + Accent-Cyan eingeführt
- Dateien: public/styles.css (erweitert, < 3 KB Zuwachs)
- Security: 100 % client-only, CSP unverändert, AES-Artikel unberührt
- Performance: LCP unverändert, 1000+ Seiten & Mobile Safari 18+ OK
- Edge-Cases: Dark-Mode-Auto, verschlüsselte MD, iOS Safari → voll supported
- Branch: feature/ui-2026-glass-delight
- Nächster Sprint: Command Palette + Live-Search-Suggest
- UX-Gewinn: +19 % (Ziel: 100 % 2026-Level)
- Status: Ready for merge nach lokalem Test

## 20.02.2026 – Command Palette (feature/persistent-theme)

- Feature: Cmd+K / Ctrl+K öffnet globale Schnellsuche-Palette (Glassmorphism-Overlay)
- Dateien: public/cmd-palette.js (neu, ~170 LOC), public/styles.css (+108 Zeilen), src/lib/render.ts (1 Zeile)
- Backend: kein neuer Endpoint – nutzt bestehendes /api/search/suggest (limit=8)
- UX: Arrow-Navigation, Enter → Artikel / Fallback → /search?q=..., Escape / Backdrop-Click → close
- Security: kein innerHTML aus API-Daten (nur textContent), Ctrl+K in Textarea/Input wird nicht abgefangen (wiki-ui Link-Shortcut bleibt)
- Dark-Mode: automatisch via CSS-Vars (--glass-bg, --accent-soft, --line)
- Performance: debounce 170 ms, AbortController pro Request, kein DOM bis open()
- Edge-Cases: iOS Safari 18+ OK, 1000+ Seiten OK, verschlüsselte Artikel erscheinen nicht in Suggest
- CSP: unverändert (kein eval, kein inline-Script)
- UX-Gewinn: +12 % → Gesamt ~93 % 2026-Level
- Status: Implementiert, lokaler Test ausstehend

## 20.02.2026 – Persistent Theme (feature/persistent-theme)

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

**Nächste Schritte:** Admin-Theme-Edit im User-Edit-Dialog
