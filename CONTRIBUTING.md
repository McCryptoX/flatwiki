# Contributing

## Development Setup

1. `cp config.env.example config.env`
2. `npm install`
3. `npm run dev`

Alternativ via Docker:

1. `cp config.env.example config.env`
2. `docker compose up -d --build`

## Pull Requests

Bitte in PRs enthalten:

- kurze Problem-/Lösungsbeschreibung
- Hinweise zu Risiken oder Breaking Changes
- ggf. neue/angepasste Doku

## Quality Checks

Vor PR-Review mindestens:

- `npm run build`
- funktionaler Test von Login + Wiki-Seiten
