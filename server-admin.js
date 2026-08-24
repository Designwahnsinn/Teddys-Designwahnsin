const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const FileType = require("file-type");
const { imageSizeFromFile } = require("image-size/fromFile");
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

// Verkaufsdateien (Original ohne Wasserzeichen + deren Web-Vorschau) landen
// NICHT in uploads/ - dieser Ordner wird von beiden Servern per
// express.static ohne Anmeldung ausgeliefert (siehe server-public.js). Ein
// erratener/weitergegebener UUID-Dateiname wäre sonst der gesamte Schutz -
// hier liegen sie stattdessen in einem Ordner, der nur über eine
// authentifizierte Route (/sales/:filename unten, bzw. das Order-Portal mit
// gültigem Bestell-Token) erreichbar ist.
const SALES_DIR = path.join(__dirname, "data", "sales");
if (!fs.existsSync(SALES_DIR)) fs.mkdirSync(SALES_DIR, { recursive: true });

// Zwischenspeicher für multer.diskStorage() - bewusst NICHT unter uploads/,
// aus demselben Grund wie SALES_DIR. Dateien landen hier nur für die Dauer
// der Verarbeitung eines Requests und werden danach in jedem Fall gelöscht
// (siehe cleanupTempFiles), auch bei Fehlern.
const TMP_DIR = path.join(__dirname, "data", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Für ein Bild in design_images.image/previewImage gespeicherte Pfade wie
// "/uploads/<name>" oder "/sales/<name>" auf den tatsächlichen Ordner auf der
// Platte auflösen - zentral an einer Stelle, damit Download/Lösch-Routen nicht
// von Hand zwischen beiden Ordnern unterscheiden müssen.
function resolveStoredFilePath(imagePathValue) {
  const name = path.basename(imagePathValue);
  return imagePathValue.startsWith("/sales/") ? path.join(SALES_DIR, name) : path.join(UPLOADS_DIR, name);
}

// Einmalige Migration: bestehende Design-Bilder (von vor Einführung der
// sortierten Ablage) in die Ordnerstruktur uploads-sorted/<Design-ID>/<Kategorie>/
// nachziehen. Ein Design gilt als bereits migriert, sobald sein Ordner existiert.
async function backfillSortedUploads() {
  for (const design of db.getDesigns()) {
    const designDir = path.join(sortedUploads.SORTED_DIR, design.id);
    if (fs.existsSync(designDir)) continue;
    for (const img of db.getDesignImages(design.id)) {
      const localPath = resolveStoredFilePath(img.image);
      const ext = img.image.split(".").pop();
      if (fs.existsSync(localPath)) {
        await sortedUploads.mirrorSorted(localPath, design.id, img.kategorie, img.bezeichnung, ext);
      }
    }
  }
}
// Einmalige Migration beim Start - läuft im Hintergrund, muss den Serverstart
// nicht blockieren (mirrorSorted fängt eigene Fehler bereits intern ab).
backfillSortedUploads().catch((err) => console.error("Migration der sortierten Ablage fehlgeschlagen:", err));

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

// Verkaufsdateien (siehe SALES_DIR) sind bewusst NICHT über express.static
// erreichbar - nur einzeln über diese Route, die eine gültige Admin-Session
// verlangt. Dient in der Bilder-Verwaltung als <img src> für die Vorschau der
// Verkaufsdatei-Zeile. Kunden bekommen Verkaufsdateien ausschließlich über die
// separate, Token-geprüfte Order-Portal-Download-Route (siehe weiter unten).
app.get("/sales/:filename", requireAuth, (req, res) => {
  const target = path.join(SALES_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(target)) return res.status(404).end();
  res.sendFile(target);
});

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

// Dateien landen zuerst einzeln auf der Platte (TMP_DIR) statt gesammelt im
// Arbeitsspeicher - bei bis zu 30 Dateien à 20 MB Canva-Exporten in
// Druckauflösung konnte memoryStorage den Prozess auf dem Server abschießen.
// Die Signaturprüfung (FileType.fromFile, siehe unten) passiert weiterhin vor
// jeder Weiterverarbeitung, MIME-Type allein bleibt spoofbar.
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  // 20 MB pro Datei - bei der geforderten Mindestauflösung (~2362x2362px)
  // sind hochauflösende PNGs mit Transparenz schnell deutlich größer als
  // die ursprünglichen 8 MB.
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype);
    cb(ok ? null : new Error("Nur PNG, JPG, WEBP oder AVIF erlaubt"), ok);
  },
});

// Löscht die temporären Originaldateien eines Requests zuverlässig, auch
// wenn die Verarbeitung fehlgeschlagen ist - sonst würde data/tmp mit der
// Zeit volllaufen. Einzeln statt sammelnd, damit ein fehlendes File (schon
// verschoben/gelöscht) den Rest nicht verhindert.
async function cleanupTempFiles(files) {
  await Promise.all((files || []).map((f) => fs.promises.unlink(f.path).catch(() => {})));
}

// Empfohlene Mindestauflösung für gestochen scharfen Druck: 20x20cm bei
// 300dpi (Standard-Druckgröße laut Nutzer) = ca. 2362x2362 Pixel.
const MIN_PRINT_DIMENSION_PX = 2362;

function checkImageQuality(width, height) {
  if (width < MIN_PRINT_DIMENSION_PX || height < MIN_PRINT_DIMENSION_PX) {
    return `Auflösung nur ${width}×${height}px - für gestochen scharfen Druck (20×20cm bei 300dpi) werden mind. ${MIN_PRINT_DIMENSION_PX}×${MIN_PRINT_DIMENSION_PX}px empfohlen.`;
  }
  return null;
}

