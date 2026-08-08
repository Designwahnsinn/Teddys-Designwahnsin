const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const FileType = require("file-type");
const db = require("./db");

const PORT = process.env.ADMIN_PORT || 3001;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "";

// Keine unsicheren Defaults: ohne diese Secrets startet der Prozess nicht.
// (server.js hatte hier früher "teddy2026" / "change-me-in-production" als
// Fallback fest im - öffentlich einsehbaren - Code stehen.)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error(
    "ADMIN_PASSWORD und SESSION_SECRET müssen als Umgebungsvariablen gesetzt sein (siehe .env.example). Abbruch."
  );
  process.exit(1);
}

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];
const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"];

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

// Nicht von Suchmaschinen indexieren
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /"));

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Login-Versuche. Bitte in 15 Minuten erneut versuchen." },
});

// Von der öffentlichen Website aus (andere Origin) erreichbar: Kunden-Anfragen
// aus dem "Anfrage"-Formular. Bewusst kein CSRF-Schutz nötig, da unauthenticated
// und ohne Session-Wirkung - dafür streng rate-limitiert.
const PUBLIC_ORIGINS = ["https://designwahnsinn-teddy.de", "https://www.designwahnsinn-teddy.de"];

function publicCors(req, res, next) {
  const origin = req.headers.origin;
  if (PUBLIC_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
  }
  // Helmet setzt standardmäßig "Cross-Origin-Resource-Policy: same-origin" auf
  // alle Antworten - das würde die Antwort dieses absichtlich cross-origin
  // aufgerufenen Endpunkts im Browser blockieren. Für diese Route lockern.
  res.header("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

const inquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen. Bitte später erneut versuchen." },
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dateien landen erst im Speicher, damit die Signatur geprüft werden kann,
// bevor irgendetwas auf Platte geschrieben wird (MIME-Type allein ist spoofbar).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new Error("Nur PNG, JPG, WEBP oder AVIF erlaubt"), ok);
  },
});

