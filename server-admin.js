const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const FileType = require("file-type");
const { imageSize } = require("image-size");
const sharp = require("sharp");
const db = require("./db");
const sortedUploads = require("./sorted-uploads");

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

// Einmalige Migration: bestehende Design-Bilder (von vor Einführung der
// sortierten Ablage) in die Ordnerstruktur uploads-sorted/<Design-ID>/<Kategorie>/
// nachziehen. Ein Design gilt als bereits migriert, sobald sein Ordner existiert.
function backfillSortedUploads() {
  for (const design of db.getDesigns()) {
    const designDir = path.join(sortedUploads.SORTED_DIR, design.id);
    if (fs.existsSync(designDir)) continue;
    for (const img of db.getDesignImages(design.id)) {
      const localPath = path.join(UPLOADS_DIR, path.basename(img.image));
      const ext = img.image.split(".").pop();
      if (fs.existsSync(localPath)) {
        sortedUploads.mirrorSorted(localPath, design.id, img.kategorie, img.bezeichnung, ext);
      }
    }
  }
}
backfillSortedUploads();

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];
const ALLOWED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"];

const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    // Erlaubt die lokale Bild-Vorschau vor dem Hochladen (object URLs haben
    // das Schema "blob:") - Helmets Standard-CSP (img-src 'self' data:) blockiert das sonst.
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": ["'self'", "data:", "blob:"],
      },
    },
  })
);
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

// Etwas großzügiger als inquiryLimiter, da eine Bestellungs-Detailseite beim
// Laden mehrere GET-Aufrufe macht und Kunden die Seite auch mehrfach neu
// laden können, ohne gleich ausgesperrt zu werden.
const orderPortalViewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen. Bitte später erneut versuchen." },
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Platzhalter-Rechtstexte für die Order-Portal-Bestätigungsseite - der Nutzer
// füllt die echten AGB/Widerrufsbelehrung/Nutzungsvereinbarung nach dem
// Testen des Codes ein (siehe TODO-Markierungen). Bewusst als Server-Konstante
// (nicht vom Client übermittelt), damit terms_text_snapshot beim Bestätigen
// garantiert den tatsächlich angezeigten Text enthält, nicht etwas Manipulierbares.
const ORDER_PORTAL_TERMS_TEXT = `
[TODO: AGB einfügen]

[TODO: Widerrufsbelehrung einfügen]

[TODO: Nutzungsvereinbarung für die Designs einfügen - Nutzungsrecht statt
Copyright, Weiterverkaufsverbot, Haftungsausschluss für Druckfehler]
`.trim();

// Dateien landen erst im Speicher, damit die Signatur geprüft werden kann,
// bevor irgendetwas auf Platte geschrieben wird (MIME-Type allein ist spoofbar).
const upload = multer({
  storage: multer.memoryStorage(),
  // 20 MB pro Datei - bei der geforderten Mindestauflösung (~2362x2362px)
  // sind hochauflösende PNGs mit Transparenz schnell deutlich größer als
  // die ursprünglichen 8 MB.
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new Error("Nur PNG, JPG, WEBP oder AVIF erlaubt"), ok);
  },
});

// Empfohlene Mindestauflösung für gestochen scharfen Druck: 20x20cm bei
// 300dpi (Standard-Druckgröße laut Nutzer) = ca. 2362x2362 Pixel.
const MIN_PRINT_DIMENSION_PX = 2362;

function checkImageQuality(buffer) {
  try {
    const { width, height } = imageSize(buffer);
    if (width < MIN_PRINT_DIMENSION_PX || height < MIN_PRINT_DIMENSION_PX) {
      return `Auflösung nur ${width}×${height}px - für gestochen scharfen Druck (20×20cm bei 300dpi) werden mind. ${MIN_PRINT_DIMENSION_PX}×${MIN_PRINT_DIMENSION_PX}px empfohlen.`;
    }
    return null;
  } catch {
    return null; // Auflösung konnte nicht ermittelt werden - Upload trotzdem zulassen
  }
}

// Canva-Exporte kommen oft mit mehreren tausend Pixeln Kantenlänge, weil sie
// auf die Druckauflösung (min. 2362x2362px, siehe MIN_PRINT_DIMENSION_PX)
// ausgelegt sind - für die Website-Anzeige unnötig groß und langsam. Deshalb
// zusätzlich zum unangetasteten Original (Druck-/Verkaufsdatei) ein
// verkleinertes WebP für die öffentliche Seite erzeugen.
const WEB_PREVIEW_MAX_DIMENSION_PX = 1600;
const WEB_PREVIEW_QUALITY = 82;

async function generatePreviewImage(buffer) {
  try {
    const previewFilename = `${crypto.randomUUID()}-preview.webp`;
    await sharp(buffer)
      .resize({
        width: WEB_PREVIEW_MAX_DIMENSION_PX,
        height: WEB_PREVIEW_MAX_DIMENSION_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEB_PREVIEW_QUALITY })
      .toFile(path.join(UPLOADS_DIR, previewFilename));
    return previewFilename;
  } catch {
    return null; // Vorschau ist ein "nice to have" - Original bleibt in jedem Fall nutzbar
  }
}