// Canva-Exporte kommen oft mit mehreren tausend Pixeln Kantenlänge, weil sie
// auf die Druckauflösung (min. 2362x2362px, siehe MIN_PRINT_DIMENSION_PX)
// ausgelegt sind - für die Website-Anzeige unnötig groß und langsam. Deshalb
// zusätzlich zum unangetasteten Original (Druck-/Verkaufsdatei) ein
// verkleinertes WebP für die Web-Ansichten.
const WEB_PREVIEW_MAX_DIMENSION_PX = 1600;
const WEB_PREVIEW_QUALITY = 82;

// Ein Bild kann bei kleiner Dateigröße riesige Pixelmaße haben - beim
// Dekodieren entstünde daraus ohne Grenze ein sehr großer Speicherbedarf.
// Deutlich über der höchsten in Canva real vorkommenden Exportgröße
// (2362x2362px Pflicht-Mindestmaß, meist nicht extrem viel größer), mit
// Reserve nach oben. Bilder, die daran scheitern, laufen in den regulären
// Teilfehler-Pfad (siehe persistUploadedImagePair), nicht in einen Absturz.
const SHARP_MAX_INPUT_PIXELS = 120_000_000; // ca. 11000×11000px

// Anzahl gleichzeitig verarbeiteter Dateien pro Upload-Request - alle 10
// Varianten parallel würde den Speichergewinn von diskStorage wieder
// zunichtemachen, streng nacheinander liefe unnötig lange. sharp.concurrency
// passend begrenzen, sonst startet sharp intern zusätzliche Threads.
const UPLOAD_CONCURRENCY = 2;
sharp.concurrency(UPLOAD_CONCURRENCY);

// Verarbeitet eine Liste von Elementen mit fester, begrenzter Parallelität
// und sammelt die Ergebnisse INDIZIERT ein (nicht in Abschlussreihenfolge) -
// wichtig, weil sortOrder und Bezeichnungen von der Upload-Reihenfolge abhängen.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Festes Wasserzeichen-Bild (Maskottchen + Schriftzug, transparenter
// Hintergrund) - wird einmal, zentriert, über die Web-Ansicht gelegt. Ein
// einziges Asset für alle Designs, kein manueller Wasserzeichen-Export in
// Canva mehr nötig. Erst als Kachel-Muster über das ganze Bild versucht,
// aber bei detailreichen Designs war das Motiv darunter kaum noch zu
// erkennen - deshalb nur eine Platzierung statt eines Rasters.
const WATERMARK_PATH = path.join(__dirname, "assets", "watermark.png");
const WATERMARK_SIZE_RATIO = 0.5; // Kantenlänge relativ zur kürzeren Bildseite

// Legt Wasserzeichen auf eine bereits auf Web-Größe verkleinerte Version -
// die "Mit Wasserzeichen"-Ansicht ist nie die Verkaufsdatei und braucht keine
// Druckauflösung, das Verkleinern passiert deshalb vorher genau einmal beim
// Aufrufer (siehe persistUploadedImagePair), nicht hier erneut.
async function applyWatermarkToResizedBuffer(resizedBuffer) {
  const { width, height } = await sharp(resizedBuffer).metadata();
  const markSize = Math.max(1, Math.round(Math.min(width, height) * WATERMARK_SIZE_RATIO));
  const mark = await sharp(WATERMARK_PATH).resize(markSize, markSize, { fit: "inside" }).toBuffer();
  return sharp(resizedBuffer).composite([{ input: mark, gravity: "center" }]).webp({ quality: WEB_PREVIEW_QUALITY }).toBuffer();
}

// "sales" (geschützt, siehe SALES_DIR) oder "uploads" (öffentlich) -> den in
// design_images.image/previewImage gespeicherten Pfad-String bauen bzw. auf
// den tatsächlichen Ordner auf der Platte auflösen.
function storedPath(dir, filename) {
  return dir === "sales" ? `/sales/${filename}` : `/uploads/${filename}`;
}
function dirFor(dir) {
  return dir === "sales" ? SALES_DIR : UPLOADS_DIR;
}

// Für Antworten/Logs: nie den vollen, potenziell sehr langen Original-
// Dateinamen einer Nutzereingabe ungekürzt weiterreichen.
function truncateFileName(name) {
  return String(name || "").slice(0, 200);
}

// Testkonzept-Auswertung: vom Client mitgeschickte Upload-Dauer (Zeit vom
// ersten Datei-Auswählen bis zum Absenden) auf einen plausiblen Wert
// begrenzen. Ohne Obergrenze würde z.B. eine über Nacht offen gelassene
// Auswahl die Auswertung massiv verzerren - 2 Stunden sind für einen
// einzelnen Upload-Vorgang immer noch großzügig.
const MAX_PLAUSIBLE_UPLOAD_DURATION_MS = 2 * 60 * 60 * 1000;
function clampUploadDurationMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_PLAUSIBLE_UPLOAD_DURATION_MS);
}

// 6.3: Fehlermeldungen an den Client dürfen nur bekannte, selbst formulierte
// Texte enthalten - keine Dateipfade, Sharp-/Systemfehler oder Stacktraces.
// Eigene Fehler (err.status gesetzt, siehe persistUploadedImage*) sind dafür
// vorgesehen und dürfen durch; alles andere wird nur serverseitig geloggt.
function describeUploadError(err, context) {
  if (err && err.status) return err.message;
  console.error(`Unerwarteter Fehler bei der Bildverarbeitung${context ? ` (${context})` : ""}:`, err);
  return "Die Datei konnte nicht verarbeitet werden.";
}

