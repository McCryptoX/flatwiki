import type { FastifyInstance } from "fastify";
import { renderLayout } from "../lib/render.js";

export const registerPublicRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get("/privacy", async (request, reply) => {
    const body = `
      <section class="content-wrap legal">
        <h1>Datenschutzhinweise</h1>
        <p>Diese Anwendung ist als datensparsame Flat-File-Wiki-Lösung konzipiert.</p>

        <h2>Verarbeitete Daten</h2>
        <ul>
          <li>Kontostammdaten: Benutzername, Anzeigename, Rolle</li>
          <li>Sicherheitsdaten: Passwort-Hash, Session-Metadaten, Audit-Logs</li>
          <li>Inhaltsdaten: Markdown-Seiten und Änderungszeitpunkte</li>
        </ul>

        <h2>Rechtsgrundlagen und Zweck</h2>
        <ul>
          <li>Bereitstellung des Wiki-Dienstes</li>
          <li>Schutz der Integrität und Sicherheit der Plattform</li>
          <li>Nachvollziehbarkeit administrativer Änderungen</li>
        </ul>

        <h2>Technisch-organisatorische Maßnahmen</h2>
        <ul>
          <li>Passwortspeicherung nur als Hash (scrypt)</li>
          <li>CSRF-Schutz für alle schreibenden Aktionen</li>
          <li>Rate-Limiting und Sicherheits-Header</li>
          <li>Session-Timeout und manuelles Logout</li>
        </ul>

        <h2>Betroffenenrechte</h2>
        <p>Benutzer können ihre gespeicherten Kontodaten über den Bereich <strong>Mein Konto</strong> exportieren.</p>
        <p>Die Löschung/Anpassung von Konten kann über die Administrationsoberfläche erfolgen.</p>

        <p class="legal-note">Hinweis: Diese Seite ist eine technische Vorlage und ersetzt keine juristische Beratung.</p>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Datenschutz",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken
      })
    );
  });

  app.get("/impressum", async (request, reply) => {
    const body = `
      <section class="content-wrap legal">
        <h1>Impressum</h1>
        <p>Bitte ergänze hier die rechtlich erforderlichen Angaben für deinen Betriebskontext.</p>
        <p>Pfad: <code>/src/routes/publicRoutes.ts</code></p>
      </section>
    `;

    return reply.type("text/html").send(
      renderLayout({
        title: "Impressum",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken
      })
    );
  });

  app.setNotFoundHandler(async (request, reply) => {
    const body = `
      <section class="content-wrap">
        <h1>404</h1>
        <p>Die angeforderte Seite wurde nicht gefunden.</p>
        <a class="button" href="/">Zur Startseite</a>
      </section>
    `;

    return reply.code(404).type("text/html").send(
      renderLayout({
        title: "404",
        body,
        user: request.currentUser,
        csrfToken: request.csrfToken,
        error: "Nicht gefunden"
      })
    );
  });
};