// Festes Wasserzeichen-Bild (Maskottchen + Schriftzug, transparenter
// Hintergrund) - wird einmal, zentriert, über die Web-Ansicht gelegt. Ein
// einziges Asset für alle Designs, kein manueller Wasserzeichen-Export in
// Canva mehr nötig. Erst als Kachel-Muster über das ganze Bild versucht,
// aber bei detailreichen Designs war das Motiv darunter kaum noch zu
// erkennen - deshalb nur eine Platzierung statt eines Rasters.
const WATERMARK_PATH = path.join(__dirname, "assets", "watermark.png");
const WATERMARK_SIZE_RATIO = 0.5; // Kantenlänge relativ zur kürzeren Bildseite

async function applyWatermark(buffer) {
  // Erst auf Web-Größe verkleinern, dann Wasserzeichen auflegen - die
  // "Mit Wasserzeichen"-Ansicht ist nie die Verkaufsdatei und braucht keine
  // Druckauflösung.
  const resized = await sharp(buffer)
    .resize({
      width: WEB_PREVIEW_MAX_DIMENSION_PX,
      height: WEB_PREVIEW_MAX_DIMENSION_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();
  const { width, height } = await sharp(resized).metadata();
  const markSize = Math.max(1, Math.round(Math.min(width, height) * WATERMARK_SIZE_RATIO));
  const mark = await sharp(WATERMARK_PATH).resize(markSize, markSize, { fit: "inside" }).toBuffer();

  return sharp(resized).composite([{ input: mark, gravity: "center" }]).webp({ quality: WEB_PREVIEW_QUALITY }).toBuffer();
}

// watermark:true erzeugt automatisch die gekachelte "Mit Wasserzeichen"-
// Ansicht statt die Originaldatei unverändert zu speichern.
async function persistUploadedImage(file, { watermark = false } = {}) {
  const detected = await FileType.fromBuffer(file.buffer);
  if (!detected || !ALLOWED_IMAGE_MIME_TYPES.includes(detected.mime)) {
    const err = new Error("Datei-Inhalt entspricht keinem erlaubten Bildformat");
    err.status = 400;
    throw err;
  }
  const qualityWarning = checkImageQuality(file.buffer);
  if (watermark) {
    const watermarkedBuffer = await applyWatermark(file.buffer);
    const filename = `${crypto.randomUUID()}.webp`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), watermarkedBuffer);
    const previewFilename = await generatePreviewImage(watermarkedBuffer);
    return { filename, previewFilename, mime: "image/webp", qualityWarning };
  }
  const filename = `${crypto.randomUUID()}.${detected.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  const previewFilename = await generatePreviewImage(file.buffer);
  return { filename, previewFilename, mime: detected.mime, qualityWarning };
}

// Erzeugt aus einer einzigen hochgeladenen Originaldatei beide Varianten auf
// einmal: die unangetastete Verkaufsdatei ("Ohne Wasserzeichen") und die
// automatisch gekachelte öffentliche Ansicht ("Mit Wasserzeichen") - Ersatz
// für den bisherigen doppelten manuellen Upload.
async function persistUploadedImagePair(file) {
  const clean = await persistUploadedImage(file, { watermark: false });
  const watermarked = await persistUploadedImage(file, { watermark: true });
  return { clean, watermarked, qualityWarning: clean.qualityWarning };
}

// Rechnung/Angebot dürfen zusätzlich zu Bildern auch als PDF hochgeladen
// werden (z.B. direkter Export aus sevdesk) - eigener, größerer erlaubter
// Dateityp-Kreis als bei Design-Bildern.
const ALLOWED_DOCUMENT_MIME_TYPES = ["application/pdf", ...ALLOWED_IMAGE_MIME_TYPES];
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new Error("Nur PDF, PNG, JPG, WEBP oder AVIF erlaubt"), ok);
  },
});

async function persistUploadedDocument(file) {
  const detected = await FileType.fromBuffer(file.buffer);
  if (!detected || !ALLOWED_DOCUMENT_MIME_TYPES.includes(detected.mime)) {
    const err = new Error("Datei-Inhalt entspricht keinem erlaubten Format (PDF oder Bild)");
    err.status = 400;
    throw err;
  }
  const filename = `${crypto.randomUUID()}.${detected.ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  return { filename, mime: detected.mime };
}

// Sicherer Dateiname für Downloads - keine Pfad-/Sonderzeichen aus
// Nutzereingaben (Design-Name, Bezeichnung) landen ungefiltert im Dateinamen.
function safeFileNamePart(text) {
  return text.replace(/[\\/:*?"<>|]/g, "").trim();
}

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/mitarbeiter");
}

// --- Login ---
app.get("/mitarbeiter", (req, res) => {
  if (req.session.loggedIn) return res.redirect("/mitarbeiter/upload");
  let html = fs.readFileSync(path.join(__dirname, "views", "login.html"), "utf8");
  // Solange die Seite nicht live ist, soll die Login-Seite keinen Weg zurück
  // zur öffentlichen Seite anbieten (weder zur echten noch zur Baustellen-Seite).
  if (process.env.SITE_LIVE !== "true") {
    html = html.replace(/<a class="back-link"[^>]*>.*?<\/a>\s*/, "");
  }
  res.type("html").send(html);
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

app.get("/mitarbeiter/designs/bilder", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-design-bilder.html"));
});

app.get("/mitarbeiter/nas", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-nas.html"));
});

app.get("/mitarbeiter/kundenlinks", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "admin-kundenlinks.html"));
});