// Einzelnes Ersatzbild (Route .../replace) - anders als beim Erst-Upload gibt
// es hier nur eine Zielvariante (die zu ersetzende Zeile war entweder schon
// die Wasserzeichen- oder die Verkaufsdatei-Zeile), der Aufwand einer
// gemeinsamen Verkleinerung für zwei Varianten lohnt hier nicht.
async function persistUploadedImage(file, { watermark = false } = {}) {
  const detected = await FileType.fromFile(file.path);
  if (!detected || !ALLOWED_IMAGE_MIME_TYPES.includes(detected.mime)) {
    const err = new Error("Datei-Inhalt entspricht keinem erlaubten Bildformat");
    err.status = 400;
    throw err;
  }
  const { width, height } = await imageSizeFromFile(file.path);
  const qualityWarning = checkImageQuality(width, height);

  if (watermark) {
    const resizedBuffer = await sharp(file.path, { limitInputPixels: SHARP_MAX_INPUT_PIXELS })
      .resize({ width: WEB_PREVIEW_MAX_DIMENSION_PX, height: WEB_PREVIEW_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    const filename = `${crypto.randomUUID()}.webp`;
    await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), await applyWatermarkToResizedBuffer(resizedBuffer));
    return { filename, dir: "uploads", previewFilename: null, previewDir: null, mime: "image/webp", qualityWarning };
  }

  const filename = `${crypto.randomUUID()}.${detected.ext}`;
  await fs.promises.copyFile(file.path, path.join(SALES_DIR, filename));
  const previewFilename = `${crypto.randomUUID()}-preview.webp`;
  const previewBuffer = await sharp(file.path, { limitInputPixels: SHARP_MAX_INPUT_PIXELS })
    .resize({ width: WEB_PREVIEW_MAX_DIMENSION_PX, height: WEB_PREVIEW_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEB_PREVIEW_QUALITY })
    .toBuffer();
  await fs.promises.writeFile(path.join(SALES_DIR, previewFilename), previewBuffer);
  return { filename, dir: "sales", previewFilename, previewDir: "sales", mime: detected.mime, qualityWarning };
}

