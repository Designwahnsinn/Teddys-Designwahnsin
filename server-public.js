const path = require("path");
const express = require("express");
const helmet = require("helmet");
const db = require("./db");

const PORT = process.env.PUBLIC_PORT || process.env.PORT || 3000;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "";
const UPLOADS_DIR = path.join(__dirname, "uploads");

const ONE_MINUTE = 60;
const ONE_YEAR = 60 * 60 * 24 * 365;

const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    // Erlaubt fetch()-Anfragen der Anfrage-Funktion vom Browser aus zur
    // separaten Mitarbeiter-Subdomain - ohne das würde Helmets Standard-CSP
    // (connect-src fällt auf default-src 'self' zurück) das blockieren.
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": ["'self'", "https://mitarbeiter.designwahnsinn-teddy.de"],
      },
    },
  })
);

// "Baustellen-Modus": solange SITE_LIVE nicht auf "true" steht, sind nur
// Impressum und Datenschutzerklärung erreichbar (rechtlich nötig, z.B. für
// den Instagram-Bio-Link) - der Rest der Seite (noch in Entwicklung) zeigt
// stattdessen einen Platzhalter. Einfach SITE_LIVE=true in der .env setzen,
// sobald die Seite fertig für den Launch ist.
const SITE_LIVE = process.env.SITE_LIVE === "true";
const ALLOWED_PATHS_WHILE_NOT_LIVE = ["/impressum.html", "/datenschutz.html", "/style.css"];
// Erlaubt Mitarbeitern, die Seite vor dem Launch trotzdem vollständig zu
// testen: Aufruf mit ?preview=<PREVIEW_SECRET> setzt ein Cookie, das die
// Baustellen-Sperre für diesen Browser dauerhaft umgeht (bis das Cookie
// abläuft oder gelöscht wird). Für normale Besucher ändert sich nichts.
const PREVIEW_SECRET = process.env.PREVIEW_SECRET || "";
const PREVIEW_COOKIE = "site_preview";

function hasPreviewCookie(req) {
  if (!PREVIEW_SECRET) return false;
  const header = req.headers.cookie || "";
  return header.split("; ").includes(`${PREVIEW_COOKIE}=${PREVIEW_SECRET}`);
}
// Passendes Motiv für den Platzhalter ("Baustelle"-Design) - Bild kommt live
// aus der Datenbank, damit es sich mitändert, falls das Design mal angepasst wird.
const COMING_SOON_DESIGN_ID = "TD-0001";

function renderComingSoonHtml() {
  const design = db.getDesign(COMING_SOON_DESIGN_ID);
  const imageHtml = design
    ? `<img src="${design.image}" alt="" style="max-width:280px;width:100%;height:auto;margin:0 auto 1.5rem;display:block;">`
    : "";
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Teddys Designwahnsinn – bald verfügbar</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main style="max-width:700px;margin:4rem auto;padding:0 1.5rem;">
    <div style="text-align:center;">
      ${imageHtml}
      <h1>Wir bauen gerade an unserer Seite 🧸🎨</h1>
      <p>Schau bald wieder vorbei!</p>
    </div>

    <section style="display:flex;align-items:center;gap:2rem;flex-wrap:wrap;margin-top:3rem;">
      <div style="flex:1;min-width:240px;font-family:'Brush Script MT','Segoe Script',cursive;font-size:1.3rem;line-height:1.6;">
        <p>Hallo, ich bin Teddy (32), KI-Designer. Mein Name ist Programm: Mich findest du als Maskottchen in jedem meiner Designs wieder.</p>
        <p>Mit meinem Team erstelle ich einzigartige Designs mit Wiedererkennungswert. Wir stehen für Transparenz, Verlässlichkeit und viel Liebe zum Detail – Unikate, von KI inspiriert und von Hand veredelt.</p>
        <p><strong>Was dich erwartet</strong><br>Exklusive KI-Designs: kreativ, inspiriert und mit Liebe zum Detail verfeinert. Und das ist erst der Anfang – begleite mich auf meiner Reise durch die KI-Welt. Ich bin schon fleißig am Werkeln – schau bald wieder vorbei, hier tut sich einiges.</p>
      </div>
      <img src="/images/teddy-mascot.png" alt="Teddy, das Maskottchen" style="width:220px;max-width:40%;height:auto;flex-shrink:0;">
    </section>

    <p style="text-align:center;margin-top:3rem;"><a href="/impressum.html">Impressum</a> · <a href="/datenschutz.html">Datenschutz</a></p>
  </main>
</body>
</html>`;
}

if (!SITE_LIVE) {
  app.use((req, res, next) => {
    if (PREVIEW_SECRET && req.query.preview === PREVIEW_SECRET) {
      res.cookie(PREVIEW_COOKIE, PREVIEW_SECRET, {
        maxAge: 90 * 24 * 60 * 60 * 1000, // 90 Tage
        httpOnly: true,
        sameSite: "lax",
      });
      return next();
    }
    if (
      hasPreviewCookie(req) ||
      ALLOWED_PATHS_WHILE_NOT_LIVE.includes(req.path) ||
      req.path.startsWith("/images/") ||
      req.path.startsWith("/uploads/")
    ) {
      return next();
    }
    res.status(req.path === "/" ? 200 : 404).type("html").send(renderComingSoonHtml());
  });
}

function toPublicDesign(d) {
  // driveLink ist nur für den internen Mitarbeiter-Bereich gedacht
  const { driveLink, ...publicDesign } = d;
  return publicDesign;
}

app.get("/api/designs", (req, res) => {
  // Verkaufte oder offline gestellte Designs erscheinen nicht auf der öffentlichen Seite
  res.set("Cache-Control", `public, max-age=${ONE_MINUTE}`);
  res.json(db.getDesigns().filter((d) => d.status !== "verkauft" && d.online).map(toPublicDesign));
});

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", `public, max-age=${ONE_MINUTE}`);
  res.json({ categories: db.getCategories(), whatsappNumber: WHATSAPP_NUMBER });
});

app.get("/api/designs/:id/images", (req, res) => {
  const design = db.getDesign(req.params.id);
  if (!design || design.status === "verkauft") return res.status(404).json({ error: "Nicht gefunden" });
  res.set("Cache-Control", `public, max-age=${ONE_MINUTE}`);
  // "Ohne Wasserzeichen" ist die tatsächliche Verkaufsdatei, die Kunden nach
  // dem Kauf erhalten - die darf unabhängig vom sichtbar-Flag NIEMALS über
  // die öffentliche Seite einsehbar sein (kein Vertrauen auf die manuelle
  // Checkbox im Mitarbeiterbereich, das ist eine harte Serverregel).
  res.json(
    db
      .getDesignImages(req.params.id)
      .filter((img) => img.sichtbar && img.kategorie !== "Ohne Wasserzeichen")
  );
});

// Bilddateien haben unveränderliche UUID-Dateinamen -> lange, feste Cache-Zeit
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders: (res) => res.set("Cache-Control", `public, max-age=${ONE_YEAR}, immutable`),
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn (öffentliche Seite) läuft auf http://localhost:${PORT}`);
});