// Wird von admin-designs.js / admin-neu.js / admin-kategorien.js für die
// Kategorien-Auswahl gebraucht (gleiche Form wie beim öffentlichen /api/config)
app.get("/api/config", requireAuth, (req, res) => {
  const siteLive = process.env.SITE_LIVE === "true";
  const previewSecret = process.env.PREVIEW_SECRET || "";
  res.json({
    categories: db.getCategories(),
    tags: db.getTags(),
    whatsappNumber: WHATSAPP_NUMBER,
    siteLive,
    previewUrl: !siteLive && previewSecret ? `${PUBLIC_ORIGINS[0]}/?preview=${previewSecret}` : null,
    orderTokenValidityDays: db.ORDER_TOKEN_VALIDITY_DAYS,
  });
});

// --- Designs (Admin-API) ---
app.get("/api/admin/designs", requireAuth, (req, res) => {
  res.json(db.getDesigns());
});

// Zeigt auf der "Design hochladen"-Seite an, welche ID als nächstes vergeben wird
app.get("/api/admin/designs/next-id", requireAuth, (req, res) => {
  res.json({ id: db.nextId() });
});

app.post("/api/admin/designs", requireAuth, upload.array("images", 10), async (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink, instagramLink } = req.body;
  const files = req.files || [];
  if (!name || !category || files.length === 0) {
    return res.status(400).json({ error: "Name, Kategorie und mindestens ein Bild sind Pflichtfelder" });
  }
  if (!db.getCategories().includes(category)) {
    return res.status(400).json({ error: "Ungültige Kategorie" });
  }
  if (status && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "Ungültiger Status" });
  }
  // Kommt über ein <form>/FormData (wegen Datei-Upload) als JSON-String statt
  // als natives Mehrfachfeld - siehe buildTagInput() in admin-neu.js.
  let tags = [];
  try {
    tags = JSON.parse(req.body.tags || "[]");
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }

  try {
    const [mainFile, ...extraFiles] = files;
    // Staff lädt nur noch die reine Originaldatei hoch (ohne Wasserzeichen) -
    // die öffentliche "Mit Wasserzeichen"-Ansicht wird automatisch daraus
    // erzeugt (persistUploadedImagePair), kein zweiter manueller Export nötig.
    const mainPair = await persistUploadedImagePair(mainFile);
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
      image: `/uploads/${mainPair.watermarked.filename}`,
      previewImage: mainPair.watermarked.previewFilename ? `/uploads/${mainPair.watermarked.previewFilename}` : null,
      online: req.body.online !== undefined,
      qualityWarning: mainPair.qualityWarning,
      tags,
      createdAt: new Date().toISOString(),
    });
    sortedUploads.mirrorSorted(
      path.join(UPLOADS_DIR, mainPair.watermarked.filename),
      design.id,
      "Mit Wasserzeichen",
      "Hauptbild",
      mainPair.watermarked.filename.split(".").pop()
    );
    db.addDesignImage({
      design_id: design.id,
      wasserzeichen: false,
      typ: "Design",
      bezeichnung: "Hauptbild",
      image: `/uploads/${mainPair.clean.filename}`,
      previewImage: mainPair.clean.previewFilename ? `/uploads/${mainPair.clean.previewFilename}` : null,
      qualityWarning: mainPair.qualityWarning,
    });
    sortedUploads.mirrorSorted(
      path.join(UPLOADS_DIR, mainPair.clean.filename),
      design.id,
      "Ohne Wasserzeichen",
      "Hauptbild",
      mainPair.clean.filename.split(".").pop()
    );

    const qualityWarnings = mainPair.qualityWarning ? [mainPair.qualityWarning] : [];
    for (const [i, file] of extraFiles.entries()) {
      const bezeichnung = `Bild ${i + 2}`;
      const pair = await persistUploadedImagePair(file);
      db.addDesignImage({
        design_id: design.id,
        wasserzeichen: true,
        typ: "Design",
        bezeichnung,
        image: `/uploads/${pair.watermarked.filename}`,
        previewImage: pair.watermarked.previewFilename ? `/uploads/${pair.watermarked.previewFilename}` : null,
        sichtbar: true,
        qualityWarning: pair.qualityWarning,
      });
      sortedUploads.mirrorSorted(
        path.join(UPLOADS_DIR, pair.watermarked.filename),
        design.id,
        "Mit Wasserzeichen",
        bezeichnung,
        pair.watermarked.filename.split(".").pop()
      );
      db.addDesignImage({
        design_id: design.id,
        wasserzeichen: false,
        typ: "Design",
        bezeichnung,
        image: `/uploads/${pair.clean.filename}`,
        previewImage: pair.clean.previewFilename ? `/uploads/${pair.clean.previewFilename}` : null,
        qualityWarning: pair.qualityWarning,
      });
      sortedUploads.mirrorSorted(
        path.join(UPLOADS_DIR, pair.clean.filename),
        design.id,
        "Ohne Wasserzeichen",
        bezeichnung,
        pair.clean.filename.split(".").pop()
      );
      if (pair.qualityWarning) qualityWarnings.push(pair.qualityWarning);
    }

    res.status(201).json({ ...design, qualityWarnings });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.patch("/api/admin/designs/:id", requireAuth, (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink, instagramLink, online, tags } = req.body;

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
  if (online !== undefined) changes.online = Boolean(online) ? 1 : 0;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
      return res.status(400).json({ error: "tags muss ein Array aus Strings sein" });
    }
    changes.tags = tags;
  }

  const updated = db.updateDesign(req.params.id, changes);
  if (!updated) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(updated);
});