// Erzeugt aus einer einzigen hochgeladenen Originaldatei beide Varianten auf
// einmal: die unangetastete Verkaufsdatei ("Ohne Wasserzeichen", landet
// geschützt in SALES_DIR - siehe 6.1) und die automatisch gekachelte
// öffentliche Ansicht ("Mit Wasserzeichen", landet in UPLOADS_DIR) - Ersatz
// für den bisherigen doppelten manuellen Upload. Format/Auflösung werden nur
// einmal geprüft und nur einmal auf Web-Größe verkleinert (nicht wie früher
// pro Ansicht erneut), aus dem Ergebnis werden beide Web-Ansichten kodiert.
async function persistUploadedImagePair(file) {
  const detected = await FileType.fromFile(file.path);
  if (!detected || !ALLOWED_IMAGE_MIME_TYPES.includes(detected.mime)) {
    const err = new Error("Datei-Inhalt entspricht keinem erlaubten Bildformat");
    err.status = 400;
    throw err;
  }
  const { width, height } = await imageSizeFromFile(file.path);
  const qualityWarning = checkImageQuality(width, height);

  const cleanFilename = `${crypto.randomUUID()}.${detected.ext}`;
  await fs.promises.copyFile(file.path, path.join(SALES_DIR, cleanFilename));

  const resizedBuffer = await sharp(file.path, { limitInputPixels: SHARP_MAX_INPUT_PIXELS })
    .resize({ width: WEB_PREVIEW_MAX_DIMENSION_PX, height: WEB_PREVIEW_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
    .toBuffer();

  // Web-Vorschau des Originals (ohne Wasserzeichen!) - nur fürs schnelle
  // Laden in der Bilder-Verwaltung gedacht, deshalb ebenfalls im geschützten
  // sales-Ordner, nie in uploads/ (sonst wäre 6.1 wirkungslos).
  const cleanPreviewFilename = `${crypto.randomUUID()}-preview.webp`;
  await fs.promises.writeFile(
    path.join(SALES_DIR, cleanPreviewFilename),
    await sharp(resizedBuffer).webp({ quality: WEB_PREVIEW_QUALITY }).toBuffer()
  );

  // Kein separates Preview für die Wasserzeichen-Variante - image hat schon Webgröße.
  const watermarkedFilename = `${crypto.randomUUID()}.webp`;
  await fs.promises.writeFile(
    path.join(UPLOADS_DIR, watermarkedFilename),
    await applyWatermarkToResizedBuffer(resizedBuffer)
  );

  return {
    clean: { filename: cleanFilename, dir: "sales", previewFilename: cleanPreviewFilename, previewDir: "sales", mime: detected.mime, qualityWarning },
    watermarked: { filename: watermarkedFilename, dir: "uploads", previewFilename: null, previewDir: null, mime: "image/webp", qualityWarning },
    qualityWarning,
  };
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

// 6.5: === verrät über die Antwortzeit (Abbruch beim ersten falschen Zeichen),
// wie viele Anfangszeichen bereits stimmen. Beide Werte erst auf eine feste
// Länge hashen (crypto.timingSafeEqual verlangt gleich lange Buffer und würde
// bei unterschiedlicher Passwortlänge sonst selbst wieder werfen/verraten).
function timingSafePasswordEqual(candidate, expected) {
  const candidateHash = crypto.createHash("sha256").update(String(candidate ?? "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

app.post("/mitarbeiter/login", loginLimiter, (req, res) => {
  if (timingSafePasswordEqual(req.body.password, ADMIN_PASSWORD)) {
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
    feedbackArtValues: db.FEEDBACK_ART_VALUES,
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

app.post("/api/admin/designs", requireAuth, upload.array("images", 30), async (req, res) => {
  // Testkonzept-Auswertung: Startzeitpunkt für die serverseitige
  // Verarbeitungsdauer, uploadDurationMs kommt vom Client (Zeit vom ersten
  // Datei-Auswählen bis zum Absenden, siehe admin-neu.js).
  const requestStart = Date.now();
  const uploadDurationMs = clampUploadDurationMs(req.body.uploadDurationMs);
  const { name, description, category, price, pricePng, priceHintergrund, status, kaufLink, driveLink, instagramLink } = req.body;
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
    // Das Hauptbild entscheidet über Erfolg/Misserfolg des gesamten Requests
    // (ohne gültiges Hauptbild kein Design) - weitere Dateien unten laufen
    // dagegen als Teilfehler, ein einzelnes schlechtes Bild soll die anderen
    // neun nicht verhindern.
    const mainPair = await persistUploadedImagePair(mainFile);
    const design = db.addDesign({
      id: db.nextId(),
      name,
      description: description || "",
      category,
      price: price ? Number(price) : null,
      pricePng: pricePng ? Number(pricePng) : null,
      priceHintergrund: priceHintergrund ? Number(priceHintergrund) : null,
      status: status || "verfügbar",
      kaufLink: kaufLink || "",
      driveLink: driveLink || "",
      instagramLink: instagramLink || "",
      image: storedPath(mainPair.watermarked.dir, mainPair.watermarked.filename),
      previewImage: mainPair.watermarked.previewFilename ? storedPath(mainPair.watermarked.previewDir, mainPair.watermarked.previewFilename) : null,
      online: req.body.online !== undefined,
      qualityWarning: mainPair.qualityWarning,
      tags,
      createdAt: new Date().toISOString(),
    });
    await sortedUploads.mirrorSorted(
      path.join(dirFor(mainPair.watermarked.dir), mainPair.watermarked.filename),
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
      image: storedPath(mainPair.clean.dir, mainPair.clean.filename),
      previewImage: mainPair.clean.previewFilename ? storedPath(mainPair.clean.previewDir, mainPair.clean.previewFilename) : null,
      qualityWarning: mainPair.qualityWarning,
    });
    await sortedUploads.mirrorSorted(
      path.join(dirFor(mainPair.clean.dir), mainPair.clean.filename),
      design.id,
      "Ohne Wasserzeichen",
      "Hauptbild",
      mainPair.clean.filename.split(".").pop()
    );

    const qualityWarnings = mainPair.qualityWarning ? [mainPair.qualityWarning] : [];
    const fehlgeschlagen = [];
    // Wie bei der Bild-Upload-Route: erst alle Extra-Dateien parallel
    // verarbeiten und indiziert einsammeln, dann strikt sequentiell in
    // Upload-Reihenfolge in die Datenbank schreiben - sonst überholt ein
    // schnell verarbeitetes kleines Bild ein noch laufendes großes und
    // sortOrder/"Bild N"-Nummerierung stimmen nicht mehr mit der
    // tatsächlichen Auswahlreihenfolge überein.
    const extraResults = await mapWithConcurrency(extraFiles, UPLOAD_CONCURRENCY, async (file) => {
      try {
        const pair = await persistUploadedImagePair(file);
        return { ok: true, pair };
      } catch (err) {
        return { ok: false, dateiname: truncateFileName(file.originalname), grund: describeUploadError(err, "Design anlegen") };
      }
    });
    for (const [i, result] of extraResults.entries()) {
      if (!result.ok) {
        fehlgeschlagen.push({ dateiname: result.dateiname, grund: result.grund });
        continue;
      }
      const { pair } = result;
      const bezeichnung = `Bild ${i + 2}`;
      db.addDesignImage({
        design_id: design.id,
        wasserzeichen: true,
        typ: "Design",
        bezeichnung,
        image: storedPath(pair.watermarked.dir, pair.watermarked.filename),
        previewImage: pair.watermarked.previewFilename ? storedPath(pair.watermarked.previewDir, pair.watermarked.previewFilename) : null,
        sichtbar: true,
        qualityWarning: pair.qualityWarning,
      });
      await sortedUploads.mirrorSorted(
        path.join(dirFor(pair.watermarked.dir), pair.watermarked.filename),
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
        image: storedPath(pair.clean.dir, pair.clean.filename),
        previewImage: pair.clean.previewFilename ? storedPath(pair.clean.previewDir, pair.clean.previewFilename) : null,
        qualityWarning: pair.qualityWarning,
      });
      await sortedUploads.mirrorSorted(
        path.join(dirFor(pair.clean.dir), pair.clean.filename),
        design.id,
        "Ohne Wasserzeichen",
        bezeichnung,
        pair.clean.filename.split(".").pop()
      );
      if (pair.qualityWarning) qualityWarnings.push(pair.qualityWarning);
    }

    db.addUploadTiming(design.id, { uploadDurationMs, serverProcessingMs: Date.now() - requestStart });
    res.status(201).json({ ...design, qualityWarnings, fehlgeschlagen });
  } catch (err) {
    res.status(err.status || 400).json({ error: describeUploadError(err, "Hauptbild") });
  } finally {
    await cleanupTempFiles(files);
  }
});

app.patch("/api/admin/designs/:id", requireAuth, (req, res) => {
  const { name, description, category, price, pricePng, priceHintergrund, status, kaufLink, driveLink, instagramLink, online, tags } = req.body;

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
  if (pricePng !== undefined) changes.pricePng = pricePng === "" || pricePng === null ? null : Number(pricePng);
  if (priceHintergrund !== undefined) changes.priceHintergrund = priceHintergrund === "" || priceHintergrund === null ? null : Number(priceHintergrund);
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

app.delete("/api/admin/designs/:id", requireAuth, async (req, res) => {
  const removed = db.deleteDesign(req.params.id);
  if (!removed) return res.status(404).json({ error: "Nicht gefunden" });

  for (const img of removed.allImagePaths) {
    fs.unlink(resolveStoredFilePath(img), () => {});
  }
  await sortedUploads.removeSortedDesign(req.params.id);

  res.json({ ok: true });
});

// Ändert die TD-ID selbst (nicht den Namen) - nur für Testzwecke/Korrekturen,
// nicht Teil des normalen Alltagsbetriebs. Zieht Bilder, Bestellzuordnungen
// und die sortierte NAS-Ablage automatisch mit um.
app.post("/api/admin/designs/:id/rename-id", requireAuth, async (req, res) => {
  const newId = (req.body.newId || "").trim();
  if (!newId) return res.status(400).json({ error: "Neue ID ist Pflichtfeld" });
  try {
    const updated = db.renameDesignId(req.params.id, newId);
    if (!updated) return res.status(404).json({ error: "Design nicht gefunden" });
    await sortedUploads.renameSortedDesign(req.params.id, newId);
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
  res.download(resolveStoredFilePath(image.image), downloadName);
});

// --- Bild-Varianten pro Design ---
app.get("/api/admin/designs/:id/images", requireAuth, (req, res) => {
  if (!db.getDesign(req.params.id)) return res.status(404).json({ error: "Design nicht gefunden" });
  res.json(db.getDesignImages(req.params.id));
});

app.post("/api/admin/designs/:id/images", requireAuth, upload.array("images", 30), async (req, res) => {
  // Testkonzept-Auswertung: siehe POST /api/admin/designs - hier zählt die
  // Dauer als weiterer Upload-Vorgang zum selben Design dazu (addUploadTiming
  // addiert statt zu überschreiben), falls z.B. später noch Motive/Hintergründe ergänzt werden.
  const requestStart = Date.now();
  const uploadDurationMs = clampUploadDurationMs(req.body.uploadDurationMs);
  const design = db.getDesign(req.params.id);
  if (!design) return res.status(404).json({ error: "Design nicht gefunden" });

  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: "Mindestens ein Bild ist Pflichtfeld" });
  }

  // typ/bezeichnung kommen entweder einmalig (gilt für alle Dateien wie
  // bisher) oder - für einen kompletten Canva-Export mit gemischten Typen in
  // einem Vorgang (Schritt 5) - als Array parallel zu den Dateien. Mehrfach
  // gleichnamige FormData-Felder liefert multer/busboy bereits als Array.
  const typInput = Array.isArray(req.body.typ) ? req.body.typ : req.body.typ !== undefined ? [req.body.typ] : [];
  const bezeichnungInput = Array.isArray(req.body.bezeichnung)
    ? req.body.bezeichnung
    : req.body.bezeichnung !== undefined
    ? [req.body.bezeichnung]
    : [];

  // Fehlt ein Eintrag oder ist er ungültig, gilt der erste Wert der Liste
  // (IMAGE_TYP_VALUES[0]) - kein Ablehnen des gesamten Batches wegen einer
  // einzelnen falschen Auswahl.
  function resolveTyp(i) {
    const raw = typInput.length === files.length ? typInput[i] : typInput[0];
    return raw && db.IMAGE_TYP_VALUES.includes(raw) ? raw : db.IMAGE_TYP_VALUES[0];
  }

  // Automatische Nummerierung ("Bild 1", "Bild 2") nur, wenn für mehrere
  // Dateien dieselbe Bezeichnung angegeben wurde (Normalfall: ein
  // gemeinsamer Vorgabewert für alle Zeilen). Bei individuell abweichenden
  // Bezeichnungen pro Zeile bleibt der eingegebene Text unverändert.
  function resolveBezeichnung(i) {
    const perFile = bezeichnungInput.length === files.length && files.length > 0 ? bezeichnungInput : null;
    if (perFile) {
      const allSame = perFile.every((v) => (v || "").trim() === (perFile[0] || "").trim());
      if (!allSame) return (perFile[i] || "").trim();
    }
    const base = (bezeichnungInput[0] || "").trim();
    return files.length > 1 ? `${base || "Bild"} ${i + 1}` : base;
  }

  try {
    // Feste, begrenzte Nebenläufigkeit statt streng nacheinander (Schritt 3),
    // aber NUR für die eigentliche Bildverarbeitung (persistUploadedImagePair).
    // mapWithConcurrency liefert seine Rückgabewerte zwar schon indiziert,
    // Datenbank-Schreibvorgänge als Seiteneffekt INNERHALB der Worker liefen
    // bisher trotzdem in Abschlussreihenfolge - ein kleines, schnell
    // verarbeitetes Bild konnte so ein noch laufendes großes überholen und
    // sortOrder verfälschen. Deshalb: erst alle Dateien parallel verarbeiten
    // und das Ergebnis pro Index einsammeln, danach in einem zweiten,
    // strikt sequentiellen Durchlauf in Upload-Reihenfolge in die Datenbank schreiben.
    const results = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file, i) => {
      const typ = resolveTyp(i);
      const imageBezeichnung = resolveBezeichnung(i);
      try {
        // Jede hochgeladene Originaldatei ergibt automatisch beide Varianten
        // (mit + ohne Wasserzeichen) - kein wasserzeichen-Auswahlfeld mehr nötig.
        const pair = await persistUploadedImagePair(file);
        return { ok: true, pair, typ, imageBezeichnung };
      } catch (err) {
        return { ok: false, dateiname: truncateFileName(file.originalname), grund: describeUploadError(err, "Bild-Upload") };
      }
    });

    const images = [];
    const qualityWarnings = [];
    const fehlgeschlagen = [];
    for (const result of results) {
      if (!result.ok) {
        fehlgeschlagen.push({ dateiname: result.dateiname, grund: result.grund });
        continue;
      }
      const { pair, typ, imageBezeichnung } = result;

      const watermarked = db.addDesignImage({
        design_id: req.params.id,
        wasserzeichen: true,
        typ,
        bezeichnung: imageBezeichnung,
        image: storedPath(pair.watermarked.dir, pair.watermarked.filename),
        previewImage: pair.watermarked.previewFilename ? storedPath(pair.watermarked.previewDir, pair.watermarked.previewFilename) : null,
        qualityWarning: pair.qualityWarning,
      });
      await sortedUploads.mirrorSorted(
        path.join(dirFor(pair.watermarked.dir), pair.watermarked.filename),
        design.id,
        watermarked.kategorie,
        imageBezeichnung,
        pair.watermarked.filename.split(".").pop()
      );

      const clean = db.addDesignImage({
        design_id: req.params.id,
        wasserzeichen: false,
        typ,
        bezeichnung: imageBezeichnung,
        image: storedPath(pair.clean.dir, pair.clean.filename),
        previewImage: pair.clean.previewFilename ? storedPath(pair.clean.previewDir, pair.clean.previewFilename) : null,
        qualityWarning: pair.qualityWarning,
      });
      await sortedUploads.mirrorSorted(
        path.join(dirFor(pair.clean.dir), pair.clean.filename),
        design.id,
        clean.kategorie,
        imageBezeichnung,
        pair.clean.filename.split(".").pop()
      );

      images.push(watermarked, clean);
      if (pair.qualityWarning) qualityWarnings.push(pair.qualityWarning);
    }

    // Zeit zählt auch bei einem gescheiterten Versuch dazu - die Mitarbeiterin
    // hat sie so oder so investiert.
    db.addUploadTiming(design.id, { uploadDurationMs, serverProcessingMs: Date.now() - requestStart });

    if (images.length === 0) {
      return res.status(400).json({ error: "Keine der Dateien konnte verarbeitet werden.", images, qualityWarnings, fehlgeschlagen });
    }
    res.status(201).json({ images, qualityWarnings, fehlgeschlagen });
  } catch (err) {
    res.status(err.status || 400).json({ error: describeUploadError(err, "Bild-Upload") });
  } finally {
    await cleanupTempFiles(files);
  }
});

app.patch("/api/admin/designs/:id/images/:imageId", requireAuth, async (req, res) => {
  const { sichtbar, wasserzeichen, typ, bezeichnung } = req.body;
  if (sichtbar === undefined && wasserzeichen === undefined && typ === undefined && bezeichnung === undefined) {
    return res.status(400).json({ error: "sichtbar, wasserzeichen, typ oder bezeichnung ist Pflichtfeld" });
  }

  let updated = null;
  if (sichtbar !== undefined) {
    if (typeof sichtbar !== "boolean") {
      return res.status(400).json({ error: "sichtbar muss ein boolean sein" });
    }
    updated = db.setDesignImageVisibility(req.params.imageId, sichtbar);
    if (!updated) return res.status(404).json({ error: "Bild nicht gefunden" });
  }

  if (wasserzeichen !== undefined || typ !== undefined || bezeichnung !== undefined) {
    if (wasserzeichen !== undefined && typeof wasserzeichen !== "boolean") {
      return res.status(400).json({ error: "wasserzeichen muss ein boolean sein" });
    }
    if (typ !== undefined && !db.IMAGE_TYP_VALUES.includes(typ)) {
      return res.status(400).json({ error: "Ungültiger Bildtyp" });
    }
    if (bezeichnung !== undefined && typeof bezeichnung !== "string") {
      return res.status(400).json({ error: "bezeichnung muss Text sein" });
    }
    const result = db.setDesignImageEigenschaften(req.params.imageId, {
      wasserzeichen,
      typ,
      bezeichnung: bezeichnung !== undefined ? bezeichnung.trim() : undefined,
    });
    if (!result) return res.status(404).json({ error: "Bild nicht gefunden" });
    const { old: previous, updated: afterUpdate } = result;
    updated = afterUpdate;
    // Sortierte Ablage (uploads-sorted/, Quelle für den Google-Drive-Sync) nutzt
    // Kategorie und Bezeichnung im Dateipfad - bei Änderung an einer der beiden
    // alte Datei entfernen und unter dem neuen Namen/Ordner neu ablegen.
    if (previous.kategorie !== afterUpdate.kategorie || previous.bezeichnung !== afterUpdate.bezeichnung) {
      const ext = previous.image.split(".").pop();
      await sortedUploads.removeSorted(req.params.id, previous.kategorie, previous.bezeichnung, ext);
      await sortedUploads.mirrorSorted(
        resolveStoredFilePath(previous.image),
        req.params.id,
        afterUpdate.kategorie,
        afterUpdate.bezeichnung,
        ext
      );
    }
  }

  res.json(updated);
});

// Manuelle Umsortierung der Bild-Varianten (wirkt sich sowohl auf die
// Reihenfolge in dieser Verwaltung als auch auf die öffentliche Galerie aus,
// siehe getDesignImages() in db.js).
app.post("/api/admin/designs/:id/images/:imageId/move", requireAuth, (req, res) => {
  const { direction } = req.body;
  if (direction !== "up" && direction !== "down") {
    return res.status(400).json({ error: "direction muss 'up' oder 'down' sein" });
  }
  const images = db.moveDesignImage(req.params.imageId, direction);
  if (!images) return res.status(404).json({ error: "Bild nicht gefunden" });
  res.json(images);
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
    const persisted = await persistUploadedImage(req.file, { watermark: Boolean(existing.wasserzeichen) });
    const result = db.replaceDesignImage(req.params.imageId, {
      image: storedPath(persisted.dir, persisted.filename),
      previewImage: persisted.previewFilename ? storedPath(persisted.previewDir, persisted.previewFilename) : null,
      qualityWarning: persisted.qualityWarning,
    });
    if (!result) return res.status(404).json({ error: "Bild nicht gefunden" });

    const { old, updated } = result;
    fs.unlink(resolveStoredFilePath(old.image), () => {});
    if (old.previewImage) fs.unlink(resolveStoredFilePath(old.previewImage), () => {});
    await sortedUploads.removeSorted(old.design_id, old.kategorie, old.bezeichnung, old.image.split(".").pop());

    const ext = persisted.filename.split(".").pop();
    await sortedUploads.mirrorSorted(
      path.join(dirFor(persisted.dir), persisted.filename),
      old.design_id,
      old.kategorie,
      old.bezeichnung,
      ext
    );

    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: describeUploadError(err, "Bild ersetzen") });
  } finally {
    if (req.file) await cleanupTempFiles([req.file]);
  }
});

app.post("/api/admin/designs/:id/images/:imageId/hauptbild", requireAuth, (req, res) => {
  try {
    // Die Verkaufsdatei (wasserzeichen: false) darf nie zu designs.image
    // werden - das würde sie über die öffentliche Design-Liste/den
    // "Baustellen"-Platzhalter ausliefern und damit 6.1 unterlaufen. Keine
    // Serverregel darf sich hier auf die deaktivierte Checkbox im Frontend
    // verlassen (siehe auch die harte wasserzeichen-Prüfung in server-public.js).
    const candidate = db.getDesignImages(req.params.id).find((img) => String(img.id) === req.params.imageId);
    if (!candidate) return res.status(404).json({ error: "Bild nicht gefunden" });
    if (!candidate.wasserzeichen) {
      return res.status(400).json({ error: "Die Verkaufsdatei (ohne Wasserzeichen) kann nicht als Hauptbild festgelegt werden." });
    }
    const updated = db.setHauptbild(req.params.id, req.params.imageId);
    if (!updated) return res.status(404).json({ error: "Bild nicht gefunden" });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete("/api/admin/designs/:id/images/:imageId", requireAuth, async (req, res) => {
  try {
    const removed = db.deleteDesignImage(req.params.imageId);
    if (!removed) return res.status(404).json({ error: "Bild nicht gefunden" });
    fs.unlink(resolveStoredFilePath(removed.image), () => {});
    if (removed.previewImage) fs.unlink(resolveStoredFilePath(removed.previewImage), () => {});
    await sortedUploads.removeSorted(removed.design_id, removed.kategorie, removed.bezeichnung, removed.image.split(".").pop());
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

// --- Tags (frei, kein "in Benutzung"-Schutz wie bei Kategorien - ein Design
// verliert beim Löschen eines Tags einfach nur dieses eine Tag) ---
app.post("/api/admin/tags", requireAuth, (req, res) => {
  const name = db.normalizeTagName(req.body.name || "");
  if (!name) return res.status(400).json({ error: "Name darf nicht leer sein" });
  if (db.getTags().includes(name)) {
    return res.status(400).json({ error: "Tag existiert bereits" });
  }
  res.status(201).json(db.addTag(name));
});

app.patch("/api/admin/tags", requireAuth, (req, res) => {
  const oldName = (req.body.oldName || "").trim();
  const newName = db.normalizeTagName(req.body.newName || "");
  if (!oldName || !newName) {
    return res.status(400).json({ error: "Alter und neuer Name sind Pflichtfelder" });
  }
  if (oldName === newName) return res.json(db.getTags());
  if (db.getTags().includes(newName)) {
    return res.status(400).json({ error: "Ein Tag mit diesem Namen existiert bereits" });
  }
  const result = db.renameTag(oldName, newName);
  if (!result) return res.status(404).json({ error: "Tag nicht gefunden" });
  res.json(result);
});

app.delete("/api/admin/tags/:name", requireAuth, (req, res) => {
  const result = db.deleteTag(req.params.name);
  if (!result) return res.status(404).json({ error: "Tag nicht gefunden" });
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

// Welche Preisbausteine (design/png/hintergrund) für ein Design in dieser
// Bestellung im Angebot addiert werden - siehe Schritt "Angebot/Rechnung erstellen".
app.patch("/api/admin/orders/:id/designs/:designId/preisoptionen", requireAuth, (req, res) => {
  const { preisoptionen } = req.body;
  if (!Array.isArray(preisoptionen) || !preisoptionen.every((p) => db.PREISOPTIONEN_VALUES.includes(p))) {
    return res.status(400).json({ error: `preisoptionen muss ein Array aus ${db.PREISOPTIONEN_VALUES.join("/")} sein` });
  }
  const ok = db.setOrderDesignPreisoptionen(Number(req.params.id), req.params.designId, preisoptionen);
  if (!ok) return res.status(404).json({ error: "Bestellung oder Design nicht gefunden" });
  const order = db.getOrder(Number(req.params.id));
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

// Identisch zu variantLabel() in public/admin-bestellung-neu.js - nur damit
// lassen sich die dort in order_designs.varianten gespeicherten Label-Strings
// ("10. Hintergrund-Variante – Bild 10") wieder einem Bild zuordnen.
function variantLabel(img, index) {
  const typ = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
  const base = img.bezeichnung ? `${typ} – ${img.bezeichnung}` : typ;
  return `${index}. ${base}`;
}

// Verkaufsdateien (Ohne Wasserzeichen) eines Designs, eingeschränkt auf die im
// Bestell-Wizard ausgewählte(n) Variante(n) - eine Kundin, die z.B. nur die
// Hintergrund-Variante bestellt hat, soll nicht plötzlich alle Motive der
// Design-Vorlage zum Download bekommen. Wurde (noch) keine Variante
// ausgewählt (leeres varianten-Array, z.B. bei simplen Alt-Bestellungen ohne
// mehrere Varianten), bleibt es beim bisherigen Verhalten: alles freigeben.
// Verkaufs- und Wasserzeichen-Bilder werden paarweise beim Upload angelegt
// (siehe persistUploadedImagePair) und behalten dieselbe relative Reihenfolge,
// daher ergibt der Index in beiden Listen dasselbe Label.
function deliverableImagesForDesign(design) {
  const images = db.getDesignImages(design.id);
  const watermarked = images.filter((img) => img.wasserzeichen);
  const clean = images.filter((img) => !img.wasserzeichen);
  if (!design.varianten || design.varianten.length === 0) return clean;
  const labels = watermarked.map((img, i) => variantLabel(img, i + 1));
  return clean.filter((_, i) => design.varianten.includes(labels[i]));
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
    price: d.berechneterPreis,
    previewImage: pickPreviewImage(d.id),
    deliverables: order.download_freigegeben
      ? deliverableImagesForDesign(d).map((img) => ({ id: img.id, bezeichnung: img.bezeichnung }))
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
    .flatMap((d) => deliverableImagesForDesign(d))
    .find((img) => String(img.id) === req.params.imageId);
  if (!image) return res.status(404).json({ error: "Datei nicht gefunden." });

  const target = resolveStoredFilePath(image.image);
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
  const art = typeof req.body.art === "string" && db.FEEDBACK_ART_VALUES.includes(req.body.art) ? req.body.art : null;
  // kontext kommt vom Client (aktuelle Seite + ggf. Design-ID aus der URL) -
  // reiner Hinweistext für die spätere Auswertung, kein sicherheitsrelevanter
  // Wert, aber trotzdem auf eine sinnvolle Länge begrenzt.
  const kontext = typeof req.body.kontext === "string" ? req.body.kontext.trim().slice(0, 200) : null;
  res.status(201).json(db.addFeedback({ text, art, kontext }));
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

// --- Testkonzept: Auswertung des Testlaufs (Test A + Test B) als CSV ---
// Für eine einmalige Testauswertung lohnt keine eigene Ansicht im
// Mitarbeiterbereich - eine Tabellenkalkulation reicht, und dort lassen sich
// Fragen stellen, die vorher niemand vorhergesehen hat.

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  // UTF-8-BOM (﻿) voranstellen - ohne das interpretiert Excel Umlaute in
  // einer UTF-8-CSV oft falsch.
  return "﻿" + lines.join("\r\n");
}

function sendCsv(res, filename, csv) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

app.get("/api/admin/export/feedback.csv", requireAuth, (req, res) => {
  const headers = ["id", "erstelltAm", "art", "kontext", "status", "erledigtAm", "text"];
  const rows = db.listFeedback().map((f) => [f.id, f.createdAt, f.art || "", f.kontext || "", f.status, f.erledigtAt || "", f.text]);
  sendCsv(res, "feedback.csv", toCsv(headers, rows));
});

app.get("/api/admin/export/designs.csv", requireAuth, (req, res) => {
  const headers = [
    "id",
    "name",
    "kategorie",
    "angelegtAm",
    "onlineSeitAm",
    "aktuellOnline",
    "anzahlBilder",
    "hatBeschreibung",
    "anzahlTags",
    "preisDesign",
    "preisPng",
    "preisHintergrund",
    "verkaufszaehler",
    "uploadDauerMinuten",
    "serverVerarbeitungSekunden",
    "bearbeitungsdauerMinuten",
  ];
  const rows = db.getDesigns().map((d) => {
    // Nur die "Ohne Wasserzeichen"-Zeilen zählen, damit jede hochgeladene
    // Originaldatei einmal zählt statt doppelt (mit + ohne Wasserzeichen).
    const anzahlBilder = db.getDesignImages(d.id).filter((img) => !img.wasserzeichen).length;
    const uploadDauerMinuten = Math.round((d.uploadDurationMs / 60000) * 10) / 10;
    // Bearbeitungsdauer = Gesamtzeit von Anlegen bis Online, abzüglich der
    // reinen Upload-Zeit - beschreibt also das Ausfüllen von Beschreibung,
    // Tags, Preisen usw. Nur berechenbar, wenn das Design schon online war.
    let bearbeitungsdauerMinuten = "";
    if (d.onlineSetAt) {
      const gesamtMinuten = (new Date(d.onlineSetAt) - new Date(d.createdAt)) / 60000;
      bearbeitungsdauerMinuten = Math.max(0, Math.round((gesamtMinuten - uploadDauerMinuten) * 10) / 10);
    }
    return [
      d.id,
      d.name,
      d.category,
      d.createdAt,
      d.onlineSetAt || "",
      d.online ? "ja" : "nein",
      anzahlBilder,
      d.description && d.description.trim() ? "ja" : "nein",
      d.tags ? d.tags.length : 0,
      d.price,
      d.pricePng,
      d.priceHintergrund,
      d.verkaufszaehler,
      uploadDauerMinuten,
      Math.round((d.serverProcessingMs / 1000) * 10) / 10,
      bearbeitungsdauerMinuten,
    ];
  });
  sendCsv(res, "designs.csv", toCsv(headers, rows));
});

// Zentrale Fehlerbehandlung - ohne diese landet z.B. ein MulterError (falsches
// Feld, zu viele Dateien, Datei zu groß) im Express-Standard-Handler und
// erzeugt einen rohen 500er samt Stacktrace statt einer verständlichen Meldung.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "Datei zu groß (max. 20 MB pro Datei).",
      LIMIT_FILE_COUNT: "Zu viele Dateien auf einmal ausgewählt.",
      LIMIT_UNEXPECTED_FILE: "Zu viele Dateien auf einmal ausgewählt (max. 30).",
    };
    return res.status(400).json({ error: messages[err.code] || `Upload-Fehler: ${err.message}` });
  }
  if (err) {
    console.error(err);
    return res.status(400).json({ error: err.message || "Es ist ein Fehler aufgetreten." });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn (Mitarbeiterbereich) läuft auf http://localhost:${PORT}`);
});
