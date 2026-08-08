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

function toPublicDesign(d) {
  // driveLink ist nur für den internen Mitarbeiter-Bereich gedacht
  const { driveLink, ...publicDesign } = d;
  return publicDesign;
}

app.get("/api/designs", (req, res) => {
  // Verkaufte Designs erscheinen nicht auf der öffentlichen Seite
  res.set("Cache-Control", `public, max-age=${ONE_MINUTE}`);
  res.json(db.getDesigns().filter((d) => d.status !== "verkauft").map(toPublicDesign));
});

app.get("/api/config", (req, res) => {
  res.set("Cache-Control", `public, max-age=${ONE_MINUTE}`);
  res.json({ categories: db.getCategories(), whatsappNumber: WHATSAPP_NUMBER });
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