async function persistUploadedImage(file) {
  const detected = await FileType.fromBuffer(file.buffer);
  if (!detected || !ALLOWED_IMAGE_MIME_TYPES.includes(detected.mime)) {
    const err = new Error("Datei-Inhalt entspricht keinem erlaubten Bildformat");
    err.status = 400;
    throw err;
  }
  const filename = `${crypto.randomUUID()}.${detected.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  return filename;
}

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/mitarbeiter");
}

// --- Login ---
app.get("/mitarbeiter", (req, res) => {
  if (req.session.loggedIn) return res.redirect("/mitarbeiter/upload");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/mitarbeiter/login", loginLimiter, (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/mitarbeiter/upload");
  }
  res.redirect("/mitarbeiter?error=1");
});

app.post("/mitarbeiter/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/mitarbeiter"));
});

// --- Protected admin area (Seiten) ---
app.get("/mitarbeiter/upload", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});

app.get("/mitarbeiter/neu", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-neu.html"));
});

app.get("/mitarbeiter/designs", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-designs.html"));
});

app.get("/mitarbeiter/kategorien", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-kategorien.html"));
});

app.get("/mitarbeiter/bestellungen", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-bestellungen.html"));
});

app.get("/mitarbeiter/bestellungen/neu", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-bestellung-neu.html"));
});

app.get("/mitarbeiter/bestellungen/bearbeiten", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-bestellung-bearbeiten.html"));
});

// Wird von admin-designs.js / admin-neu.js / admin-kategorien.js für die
// Kategorien-Auswahl gebraucht (gleiche Form wie beim öffentlichen /api/config)
app.get("/api/config", requireAuth, (req, res) => {
  res.json({ categories: db.getCategories(), whatsappNumber: WHATSAPP_NUMBER });
});

// --- Designs (Admin-API) ---
app.get("/api/admin/designs", requireAuth, (req, res) => {
  res.json(db.getDesigns());
});

app.post("/api/admin/designs", requireAuth, upload.single("image"), async (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink, instagramLink } = req.body;
  if (!name || !category || !req.file) {
    return res.status(400).json({ error: "Name, Kategorie und Bild sind Pflichtfelder" });
  }
  if (!db.getCategories().includes(category)) {
    return res.status(400).json({ error: "Ungültige Kategorie" });
  }
  if (status && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "Ungültiger Status" });
  }

  try {
    const filename = await persistUploadedImage(req.file);
    const design = db.addDesign({
      id: db.nextId(),
      name,
      description: description || "",
      category,
      price: price ? Number(price) : null,
      status: status || "verfügbar",
      kaufLink: kaufLink || "",
      driveLink: driveLink || "",
      instagramLink: instagramLink || "",
      image: `/uploads/${filename}`,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(design);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.patch("/api/admin/designs/:id", requireAuth, (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink, instagramLink } = req.body;

  const changes = {};
  if (name !== undefined) {
    if (!name) return res.status(400).json({ error: "Name darf nicht leer sein" });
    changes.name = name;
  }
  if (description !== undefined) changes.description = description;
  if (category !== undefined) {
    if (!db.getCategories().includes(category)) {
      return res.status(400).json({ error: "Ungültige Kategorie" });
    }
    changes.category = category;
  }
  if (price !== undefined) changes.price = price === "" || price === null ? null : Number(price);
  if (status !== undefined) {
    if (!STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: "Ungültiger Status" });
    }
    changes.status = status;
  }
  if (kaufLink !== undefined) changes.kaufLink = kaufLink;
  if (driveLink !== undefined) changes.driveLink = driveLink;
  if (instagramLink !== undefined) changes.instagramLink = instagramLink;

  const updated = db.updateDesign(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(updated);
});

app.delete("/api/admin/designs/:id", requireAuth, (req, res) => {
  const removed = db.deleteDesign(req.params.id);
  if (!removed) return res.status(404).json({ error: "Nicht gefunden" });

  const filePath = path.join(UPLOADS_DIR, path.basename(removed.image));
  fs.unlink(filePath, () => {});

  res.json({ ok: true });
});

// --- Kategorien-Verwaltung ---
app.post("/api/admin/categories", requireAuth, (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name darf nicht leer sein" });
  if (db.getCategories().includes(name)) {
    return res.status(400).json({ error: "Kategorie existiert bereits" });
  }
  res.status(201).json(db.addCategory(name));
});

app.patch("/api/admin/categories", requireAuth, (req, res) => {
  const oldName = (req.body.oldName || "").trim();
  const newName = (req.body.newName || "").trim();
  if (!oldName || !newName) {
    return res.status(400).json({ error: "Alter und neuer Name sind Pflichtfelder" });
  }
  if (oldName === newName) return res.json(db.getCategories());
  if (db.getCategories().includes(newName)) {
    return res.status(400).json({ error: "Eine Kategorie mit diesem Namen existiert bereits" });
  }
  const result = db.renameCategory(oldName, newName);
  if (!result) return res.status(404).json({ error: "Kategorie nicht gefunden" });
  res.json(result);
});

app.delete("/api/admin/categories/:name", requireAuth, (req, res) => {
  const name = req.params.name;
  const inUse = db.getDesigns().some((d) => d.category === name);
  if (inUse) {
    return res.status(400).json({
      error: "Kategorie wird noch von Designs verwendet – erst Designs umkategorisieren",
    });
  }
  const result = db.deleteCategory(name);
  if (!result) return res.status(404).json({ error: "Kategorie nicht gefunden" });
  res.json(result);
});

// --- Bestellungen (Wizard + Dashboard) ---
app.get("/api/admin/orders", requireAuth, (req, res) => {
  res.json(db.listOrders(req.query.status));
});

app.get("/api/admin/orders/:id", requireAuth, (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(order);
});

// Schritt 1: Bestellung anlegen
app.post("/api/admin/orders", requireAuth, (req, res) => {
  const kunde_name = (req.body.kunde_name || "").trim();
  const kunde_email = (req.body.kunde_email || "").trim();
  if (!kunde_name || !kunde_email) {
    return res.status(400).json({ error: "Kundenname und E-Mail sind Pflichtfelder" });
  }
  res.status(201).json(db.createOrder({ kunde_name, kunde_email }));
});

// Schritt 2: Designs zuordnen
app.patch("/api/admin/orders/:id/designs", requireAuth, (req, res) => {
  const designIds = Array.isArray(req.body.designIds) ? req.body.designIds : [];
  if (designIds.length === 0) {
    return res.status(400).json({ error: "Mindestens ein Design muss ausgewählt werden" });
  }
  const order = db.setOrderDesigns(Number(req.params.id), designIds);
  if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  res.json(order);
});

// Schritte 3-7: einzelnen Wizard-Schritt abhaken (Reihenfolge wird serverseitig erzwungen)
app.patch("/api/admin/orders/:id/step/:stepName", requireAuth, (req, res) => {
  try {
    const order = db.advanceOrderStep(Number(req.params.id), req.params.stepName);
    if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Schritt 8: Bestellung abschließen, Verkaufszähler erhöhen
app.post("/api/admin/orders/:id/complete", requireAuth, (req, res) => {
  try {
    const order = db.completeOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Freie Bearbeitung einer bestehenden Bestellung: Kunde, Status und Schritte
// unabhängig von der Wizard-Reihenfolge änderbar, auch bei "Erledigt".
app.patch("/api/admin/orders/:id", requireAuth, (req, res) => {
  const { kunde_name, kunde_email, status, notiz } = req.body;
  const changes = {};

  if (kunde_name !== undefined) {
    if (!kunde_name.trim()) return res.status(400).json({ error: "Kundenname darf nicht leer sein" });
    changes.kunde_name = kunde_name.trim();
  }
  if (kunde_email !== undefined) {
    if (!kunde_email.trim()) return res.status(400).json({ error: "E-Mail darf nicht leer sein" });
    changes.kunde_email = kunde_email.trim();
  }
  if (status !== undefined) {
    if (!db.ORDER_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: "Ungültiger Status" });
    }
    changes.status = status;
  }
  if (notiz !== undefined) changes.notiz = notiz;
  for (const step of db.ORDER_STEPS) {
    if (req.body[step] !== undefined) changes[step] = Boolean(req.body[step]);
  }

  const updated = db.updateOrder(Number(req.params.id), changes);
  if (!updated) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  res.json(updated);
});

app.delete("/api/admin/orders/:id", requireAuth, (req, res) => {
  const removed = db.deleteOrder(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  res.json({ ok: true });
});

// --- Öffentliche Anfragen von der Website (kein Login) ---
app.options("/api/public/inquiries", publicCors);
app.post("/api/public/inquiries", publicCors, inquiryLimiter, (req, res) => {
  const kunde_name = (req.body.kunde_name || "").trim();
  const kunde_email = (req.body.kunde_email || "").trim();
  const message = (req.body.message || "").trim();
  const designIds = Array.isArray(req.body.designIds) ? req.body.designIds : [];

  if (!kunde_name) return res.status(400).json({ error: "Name ist ein Pflichtfeld" });
  if (!EMAIL_PATTERN.test(kunde_email)) return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse angeben" });
  if (designIds.length === 0) return res.status(400).json({ error: "Bitte mindestens ein Design auswählen" });

  const knownIds = new Set(db.getDesigns().map((d) => d.id));
  const validIds = designIds.filter((id) => knownIds.has(id));
  if (validIds.length === 0) return res.status(400).json({ error: "Keine gültigen Designs ausgewählt" });

  const order = db.createOrder({ kunde_name, kunde_email });
  db.updateOrder(order.id, { notiz: `[Website-Anfrage] ${message || "(keine Nachricht)"}` });
  const updated = db.setOrderDesigns(order.id, validIds);

  res.status(201).json({ ok: true, id: updated.id });
});

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn (Mitarbeiterbereich) läuft auf http://localhost:${PORT}`);
});