app.delete("/api/admin/designs/:id", requireAuth, (req, res) => {
  const removed = db.deleteDesign(req.params.id);
  if (!removed) return res.status(404).json({ error: "Nicht gefunden" });

  for (const img of removed.allImagePaths) {
    fs.unlink(path.join(UPLOADS_DIR, path.basename(img)), () => {});
  }
  sortedUploads.removeSortedDesign(req.params.id);

  res.json({ ok: true });
});

// Ändert die TD-ID selbst (nicht den Namen) - nur für Testzwecke/Korrekturen,
// nicht Teil des normalen Alltagsbetriebs. Zieht Bilder, Bestellzuordnungen
// und die sortierte NAS-Ablage automatisch mit um.
app.post("/api/admin/designs/:id/rename-id", requireAuth, (req, res) => {
  const newId = (req.body.newId || "").trim();
  if (!newId) return res.status(400).json({ error: "Neue ID ist Pflichtfeld" });
  try {
    const updated = db.renameDesignId(req.params.id, newId);
    if (!updated) return res.status(404).json({ error: "Design nicht gefunden" });
    sortedUploads.renameSortedDesign(req.params.id, newId);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Direkter Download einer Bilddatei mit sprechendem Dateinamen - für den
// Bestell-Wizard (Schritt 4: Datei ans E-Mail-/WhatsApp-Programm anhängen).
app.get("/api/admin/designs/:id/images/:imageId/download", requireAuth, (req, res) => {
  const design = db.getDesign(req.params.id);
  if (!design) return res.status(404).json({ error: "Design nicht gefunden" });
  const image = db.getDesignImages(req.params.id).find((img) => String(img.id) === req.params.imageId);
  if (!image) return res.status(404).json({ error: "Bild nicht gefunden" });

  const ext = image.image.split(".").pop();
  const label = [image.kategorie, image.bezeichnung].filter(Boolean).map(safeFileNamePart).join(" - ");
  const downloadName = `${design.id} - ${safeFileNamePart(design.name)}${label ? " - " + label : ""}.${ext}`;
  res.download(path.join(UPLOADS_DIR, path.basename(image.image)), downloadName);
});

// --- Bild-Varianten pro Design ---
app.get("/api/admin/designs/:id/images", requireAuth, (req, res) => {
  if (!db.getDesign(req.params.id)) return res.status(404).json({ error: "Design nicht gefunden" });
  res.json(db.getDesignImages(req.params.id));
});

app.post("/api/admin/designs/:id/images", requireAuth, upload.array("images", 10), async (req, res) => {
  const design = db.getDesign(req.params.id);
  if (!design) return res.status(404).json({ error: "Design nicht gefunden" });

  const { bezeichnung, typ } = req.body;
  if (typ !== undefined && !db.IMAGE_TYP_VALUES.includes(typ)) {
    return res.status(400).json({ error: "Ungültiger Bildtyp" });
  }
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: "Mindestens ein Bild ist Pflichtfeld" });
  }

  try {
    const images = [];
    const qualityWarnings = [];
    for (const [i, file] of files.entries()) {
      // Jede hochgeladene Originaldatei ergibt automatisch beide Varianten
      // (mit + ohne Wasserzeichen) - kein wasserzeichen-Auswahlfeld mehr nötig.
      const pair = await persistUploadedImagePair(file);
      // Bei mehreren Dateien auf einmal braucht jede eine eigene, unterscheidbare
      // Bezeichnung, sonst sehen sie sich in der Übersicht/im Dateinamen zum Verwechseln ähnlich.
      const imageBezeichnung = files.length > 1 ? `${bezeichnung || "Bild"} ${i + 1}` : bezeichnung || "";

      const watermarked = db.addDesignImage({
        design_id: req.params.id,
        wasserzeichen: true,
        typ: typ || "Design",
        bezeichnung: imageBezeichnung,
        image: `/uploads/${pair.watermarked.filename}`,
        previewImage: pair.watermarked.previewFilename ? `/uploads/${pair.watermarked.previewFilename}` : null,
        qualityWarning: pair.qualityWarning,
      });
      sortedUploads.mirrorSorted(
        path.join(UPLOADS_DIR, pair.watermarked.filename),
        design.id,
        watermarked.kategorie,
        imageBezeichnung,
        pair.watermarked.filename.split(".").pop()
      );

      const clean = db.addDesignImage({
        design_id: req.params.id,
        wasserzeichen: false,
        typ: typ || "Design",
        bezeichnung: imageBezeichnung,
        image: `/uploads/${pair.clean.filename}`,
        previewImage: pair.clean.previewFilename ? `/uploads/${pair.clean.previewFilename}` : null,
        qualityWarning: pair.qualityWarning,
      });
      sortedUploads.mirrorSorted(
        path.join(UPLOADS_DIR, pair.clean.filename),
        design.id,
        clean.kategorie,
        imageBezeichnung,
        pair.clean.filename.split(".").pop()
      );

      images.push(watermarked, clean);
      if (pair.qualityWarning) qualityWarnings.push(pair.qualityWarning);
    }
    res.status(201).json({ images, qualityWarnings });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.patch("/api/admin/designs/:id/images/:imageId", requireAuth, (req, res) => {
  const { sichtbar, wasserzeichen, typ } = req.body;
  if (sichtbar === undefined && wasserzeichen === undefined && typ === undefined) {
    return res.status(400).json({ error: "sichtbar, wasserzeichen oder typ ist Pflichtfeld" });
  }

  let updated = null;
  if (sichtbar !== undefined) {
    if (typeof sichtbar !== "boolean") {
      return res.status(400).json({ error: "sichtbar muss ein boolean sein" });
    }
    updated = db.setDesignImageVisibility(req.params.imageId, sichtbar);
    if (!updated) return res.status(404).json({ error: "Bild nicht gefunden" });
  }

  if (wasserzeichen !== undefined || typ !== undefined) {
    if (wasserzeichen !== undefined && typeof wasserzeichen !== "boolean") {
      return res.status(400).json({ error: "wasserzeichen muss ein boolean sein" });
    }
    if (typ !== undefined && !db.IMAGE_TYP_VALUES.includes(typ)) {
      return res.status(400).json({ error: "Ungültiger Bildtyp" });
    }
    const result = db.setDesignImageEigenschaften(req.params.imageId, { wasserzeichen, typ });
    if (!result) return res.status(404).json({ error: "Bild nicht gefunden" });
    const { old: previous, updated: afterUpdate } = result;
    updated = afterUpdate;
    if (previous.kategorie !== afterUpdate.kategorie) {
      const ext = previous.image.split(".").pop();
      sortedUploads.removeSorted(req.params.id, previous.kategorie, previous.bezeichnung, ext);
      sortedUploads.mirrorSorted(
        path.join(UPLOADS_DIR, path.basename(previous.image)),
        req.params.id,
        afterUpdate.kategorie,
        previous.bezeichnung,
        ext
      );
    }
  }

  res.json(updated);
});

// Ersetzt die Datei eines bestehenden Bilds (z.B. falsche Auflösung durch
// korrekten Export ersetzen), ohne Kategorie/Bezeichnung/Sichtbarkeit zu verlieren.
app.post("/api/admin/designs/:id/images/:imageId/replace", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Bild ist Pflichtfeld" });
  try {
    const existing = db.getDesignImages(req.params.id).find((img) => String(img.id) === req.params.imageId);
    if (!existing) return res.status(404).json({ error: "Bild nicht gefunden" });
    // Ersatzdatei ist immer die reine Originaldatei - Wasserzeichen wird nur
    // erneut aufgelegt, wenn die zu ersetzende Zeile ohnehin die
    // "Mit Wasserzeichen"-Ansicht war.
    const { filename, previewFilename, qualityWarning } = await persistUploadedImage(req.file, {
      watermark: Boolean(existing.wasserzeichen),
    });
    const result = db.replaceDesignImage(req.params.imageId, {
      image: `/uploads/${filename}`,
      previewImage: previewFilename ? `/uploads/${previewFilename}` : null,
      qualityWarning,
    });
    if (!result) return res.status(404).json({ error: "Bild nicht gefunden" });

    const { old, updated } = result;
    fs.unlink(path.join(UPLOADS_DIR, path.basename(old.image)), () => {});
    if (old.previewImage) fs.unlink(path.join(UPLOADS_DIR, path.basename(old.previewImage)), () => {});
    sortedUploads.removeSorted(old.design_id, old.kategorie, old.bezeichnung, old.image.split(".").pop());

    const ext = filename.split(".").pop();
    sortedUploads.mirrorSorted(path.join(UPLOADS_DIR, filename), old.design_id, old.kategorie, old.bezeichnung, ext);

    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.post("/api/admin/designs/:id/images/:imageId/hauptbild", requireAuth, (req, res) => {
  try {
    const updated = db.setHauptbild(req.params.id, req.params.imageId);
    if (!updated) return res.status(404).json({ error: "Bild nicht gefunden" });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete("/api/admin/designs/:id/images/:imageId", requireAuth, (req, res) => {
  try {
    const removed = db.deleteDesignImage(req.params.imageId);
    if (!removed) return res.status(404).json({ error: "Bild nicht gefunden" });
    fs.unlink(path.join(UPLOADS_DIR, path.basename(removed.image)), () => {});
    if (removed.previewImage) fs.unlink(path.join(UPLOADS_DIR, path.basename(removed.previewImage)), () => {});
    sortedUploads.removeSorted(removed.design_id, removed.kategorie, removed.bezeichnung, removed.image.split(".").pop());
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
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
  const kunde_instagram = (req.body.kunde_instagram || "").trim();
  const kunde_whatsapp = (req.body.kunde_whatsapp || "").trim();
  const kontakt_praeferenz = (req.body.kontakt_praeferenz || "E-Mail").trim();
  if (!kunde_name || !kunde_email) {
    return res.status(400).json({ error: "Kundenname und E-Mail sind Pflichtfelder" });
  }
  if (!db.KONTAKT_PRAEFERENZ_VALUES.includes(kontakt_praeferenz)) {
    return res.status(400).json({ error: "Ungültige Kontaktpräferenz" });
  }
  res.status(201).json(db.createOrder({ kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz }));
});

// Schritt 2: Designs zuordnen (optional mit varianten: { [designId]: string[] } -
// z.B. von "Bestellung neu/bearbeiten", wenn Mitarbeitende gezielte
// Bild-Varianten für ein Design festhalten wollen, analog zur öffentlichen
// Anfrage-Lightbox)
app.patch("/api/admin/orders/:id/designs", requireAuth, (req, res) => {
  const designIds = Array.isArray(req.body.designIds) ? req.body.designIds : [];
  if (designIds.length === 0) {
    return res.status(400).json({ error: "Mindestens ein Design muss ausgewählt werden" });
  }
  const varianten = req.body.varianten && typeof req.body.varianten === "object" ? req.body.varianten : {};
  const order = db.setOrderDesigns(Number(req.params.id), designIds, varianten);
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
  const { kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, status, notiz } = req.body;
  const changes = {};

  if (kunde_name !== undefined) {
    if (!kunde_name.trim()) return res.status(400).json({ error: "Kundenname darf nicht leer sein" });
    changes.kunde_name = kunde_name.trim();
  }
  if (kunde_email !== undefined) {
    if (!kunde_email.trim()) return res.status(400).json({ error: "E-Mail darf nicht leer sein" });
    changes.kunde_email = kunde_email.trim();
  }
  if (kunde_instagram !== undefined) changes.kunde_instagram = kunde_instagram.trim();
  if (kunde_whatsapp !== undefined) changes.kunde_whatsapp = kunde_whatsapp.trim();
  if (kontakt_praeferenz !== undefined) {
    if (!db.KONTAKT_PRAEFERENZ_VALUES.includes(kontakt_praeferenz)) {
      return res.status(400).json({ error: "Ungültige Kontaktpräferenz" });
    }
    changes.kontakt_praeferenz = kontakt_praeferenz;
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

// Eigener Schalter fürs Order-Portal, bewusst getrennt vom Wizard-Schritt
// "Download" (der bezieht sich auf den Mitarbeiter-eigenen Download, nicht
// darauf ob der Kunde selbst schon herunterladen darf).
app.post("/api/admin/orders/:id/freigabe", requireAuth, (req, res) => {
  if (typeof req.body.freigegeben !== "boolean") {
    return res.status(400).json({ error: "freigegeben (boolean) ist Pflichtfeld" });
  }
  const updated = db.setDownloadFreigabe(Number(req.params.id), req.body.freigegeben);
  if (!updated) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  res.json(updated);
});

// Fallback für Bestellungen, die nicht über den Portal-Link bestätigt wurden
// (z.B. telefonisch oder per Instagram-DM zugesagt) - setzt denselben
// terms_confirmed_at-Status wie eine echte Portal-Bestätigung, damit der
// "Kunde hat bestätigt"-Schritt im Wizard genauso weiterläuft.
app.post("/api/admin/orders/:id/confirm-manually", requireAuth, (req, res) => {
  const order = db.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  if (order.designs.length === 0) {
    return res.status(400).json({ error: "Es müssen zuerst Designs zugeordnet werden" });
  }
  const updated = db.confirmOrderTerms(order.id, "manuell (Mitarbeiter)", ORDER_PORTAL_TERMS_TEXT);
  res.json(updated);
});

// Neuer Bestätigungslink - z.B. nach Ablauf der 90 Tage oder falls der alte
// Link versehentlich woanders gelandet ist. Macht eine vorherige Bestätigung ungültig.
app.post("/api/admin/orders/:id/regenerate-token", requireAuth, (req, res) => {
  const updated = db.regenerateOrderToken(Number(req.params.id));
  if (!updated) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  res.json(updated);
});

// Rechnung/Angebot hochladen (bzw. ersetzen - alte Datei wird dabei entfernt).
// Beide Routen sind bewusst identisch aufgebaut, nur das Zielfeld unterscheidet sich.
async function handleOrderFileUpload(req, res, field) {
  try {
    if (!req.file) return res.status(400).json({ error: "Keine Datei hochgeladen" });
    const order = db.getOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });

    const { filename } = await persistUploadedDocument(req.file);
    if (order[field]) {
      fs.unlink(path.join(UPLOADS_DIR, path.basename(order[field])), () => {});
    }
    const updated = db.setOrderFile(order.id, field, filename);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

app.post("/api/admin/orders/:id/rechnung", requireAuth, uploadDocument.single("datei"), (req, res) =>
  handleOrderFileUpload(req, res, "rechnung_datei")
);

app.post("/api/admin/orders/:id/angebot", requireAuth, uploadDocument.single("datei"), (req, res) =>
  handleOrderFileUpload(req, res, "angebot_datei")
);

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
  const kunde_instagram = (req.body.kunde_instagram || "").trim();
  const kunde_whatsapp = (req.body.kunde_whatsapp || "").trim();
  const kontakt_praeferenz = (req.body.kontakt_praeferenz || "E-Mail").trim();
  const message = (req.body.message || "").trim();
  const designIds = Array.isArray(req.body.designIds) ? req.body.designIds : [];
  const varianten = req.body.varianten && typeof req.body.varianten === "object" ? req.body.varianten : {};

  if (!kunde_name) return res.status(400).json({ error: "Name ist ein Pflichtfeld" });
  if (!EMAIL_PATTERN.test(kunde_email)) return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse angeben" });
  if (!db.KONTAKT_PRAEFERENZ_VALUES.includes(kontakt_praeferenz)) {
    return res.status(400).json({ error: "Ungültige Kontaktpräferenz" });
  }
  if (kontakt_praeferenz === "WhatsApp" && !kunde_whatsapp) {
    return res.status(400).json({ error: "Bitte eine WhatsApp-Nummer angeben, wenn WhatsApp bevorzugt wird" });
  }
  if (designIds.length === 0) return res.status(400).json({ error: "Bitte mindestens ein Design auswählen" });

  const knownIds = new Set(db.getDesigns().map((d) => d.id));
  const validIds = designIds.filter((id) => knownIds.has(id));
  if (validIds.length === 0) return res.status(400).json({ error: "Keine gültigen Designs ausgewählt" });

  // Kundinnen können pro Design gezielt einzelne Varianten (z.B. nur Motiv 2 +
  // Hintergrund statt "das ganze Design") auswählen - kein eigener Preis-
  // /Paket-Katalog, die Auswahl landet einfach als Klartext in der Notiz,
  // die die Kollegin beim manuellen Angebot-Erstellen sowieso liest.
  const variantenText = validIds
    .filter((id) => Array.isArray(varianten[id]) && varianten[id].length > 0)
    .map((id) => `${id}: ${varianten[id].filter((v) => typeof v === "string").join(", ")}`)
    .join("\n");
  const notiz = [message || "(keine Nachricht)", variantenText ? `[Gewünschte Varianten]\n${variantenText}` : null]
    .filter(Boolean)
    .join("\n\n");

  const order = db.createOrder({ kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz });
  db.updateOrder(order.id, { notiz: `[Website-Anfrage] ${notiz}` });
  const updated = db.setOrderDesigns(order.id, validIds);

  res.status(201).json({ ok: true, id: updated.id });
});

// --- Order-Portal: Kunden-Bestätigungsseite (Token statt Login) ---

function isOrderTokenExpired(order) {
  const ageMs = Date.now() - new Date(order.token_created_at).getTime();
  return ageMs > db.ORDER_TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
}

// Zeigt Kunden nie ein "Ohne Wasserzeichen"-Bild als Vorschau - das ist die
// Verkaufsdatei, die es erst nach Freigabe über die Download-Route gibt.
function pickPreviewImage(designId) {
  const images = db.getDesignImages(designId);
  const hauptbild = images.find((img) => img.ist_hauptbild && img.wasserzeichen);
  if (hauptbild) return hauptbild.previewImage || hauptbild.image;
  const anyWatermarked = images.find((img) => img.wasserzeichen);
  return anyWatermarked ? anyWatermarked.previewImage || anyWatermarked.image : null;
}

app.options("/api/public/order/:token", publicCors);
app.get("/api/public/order/:token", publicCors, orderPortalViewLimiter, (req, res) => {
  const order = db.getOrderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  if (isOrderTokenExpired(order)) {
    return res.status(410).json({ error: "Dieser Link ist abgelaufen. Bitte melde dich bei uns für einen neuen Link.", expired: true });
  }

  const designs = order.designs.map((d) => ({
    id: d.id,
    name: d.name,
    price: d.price,
    previewImage: pickPreviewImage(d.id),
    deliverables: order.download_freigegeben
      ? db.getDesignImages(d.id).filter((img) => !img.wasserzeichen).map((img) => ({ id: img.id, bezeichnung: img.bezeichnung }))
      : [],
  }));

  // Angebot muss die Kundin schon VOR der Bestätigung sehen können - genau
  // das soll sie ja gerade entscheiden lassen, ob sie bestätigt. Die Rechnung
  // gehört dagegen inhaltlich zu den Design-Dateien (sie bekommt beides
  // zusammen zum Abschluss) und ist daher an denselben download_freigegeben-
  // Schalter gekoppelt wie die Verkaufsdateien, nicht an die Bestätigung.
  res.json({
    kunde_name: order.kunde_name,
    designs,
    total: designs.reduce((sum, d) => sum + (d.price || 0), 0),
    confirmed: !!order.terms_confirmed_at,
    confirmedAt: order.terms_confirmed_at,
    downloadFreigegeben: !!order.download_freigegeben,
    status: order.status,
    termsText: ORDER_PORTAL_TERMS_TEXT,
    angebotDatei: order.angebot_datei || null,
    rechnungDatei: order.download_freigegeben ? order.rechnung_datei || null : null,
  });
});

app.options("/api/public/order/:token/confirm", publicCors);
app.post("/api/public/order/:token/confirm", publicCors, inquiryLimiter, (req, res) => {
  const order = db.getOrderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  if (isOrderTokenExpired(order)) {
    return res.status(410).json({ error: "Dieser Link ist abgelaufen. Bitte melde dich bei uns für einen neuen Link.", expired: true });
  }
  if (order.designs.length === 0) {
    return res.status(400).json({ error: "Bestellung enthält noch keine Designs" });
  }
  if (req.body.confirmed !== true) {
    return res.status(400).json({ error: "Bitte die Bestätigung ankreuzen" });
  }

  const updated = db.confirmOrderTerms(order.id, req.ip, ORDER_PORTAL_TERMS_TEXT);
  res.json({ ok: true, confirmedAt: updated.terms_confirmed_at });
});

app.get("/api/public/order/:token/download/:imageId", publicCors, orderPortalViewLimiter, (req, res) => {
  const order = db.getOrderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: "Bestellung nicht gefunden" });
  if (isOrderTokenExpired(order)) {
    return res.status(410).json({ error: "Dieser Link ist abgelaufen." });
  }
  if (!order.download_freigegeben) {
    return res.status(403).json({ error: "Noch nicht zum Download freigegeben." });
  }

  const image = order.designs
    .flatMap((d) => db.getDesignImages(d.id))
    .find((img) => String(img.id) === req.params.imageId && !img.wasserzeichen);
  if (!image) return res.status(404).json({ error: "Datei nicht gefunden." });

  const target = path.join(UPLOADS_DIR, path.basename(image.image));
  if (!fs.existsSync(target)) return res.status(404).json({ error: "Datei nicht gefunden." });
  res.download(target);
});

// --- NAS-Ordner-Browser (read-only Ansicht von uploads-sorted/, der Quelle
// für den Synology-Cloud-Sync nach Google Drive) ---
const NAS_ROOT = sortedUploads.SORTED_DIR;

// Löst einen vom Client übergebenen relativen Pfad sicher innerhalb von
// NAS_ROOT auf - verhindert Path-Traversal (z.B. "../../etc") nach außerhalb.
function resolveNasPath(relativePath) {
  const target = path.resolve(NAS_ROOT, `.${path.sep}${relativePath || ""}`);
  if (target !== NAS_ROOT && !target.startsWith(NAS_ROOT + path.sep)) {
    const err = new Error("Ungültiger Pfad");
    err.status = 400;
    throw err;
  }
  return target;
}

const NAS_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".avif"];

// Sucht rekursiv (max. 3 Ebenen) nach einem repräsentativen Bild für einen
// Ordner, bevorzugt das Hauptbild unter "Mit Wasserzeichen" - damit man in
// der Ordnerübersicht auf einen Blick erkennt, was ein Design-Ordner enthält.
function findNasPreviewImage(absoluteDirPath) {
  const candidates = [];
  function scan(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        scan(full, depth + 1);
      } else if (NAS_IMAGE_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext))) {
        candidates.push(full);
      }
    }
  }
  scan(absoluteDirPath, 0);
  const hauptbild = candidates.find((c) => /Mit Wasserzeichen[\\/]/.test(c) && /hauptbild/i.test(path.basename(c)));
  const chosen = hauptbild || candidates[0];
  return chosen ? path.relative(NAS_ROOT, chosen).split(path.sep).join("/") : null;
}

app.get("/api/admin/nas-browse", requireAuth, (req, res) => {
  try {
    const dir = resolveNasPath(req.query.path || "");
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(404).json({ error: "Ordner nicht gefunden" });
    }
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        previewImage: e.isDirectory() ? findNasPreviewImage(path.join(dir, e.name)) : null,
      }))
      .sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, "de")));
    res.json({ path: req.query.path || "", entries });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.get("/api/admin/nas-browse/download", requireAuth, (req, res) => {
  try {
    const target = resolveNasPath(req.query.path || "");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).json({ error: "Datei nicht gefunden" });
    }
    res.download(target);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Wie /download, aber ohne Content-Disposition: attachment - dient als
// <img src> für die Miniaturvorschau im NAS-Ordner-Browser, statt jedes Bild
// gleich herunterzuladen.
app.get("/api/admin/nas-browse/view", requireAuth, (req, res) => {
  try {
    const target = resolveNasPath(req.query.path || "");
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return res.status(404).send();
    }
    res.sendFile(target);
  } catch (err) {
    res.status(err.status || 400).send();
  }
});

// --- Feedback-Notizen (Dashboard) ---
app.get("/api/admin/feedback", requireAuth, (req, res) => {
  res.json(db.listFeedback());
});

app.post("/api/admin/feedback", requireAuth, (req, res) => {
  const text = (req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Text ist Pflichtfeld" });
  res.status(201).json(db.addFeedback(text));
});

app.patch("/api/admin/feedback/:id", requireAuth, (req, res) => {
  const { status } = req.body;
  if (status !== "offen" && status !== "erledigt") {
    return res.status(400).json({ error: "status muss 'offen' oder 'erledigt' sein" });
  }
  const updated = db.setFeedbackStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(updated);
});

app.delete("/api/admin/feedback/:id", requireAuth, (req, res) => {
  const ok = db.deleteFeedback(req.params.id);
  if (!ok) return res.status(404).json({ error: "Nicht gefunden" });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn (Mitarbeiterbereich) läuft auf http://localhost:${PORT}`);
});
