const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "teddys.db");
const LEGACY_DESIGNS_FILE = path.join(DATA_DIR, "designs.json");
const LEGACY_CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");

// Feingranulare Klassifizierung eines Bilds (löst das frühere reine Ja/Nein-
// Häkchen "Hintergrund-Variante" in der Bilder-verwalten-UI ab).
const IMAGE_TYP_VALUES = ["Design", "Hintergrund-Variante", "Hintergrund", "Motiv 1", "Motiv 2", "Motiv 3", "sonstiges"];
function typImpliesHintergrundVariante(typ) {
  return typ === "Hintergrund-Variante" || typ === "Hintergrund";
}

// kategorieLabel() erzeugt aus Wasserzeichen + Typ eine lesbare Anzeige-/
// Ordner-Bezeichnung, u.a. für die sortierte NAS-Ablage (uploads-sorted/) -
// so tauchen z.B. "Motiv 2"-Bilder auch dort in einem eigenen "Motiv 2 (Mit
// Wasserzeichen)"-Ordner auf statt ununterscheidbar im allgemeinen
// "Mit Wasserzeichen"-Ordner zu landen. "Design" (der Normalfall, keine
// besondere Variante) bzw. kein Typ ergibt weiterhin die kurze alte Form
// ohne Klammerzusatz, damit bestehende Ordner nicht unnötig umbenannt werden.
function kategorieLabel(wasserzeichen, typ) {
  const wz = wasserzeichen ? "Mit Wasserzeichen" : "Ohne Wasserzeichen";
  if (!typ || typ === "Design") return wz;
  return `${typ} (${wz})`;
}

const DEFAULT_CATEGORIES = [
  "Tiere",
  "Blumen / Natur",
  "Muster / Abstrakt",
  "Kindermotive",
  "Saisonal",
];

// Reihenfolge der manuell abzuhakenden Bestell-Wizard-Schritte (Schritt 1 =
// Bestellung anlegen, Schritt 2 = Designs zuordnen, Schritt 8 = Abschluss
// laufen über eigene Funktionen). "Kunde hat bestätigt" und "Für Download
// freigegeben" sind bewusst KEINE eigenen Spalten hier - seit es das
// Kunden-Portal gibt, leiten die sich direkt aus terms_confirmed_at bzw.
// download_freigegeben ab (siehe advanceOrderStep/completeOrder), statt als
// zusätzlicher, potenziell widersprüchlicher Haken parallel gepflegt zu
// werden. Die alten Spalten schritt_download/schritt_email_vorbereitet/
// schritt_verschickt (manueller Anhang-Versand vor dem Portal) bleiben in der
// DB bestehen (historische Daten), werden aber nicht mehr verwendet.
const ORDER_STEPS = ["schritt_rechnung", "schritt_bezahlung", "schritt_datei_geloescht"];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Feldverschlüsselung für Kundendaten in Bestellungen (Name, E-Mail, Instagram,
// WhatsApp, Notiz, Bestätigungs-IP) - schützt diese Felder, falls die DB-Datei
// oder ein Backup (z.B. NAS-Sync) in falsche Hände gerät, ohne die restliche
// App (Designs, Kategorien) anzufassen. Ohne diesen Schlüssel startet der
// Prozess nicht, analog zu ADMIN_PASSWORD/SESSION_SECRET in server-admin.js.
const ENCRYPTION_KEY_RAW = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY_RAW) {
  console.error(
    "ENCRYPTION_KEY muss als Umgebungsvariable gesetzt sein (siehe .env.example). Abbruch."
  );
  process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_RAW, "base64");
if (ENCRYPTION_KEY.length !== 32) {
  console.error(
    "ENCRYPTION_KEY muss ein base64-kodierter 32-Byte-Schlüssel sein (z.B. mit `openssl rand -base64 32` erzeugt). Abbruch."
  );
  process.exit(1);
}

// AES-256-GCM: iv und authTag werden zusammen mit dem Chiffrat gespeichert
// (Format "iv:authTag:ciphertext", alle base64), da für Entschlüsselung beide
// zusätzlich zum Schlüssel gebraucht werden. Pro Aufruf ein neuer, zufälliger
// iv - notwendig, damit zwei gleiche Klartexte (z.B. "E-Mail" als
// Kontaktpräferenz kommt hier nicht vor, aber z.B. identische Vornamen) nicht
// zu identischem Chiffrat führen.
function encryptField(value) {
  if (value === null || value === undefined) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

// Erkennt am Format (zwei Doppelpunkte, drei base64-Teile), ob ein Feld schon
// verschlüsselt ist - für die einmalige Migration bestehender Klartext-Zeilen.
function looksEncrypted(value) {
  return typeof value === "string" && /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value);
}

function decryptField(value) {
  if (value === null || value === undefined || !looksEncrypted(value)) return value;
  const [ivB64, tagB64, dataB64] = value.split(":");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null; // falscher/rotierter Schlüssel oder beschädigtes Feld
  }
}

// Kundendaten-Felder der orders-Tabelle, die verschlüsselt abgelegt werden.
const ORDER_PII_FIELDS = ["kunde_name", "kunde_email", "kunde_instagram", "kunde_whatsapp", "notiz", "terms_confirmed_ip"];

function encryptOrderFields(obj) {
  const result = { ...obj };
  for (const field of ORDER_PII_FIELDS) {
    if (result[field] !== undefined) result[field] = encryptField(result[field]);
  }
  return result;
}

function decryptOrderRow(row) {
  if (!row) return row;
  const result = { ...row };
  for (const field of ORDER_PII_FIELDS) {
    if (result[field] !== undefined) result[field] = decryptField(result[field]);
  }
  return result;
}

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS designs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    price REAL,
    status TEXT NOT NULL,
    kaufLink TEXT,
    driveLink TEXT,
    instagramLink TEXT,
    image TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    verkaufszaehler INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    name TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offen',
    createdAt TEXT NOT NULL,
    erledigtAt TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kunde_name TEXT NOT NULL,
    kunde_email TEXT NOT NULL,
    kunde_instagram TEXT,
    kunde_whatsapp TEXT,
    kontakt_praeferenz TEXT NOT NULL DEFAULT 'E-Mail',
    bestelldatum TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Offen',
    schritt_rechnung INTEGER NOT NULL DEFAULT 0,
    schritt_bezahlung INTEGER NOT NULL DEFAULT 0,
    schritt_download INTEGER NOT NULL DEFAULT 0,
    schritt_email_vorbereitet INTEGER NOT NULL DEFAULT 0,
    schritt_verschickt INTEGER NOT NULL DEFAULT 0,
    schritt_datei_geloescht INTEGER NOT NULL DEFAULT 0,
    notiz TEXT,
    access_token TEXT,
    token_created_at TEXT,
    terms_confirmed_at TEXT,
    terms_confirmed_ip TEXT,
    terms_text_snapshot TEXT,
    download_freigegeben INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS order_designs (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    design_id TEXT NOT NULL REFERENCES designs(id),
    PRIMARY KEY (order_id, design_id)
  );

  CREATE TABLE IF NOT EXISTS design_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    kategorie TEXT NOT NULL,
    wasserzeichen INTEGER NOT NULL DEFAULT 1,
    hintergrundVariante INTEGER NOT NULL DEFAULT 0,
    bezeichnung TEXT,
    image TEXT NOT NULL,
    sichtbar INTEGER NOT NULL DEFAULT 0,
    ist_hauptbild INTEGER NOT NULL DEFAULT 0,
    qualityWarning TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_designs_category ON designs(category);
  CREATE INDEX IF NOT EXISTS idx_designs_status ON designs(status);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_design_images_design ON design_images(design_id);
`);

// Für bereits existierende Datenbanken: CREATE TABLE IF NOT EXISTS legt keine
// fehlenden Spalten nach, also hier defensiv nachziehen.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (columns.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
ensureColumn("designs", "instagramLink", "TEXT");
ensureColumn("designs", "online", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("design_images", "qualityWarning", "TEXT");
// Verkleinertes Web-Vorschaubild (von sharp erzeugt, z.B. WebP) - die
// öffentliche Seite zeigt bevorzugt dieses statt der oft sehr großen
// Original-Canva-Exportdatei, um die Ladezeit klein zu halten. Original bleibt
// unangetastet für den Druck/die Verkaufsdatei erhalten. NULL = altes Bild von
// vor Einführung dieses Features, Fallback bleibt das Original.
ensureColumn("design_images", "previewImage", "TEXT");
ensureColumn("design_images", "typ", "TEXT");
ensureColumn("orders", "kunde_instagram", "TEXT");
ensureColumn("orders", "kunde_whatsapp", "TEXT");
ensureColumn("orders", "kontakt_praeferenz", "TEXT NOT NULL DEFAULT 'E-Mail'");
// Von der Kundin (öffentliche Anfrage) oder Mitarbeitenden (Bestellung
// neu/bearbeiten) pro zugeordnetem Design ausgewählte Bild-Varianten, als
// JSON-Array der nummerierten Labels (z.B. ["1. Design", "3. Motiv 2"]).
// NULL/kein Eintrag = keine spezifische Variante gewünscht (ganzes Design).
ensureColumn("order_designs", "varianten", "TEXT");
// Neuer Schritt "Auf Bezahlung warten" zwischen Rechnung und Download - für
// Bestellungen, die schon weiter waren als der neue Schritt (schritt_download
// bereits erledigt), rückwirkend als erledigt markieren, sonst würden sie
// durch den neuen Zwischenschritt scheinbar wieder zurückfallen.
if (ensureColumn("orders", "schritt_bezahlung", "INTEGER NOT NULL DEFAULT 0")) {
  db.prepare("UPDATE orders SET schritt_bezahlung = 1 WHERE schritt_download = 1").run();
}

// Wasserzeichen und Hintergrund-Variante waren früher eine einzige flache
// Kategorie ("Mit Wasserzeichen" / "Ohne Wasserzeichen" / "Hintergrund-Variante"),
// jetzt zwei unabhängige Eigenschaften (es gibt auch Hintergrund-Varianten mit
// UND ohne Wasserzeichen). ALTER TABLE ADD COLUMN ... DEFAULT setzt bei
// bestehenden Zeilen erstmal blind den Standardwert (1/0) - hier einmalig aus
// der alten kategorie-Spalte die tatsächlich korrekten Werte nachziehen.
const wasserzeichenColumnAdded = ensureColumn("design_images", "wasserzeichen", "INTEGER NOT NULL DEFAULT 1");
const hintergrundColumnAdded = ensureColumn("design_images", "hintergrundVariante", "INTEGER NOT NULL DEFAULT 0");
if (wasserzeichenColumnAdded || hintergrundColumnAdded) {
  const rows = db.prepare("SELECT id, kategorie FROM design_images").all();
  const update = db.prepare("UPDATE design_images SET wasserzeichen = ?, hintergrundVariante = ? WHERE id = ?");
  for (const row of rows) {
    const hintergrund = row.kategorie === "Hintergrund-Variante" ? 1 : 0;
    const wasserzeichen = row.kategorie === "Ohne Wasserzeichen" ? 0 : 1;
    update.run(wasserzeichen, hintergrund, row.id);
  }
}

// Order-Portal: Zugriffs-Token für die Kunden-Bestätigungsseite. Kryptographisch
// zufällig statt von der fortlaufenden Bestell-ID ableitbar - sonst könnte
// jemand einfach IDs durchprobieren (IDOR).
function generateOrderToken() {
  return crypto.randomBytes(32).toString("base64url");
}
const ORDER_TOKEN_VALIDITY_DAYS = 90;

ensureColumn("orders", "access_token", "TEXT");
ensureColumn("orders", "token_created_at", "TEXT");
ensureColumn("orders", "terms_confirmed_at", "TEXT");
ensureColumn("orders", "terms_confirmed_ip", "TEXT");
ensureColumn("orders", "terms_text_snapshot", "TEXT");
ensureColumn("orders", "download_freigegeben", "INTEGER NOT NULL DEFAULT 0");
// Datei-Ablage für Rechnung (Pflicht-Workflow-Schritt) und Angebot (optionaler
// Zwischenschritt, z.B. wenn Kunden erst ein Angebot bekommen sollen, bevor
// eine Rechnung gestellt wird) - beide speichern nur den Dateinamen (wie
// designs.image), die Datei selbst liegt in UPLOADS_DIR.
ensureColumn("orders", "rechnung_datei", "TEXT");
ensureColumn("orders", "angebot_datei", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_access_token ON orders(access_token)");
// Bestellungen von vor Einführung des Order-Portals bekommen nachträglich einen Token.
for (const row of db.prepare("SELECT id FROM orders WHERE access_token IS NULL").all()) {
  db.prepare("UPDATE orders SET access_token = ?, token_created_at = ? WHERE id = ?")
    .run(generateOrderToken(), new Date().toISOString(), row.id);
}

// Einmalige Migration: bestehende Klartext-Kundendaten (von vor Einführung
// der Feldverschlüsselung) verschlüsseln. looksEncrypted() am Namen-Feld
// erkennt bereits migrierte Zeilen, damit das bei jedem Serverstart nicht
// erneut über alle Bestellungen läuft.
function migrateEncryptOrderFields() {
  const rows = db.prepare(`
    SELECT id, kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, notiz, terms_confirmed_ip
    FROM orders
  `).all();
  const toMigrate = rows.filter((row) => !looksEncrypted(row.kunde_name));
  if (toMigrate.length === 0) return;
  const update = db.prepare(`
    UPDATE orders SET kunde_name = ?, kunde_email = ?, kunde_instagram = ?, kunde_whatsapp = ?, notiz = ?, terms_confirmed_ip = ?
    WHERE id = ?
  `);
  const migrate = db.transaction((rows) => {
    for (const row of rows) {
      update.run(
        encryptField(row.kunde_name),
        encryptField(row.kunde_email),
        encryptField(row.kunde_instagram),
        encryptField(row.kunde_whatsapp),
        encryptField(row.notiz),
        encryptField(row.terms_confirmed_ip),
        row.id
      );
    }
  });
  migrate(toMigrate);
}
migrateEncryptOrderFields();

migrateFromLegacyJson();
backfillDesignImages();

// Jedes Design ohne design_images-Einträge (z.B. alle vor Einführung der
// Bild-Varianten) bekommt sein bisheriges Einzelbild als "Hauptbild"-Eintrag,
// damit nichts verschwindet und die neue Bilder-Verwaltung sofort konsistent ist.
function backfillDesignImages() {
  const designsWithoutImages = db.prepare(`
    SELECT d.id, d.image FROM designs d
    LEFT JOIN design_images di ON di.design_id = d.id
    WHERE di.id IS NULL
  `).all();

  const insert = db.prepare(`
    INSERT INTO design_images (design_id, kategorie, typ, bezeichnung, image, sichtbar, ist_hauptbild, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Design', 'Hauptbild', ?, 1, 1, ?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const d of rows) insert.run(d.id, d.image, new Date().toISOString());
  });
  insertMany(designsWithoutImages);
}

function migrateFromLegacyJson() {
  const designCount = db.prepare("SELECT COUNT(*) AS c FROM designs").get().c;
  if (designCount === 0 && fs.existsSync(LEGACY_DESIGNS_FILE)) {
    const legacyDesigns = JSON.parse(fs.readFileSync(LEGACY_DESIGNS_FILE, "utf-8"));
    const insert = db.prepare(`
      INSERT INTO designs (id, name, description, category, price, status, kaufLink, driveLink, instagramLink, image, verkaufszaehler, createdAt)
      VALUES (@id, @name, @description, @category, @price, @status, @kaufLink, @driveLink, @instagramLink, @image, @verkaufszaehler, @createdAt)
    `);
    const insertMany = db.transaction((rows) => {
      for (const d of rows) {
        insert.run({
          id: d.id,
          name: d.name,
          description: d.description || "",
          category: d.category,
          price: d.price ?? null,
          status: d.status,
          kaufLink: d.kaufLink || "",
          driveLink: d.driveLink || "",
          instagramLink: d.instagramLink || "",
          image: d.image,
          verkaufszaehler: 0,
          createdAt: d.createdAt || new Date().toISOString(),
        });
      }
    });
    insertMany(legacyDesigns);
  }

  const categoryCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  if (categoryCount === 0) {
    const legacyCategories = fs.existsSync(LEGACY_CATEGORIES_FILE)
      ? JSON.parse(fs.readFileSync(LEGACY_CATEGORIES_FILE, "utf-8"))
      : DEFAULT_CATEGORIES;
    const insert = db.prepare("INSERT INTO categories (name) VALUES (?)");
    const insertMany = db.transaction((names) => {
      for (const name of names) insert.run(name);
    });
    insertMany(legacyCategories);
  }
}

// --- Designs ---

function getDesigns() {
  // qualityWarning und previewImage kommen vom Hauptbild - beide sollen überall
  // verfügbar sein, wo Designs in einer Liste angezeigt/ausgewählt werden
  // (z.B. öffentliche Galerie, Bestell-Wizard), ohne dass man dafür extra die
  // Bilder-verwalten-Seite pro Design aufrufen muss.
  return db.prepare(`
    SELECT designs.*, design_images.qualityWarning AS qualityWarning, design_images.previewImage AS previewImage
    FROM designs
    LEFT JOIN design_images ON design_images.design_id = designs.id AND design_images.ist_hauptbild = 1
    ORDER BY designs.rowid DESC
  `).all();
}

function getDesign(id) {
  return db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
}

// TD-XXXX: fortlaufende Nummer über alle bisher vergebenen IDs hinweg
function nextId() {
  const rows = db.prepare("SELECT id FROM designs").all();
  const max = rows.reduce((acc, d) => {
    const match = /^TD-(\d+)$/.exec(d.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `TD-${String(max + 1).padStart(4, "0")}`;
}

function addDesign(design) {
  db.prepare(`
    INSERT INTO designs (id, name, description, category, price, status, kaufLink, driveLink, instagramLink, image, online, verkaufszaehler, createdAt)
    VALUES (@id, @name, @description, @category, @price, @status, @kaufLink, @driveLink, @instagramLink, @image, @online, 0, @createdAt)
  `).run({
    id: design.id,
    name: design.name,
    description: design.description || "",
    category: design.category,
    price: design.price ?? null,
    status: design.status,
    kaufLink: design.kaufLink || "",
    driveLink: design.driveLink || "",
    instagramLink: design.instagramLink || "",
    image: design.image,
    online: design.online === undefined ? 1 : (design.online ? 1 : 0),
    createdAt: design.createdAt,
  });
  db.prepare(`
    INSERT INTO design_images (design_id, kategorie, typ, bezeichnung, image, previewImage, sichtbar, ist_hauptbild, qualityWarning, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Design', 'Hauptbild', ?, ?, 1, 1, ?, ?)
  `).run(design.id, design.image, design.previewImage || null, design.qualityWarning || null, design.createdAt);
  return db.prepare("SELECT * FROM designs WHERE id = ?").get(design.id);
}

const DESIGN_UPDATE_FIELDS = ["name", "description", "category", "price", "status", "kaufLink", "driveLink", "instagramLink", "online"];

function updateDesign(id, changes) {
  const existing = db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
  if (!existing) return null;

  const fields = Object.keys(changes).filter((k) => DESIGN_UPDATE_FIELDS.includes(k));
  if (fields.length > 0) {
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE designs SET ${setClause} WHERE id = @id`).run({ ...changes, id });
  }
  return db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
}

function deleteDesign(id) {
  const target = db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
  if (!target) return null;
  // Alle Bild-Dateipfade (Original + Vorschaubild) vorher einsammeln
  // (design_images fällt per ON DELETE CASCADE mit weg, die Dateien auf der
  // Platte muss der Aufrufer selbst löschen)
  const rows = db.prepare("SELECT image, previewImage FROM design_images WHERE design_id = ?").all(id);
  const imagePaths = rows.flatMap((r) => [r.image, r.previewImage]).filter(Boolean);
  db.prepare("DELETE FROM designs WHERE id = ?").run(id);
  return { ...target, allImagePaths: [...new Set([target.image, ...imagePaths])] };
}

// Ändert die TD-ID eines Designs (nur für Testzwecke/Korrekturen gedacht,
// nicht Teil des normalen Alltagsbetriebs). Die ID ist Primärschlüssel und an
// mehreren Stellen per Fremdschlüssel referenziert (design_images, order_designs) -
// Fremdschlüsselprüfung kurz deaktivieren, damit die Reihenfolge der Updates
// innerhalb der Transaktion keine Rolle spielt, danach wieder aktivieren.
function renameDesignId(oldId, newId) {
  if (!/^TD-\d+$/.test(newId)) {
    const err = new Error("Neue ID muss dem Format TD-0000 entsprechen");
    err.status = 400;
    throw err;
  }
  const existing = db.prepare("SELECT id FROM designs WHERE id = ?").get(oldId);
  if (!existing) return null;
  if (newId === oldId) return db.prepare("SELECT * FROM designs WHERE id = ?").get(oldId);
  const collision = db.prepare("SELECT id FROM designs WHERE id = ?").get(newId);
  if (collision) {
    const err = new Error(`ID ${newId} ist bereits vergeben`);
    err.status = 409;
    throw err;
  }

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.prepare("UPDATE designs SET id = ? WHERE id = ?").run(newId, oldId);
      db.prepare("UPDATE design_images SET design_id = ? WHERE design_id = ?").run(newId, oldId);
      db.prepare("UPDATE order_designs SET design_id = ? WHERE design_id = ?").run(newId, oldId);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return db.prepare("SELECT * FROM designs WHERE id = ?").get(newId);
}

// --- Bild-Varianten pro Design ---

function getDesignImages(designId) {
  return db.prepare("SELECT * FROM design_images WHERE design_id = ? ORDER BY rowid ASC").all(designId);
}

function addDesignImage({ design_id, wasserzeichen, typ, bezeichnung, image, previewImage, sichtbar, qualityWarning }) {
  const wz = wasserzeichen ? 1 : 0;
  const hg = typImpliesHintergrundVariante(typ) ? 1 : 0;
  const info = db.prepare(`
    INSERT INTO design_images (design_id, kategorie, wasserzeichen, hintergrundVariante, typ, bezeichnung, image, previewImage, sichtbar, ist_hauptbild, qualityWarning, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(design_id, kategorieLabel(wz, typ), wz, hg, typ || null, bezeichnung || "", image, previewImage || null, sichtbar ? 1 : 0, qualityWarning || null, new Date().toISOString());
  return db.prepare("SELECT * FROM design_images WHERE id = ?").get(info.lastInsertRowid);
}

// Ersetzt die Bilddatei einer bestehenden design_images-Zeile (z.B. falsche
// Auflösung durch korrekte Datei ersetzen), behält Kategorie/Bezeichnung/
// Sichtbarkeit/Hauptbild-Flag. Gibt die alte Zeile mit zurück, damit der
// Aufrufer die alte Datei von der Platte löschen und ggf. designs.image
// (falls Hauptbild) sowie die sortierte Ablage aktualisieren kann.
function replaceDesignImage(imageId, { image, previewImage, qualityWarning }) {
  const existing = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!existing) return null;
  db.prepare("UPDATE design_images SET image = ?, previewImage = ?, qualityWarning = ? WHERE id = ?")
    .run(image, previewImage || null, qualityWarning || null, imageId);
  if (existing.ist_hauptbild) {
    db.prepare("UPDATE designs SET image = ? WHERE id = ?").run(image, existing.design_id);
  }
  return { old: existing, updated: db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId) };
}

function setDesignImageVisibility(imageId, sichtbar) {
  const info = db.prepare("UPDATE design_images SET sichtbar = ? WHERE id = ?").run(sichtbar ? 1 : 0, imageId);
  if (info.changes === 0) return null;
  return db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
}

// Nachträgliche Korrektur der Kategorie (z.B. versehentlich "Mit Wasserzeichen"
// statt "Ohne Wasserzeichen" gewählt) - gibt die alte Zeile mit zurück, damit
// der Aufrufer die sortierte Ablage (uploads-sorted/) in den neuen
// Kategorie-Ordner verschieben kann.
function setDesignImageEigenschaften(imageId, { wasserzeichen, typ }) {
  const existing = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!existing) return null;
  const wz = wasserzeichen === undefined ? existing.wasserzeichen : (wasserzeichen ? 1 : 0);
  const newTyp = typ === undefined ? existing.typ : typ;
  const hg = typ === undefined ? existing.hintergrundVariante : (typImpliesHintergrundVariante(typ) ? 1 : 0);
  db.prepare("UPDATE design_images SET wasserzeichen = ?, hintergrundVariante = ?, typ = ?, kategorie = ? WHERE id = ?")
    .run(wz, hg, newTyp, kategorieLabel(wz, newTyp), imageId);
  return { old: existing, updated: db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId) };
}

// Setzt genau ein Bild als Hauptbild (für die Design-Karte/Lightbox) und
// spiegelt den Pfad zusätzlich in designs.image, damit der Rest des Codes
// (der bisher nur designs.image kennt) unverändert weiterfunktioniert.
const setHauptbild = db.transaction((designId, imageId) => {
  const image = db.prepare("SELECT * FROM design_images WHERE id = ? AND design_id = ?").get(imageId, designId);
  if (!image) return null;
  db.prepare("UPDATE design_images SET ist_hauptbild = 0 WHERE design_id = ?").run(designId);
  db.prepare("UPDATE design_images SET ist_hauptbild = 1, sichtbar = 1 WHERE id = ?").run(imageId);
  db.prepare("UPDATE designs SET image = ? WHERE id = ?").run(image.image, designId);
  return getDesignImages(designId);
});

function deleteDesignImage(imageId) {
  const target = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!target) return null;
  if (target.ist_hauptbild) {
    const err = new Error("Das Hauptbild kann nicht gelöscht werden - erst ein anderes Bild als Hauptbild festlegen");
    err.status = 400;
    throw err;
  }
  db.prepare("DELETE FROM design_images WHERE id = ?").run(imageId);
  return target;
}

// --- Feedback-Notizen (Dashboard) ---

function listFeedback() {
  return db.prepare("SELECT * FROM feedback ORDER BY (status = 'offen') DESC, rowid DESC").all();
}

function addFeedback(text) {
  const info = db.prepare("INSERT INTO feedback (text, status, createdAt) VALUES (?, 'offen', ?)").run(text, new Date().toISOString());
  return db.prepare("SELECT * FROM feedback WHERE id = ?").get(info.lastInsertRowid);
}

function setFeedbackStatus(id, status) {
  const info = db
    .prepare("UPDATE feedback SET status = ?, erledigtAt = ? WHERE id = ?")
    .run(status, status === "erledigt" ? new Date().toISOString() : null, id);
  if (info.changes === 0) return null;
  return db.prepare("SELECT * FROM feedback WHERE id = ?").get(id);
}

function deleteFeedback(id) {
  const info = db.prepare("DELETE FROM feedback WHERE id = ?").run(id);
  return info.changes > 0;
}

// --- Kategorien ---

function getCategories() {
  return db.prepare("SELECT name FROM categories ORDER BY rowid ASC").all().map((r) => r.name);
}

function addCategory(name) {
  db.prepare("INSERT INTO categories (name) VALUES (?)").run(name);
  return getCategories();
}

// Umbenennen zieht alle Designs der Kategorie mit um
const renameCategory = db.transaction((oldName, newName) => {
  const result = db.prepare("UPDATE categories SET name = ? WHERE name = ?").run(newName, oldName);
  if (result.changes === 0) return null;
  db.prepare("UPDATE designs SET category = ? WHERE category = ?").run(newName, oldName);
  return getCategories();
});

function deleteCategory(name) {
  const result = db.prepare("DELETE FROM categories WHERE name = ?").run(name);
  if (result.changes === 0) return null;
  return getCategories();
}

// --- Bestellungen ---

function createOrder({ kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz }) {
  const info = db.prepare(`
    INSERT INTO orders (kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, bestelldatum, status, access_token, token_created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Offen', ?, ?)
  `).run(
    encryptField(kunde_name),
    encryptField(kunde_email),
    encryptField(kunde_instagram || ""),
    encryptField(kunde_whatsapp || ""),
    kontakt_praeferenz || "E-Mail",
    new Date().toISOString(),
    generateOrderToken(),
    new Date().toISOString()
  );
  return getOrder(info.lastInsertRowid);
}

// variantenMap: { [designId]: string[] } - von der Kundin (öffentliche
// Anfrage) oder Mitarbeitenden (Bestellung neu/bearbeiten) pro Design
// ausgewählte Varianten-Labels, optional.
function setOrderDesigns(orderId, designIds, variantenMap = {}) {
  const setDesigns = db.transaction((ids, varianten) => {
    db.prepare("DELETE FROM order_designs WHERE order_id = ?").run(orderId);
    const insert = db.prepare("INSERT INTO order_designs (order_id, design_id, varianten) VALUES (?, ?, ?)");
    for (const designId of ids) {
      const selected = Array.isArray(varianten[designId]) ? varianten[designId].filter((v) => typeof v === "string") : [];
      insert.run(orderId, designId, selected.length > 0 ? JSON.stringify(selected) : null);
    }
    // Wenn der Kunde die Bestellung schon über das Order-Portal bestätigt
    // hatte, macht eine nachträgliche Design-Änderung diese Bestätigung
    // ungültig - Kunde muss die (jetzt andere) Bestellung erneut bestätigen.
    db.prepare(`
      UPDATE orders SET terms_confirmed_at = NULL, terms_confirmed_ip = NULL, terms_text_snapshot = NULL
      WHERE id = ? AND terms_confirmed_at IS NOT NULL
    `).run(orderId);
  });
  setDesigns(designIds, variantenMap || {});
  return getOrder(orderId);
}

function designsWithVarianten(orderId) {
  return db.prepare(`
    SELECT d.*, od.varianten AS varianten FROM designs d
    JOIN order_designs od ON od.design_id = d.id
    WHERE od.order_id = ?
  `).all(orderId).map((d) => ({ ...d, varianten: d.varianten ? JSON.parse(d.varianten) : [] }));
}

function getOrder(id) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return null;
  return decryptOrderRow({ ...order, designs: designsWithVarianten(id) });
}

// --- Order-Portal (Kunden-Bestätigungsseite) ---

function getOrderByToken(token) {
  const order = db.prepare("SELECT * FROM orders WHERE access_token = ?").get(token);
  if (!order) return null;
  return decryptOrderRow({ ...order, designs: designsWithVarianten(order.id) });
}

function confirmOrderTerms(orderId, ip, textSnapshot) {
  const info = db
    .prepare("UPDATE orders SET terms_confirmed_at = ?, terms_confirmed_ip = ?, terms_text_snapshot = ? WHERE id = ?")
    .run(new Date().toISOString(), encryptField(ip), textSnapshot, orderId);
  if (info.changes === 0) return null;
  return getOrder(orderId);
}

// Neuer Token nach Ablauf oder falls der alte Link versehentlich woanders
// gelandet ist - macht eine vorherige Bestätigung ungültig, da diese sich auf
// den alten Link bezog.
function regenerateOrderToken(orderId) {
  const info = db
    .prepare(`
      UPDATE orders SET access_token = ?, token_created_at = ?,
        terms_confirmed_at = NULL, terms_confirmed_ip = NULL, terms_text_snapshot = NULL
      WHERE id = ?
    `)
    .run(generateOrderToken(), new Date().toISOString(), orderId);
  if (info.changes === 0) return null;
  return getOrder(orderId);
}

function setDownloadFreigabe(orderId, freigegeben) {
  const info = db.prepare("UPDATE orders SET download_freigegeben = ? WHERE id = ?").run(freigegeben ? 1 : 0, orderId);
  if (info.changes === 0) return null;
  return getOrder(orderId);
}

const ORDER_FILE_FIELDS = ["rechnung_datei", "angebot_datei"];

function setOrderFile(orderId, field, filename) {
  if (!ORDER_FILE_FIELDS.includes(field)) {
    throw new Error(`Unbekanntes Datei-Feld: ${field}`);
  }
  const info = db.prepare(`UPDATE orders SET ${field} = ? WHERE id = ?`).run(filename, orderId);
  if (info.changes === 0) return null;
  return getOrder(orderId);
}

function listOrders(status) {
  const orders = status
    ? db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY bestelldatum DESC").all(status)
    : db.prepare("SELECT * FROM orders ORDER BY bestelldatum DESC").all();

  const designCountStmt = db.prepare(`
    SELECT d.id, d.name FROM designs d
    JOIN order_designs od ON od.design_id = d.id
    WHERE od.order_id = ?
  `);
  return orders.map((order) => decryptOrderRow({ ...order, designs: designCountStmt.all(order.id) }));
}

const ORDER_STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt", "Storniert"];
const ORDER_UPDATE_FIELDS = [
  "kunde_name",
  "kunde_email",
  "kunde_instagram",
  "kunde_whatsapp",
  "kontakt_praeferenz",
  "status",
  "notiz",
  ...ORDER_STEPS,
];
const KONTAKT_PRAEFERENZ_VALUES = ["E-Mail", "WhatsApp"];

// Freie Bearbeitung: im Gegensatz zu advanceOrderStep() keine Reihenfolge-Pflicht,
// Schritte lassen sich einzeln an-/abhaken, auch bei bereits abgeschlossenen Bestellungen.
// Der Verkaufszähler der Designs wird hier bewusst NICHT automatisch angepasst.
function updateOrder(id, changes) {
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!existing) return null;

  const sanitized = {};
  for (const key of Object.keys(changes)) {
    if (!ORDER_UPDATE_FIELDS.includes(key)) continue;
    if (ORDER_STEPS.includes(key)) sanitized[key] = changes[key] ? 1 : 0;
    else if (ORDER_PII_FIELDS.includes(key)) sanitized[key] = encryptField(changes[key]);
    else sanitized[key] = changes[key];
  }

  // Gleiche Kopplung wie in advanceOrderStep: Bezahlung erhalten gibt Dateien
  // + Rechnung automatisch frei, auch wenn "bezahlt" hier über die freie
  // Bearbeitung an-/abgehakt wird statt über den Wizard-Schritt. Nur beim
  // Wechsel von nicht-bezahlt zu bezahlt auslösen, nicht bei jedem Speichern.
  if (sanitized.schritt_bezahlung === 1 && !existing.schritt_bezahlung) {
    sanitized.download_freigegeben = 1;
  }

  const fields = Object.keys(sanitized);
  if (fields.length > 0) {
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE orders SET ${setClause} WHERE id = @id`).run({ ...sanitized, id });
  }
  return getOrder(id);
}

function deleteOrder(id) {
  const existing = getOrder(id);
  if (!existing) return null;
  db.prepare("DELETE FROM orders WHERE id = ?").run(id);
  // Bestellnummern-Zähler nach dem Löschen aufräumen: bei Test-Bestellungen
  // soll die nächste echte Bestellung wieder lückenlos anschließen statt
  // eine "Lücke" durch die gelöschte Test-Nummer zu hinterlassen.
  const max = db.prepare("SELECT MAX(id) AS max FROM orders").get().max;
  if (max === null) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'orders'").run();
  } else {
    db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'orders'").run(max);
  }
  return existing;
}

// Setzt den angegebenen Wizard-Schritt, lehnt ab wenn der vorherige Schritt
// noch nicht erledigt ist oder noch keine Designs zugeordnet sind.
// "Kunde hat bestätigt" läuft NICHT über diese Funktion (siehe
// ORDER_STEPS-Kommentar) - schritt_bezahlung prüft es deshalb hier explizit
// zusätzlich zur normalen ORDER_STEPS-Kette (die Kundin muss dem Angebot erst
// zugestimmt haben, bevor eine Zahlung dafür verbucht wird). Bezahlung
// erhalten setzt automatisch download_freigegeben - Dateien und Rechnung
// sollen der Kundin ohne separaten manuellen Klick zugänglich werden, sobald
// bezahlt ist.
function advanceOrderStep(orderId, stepName) {
  if (!ORDER_STEPS.includes(stepName)) {
    throw new Error(`Unbekannter Schritt: ${stepName}`);
  }
  const order = getOrder(orderId);
  if (!order) return null;
  if (order.designs.length === 0) {
    throw new Error("Es müssen zuerst Designs zugeordnet werden (Schritt 2)");
  }

  const stepIndex = ORDER_STEPS.indexOf(stepName);
  for (let i = 0; i < stepIndex; i++) {
    if (!order[ORDER_STEPS[i]]) {
      throw new Error(`Vorheriger Schritt "${ORDER_STEPS[i]}" ist noch nicht erledigt`);
    }
  }
  if (stepName === "schritt_bezahlung" && !order.terms_confirmed_at) {
    throw new Error('Vorheriger Schritt "Kunde hat bestätigt" ist noch nicht erledigt');
  }
  if (stepName === "schritt_datei_geloescht" && !order.download_freigegeben) {
    throw new Error('Vorheriger Schritt "Für Download freigegeben" ist noch nicht erledigt');
  }

  db.prepare(`UPDATE orders SET ${stepName} = 1, status = 'In Bearbeitung' WHERE id = ?`).run(orderId);
  if (stepName === "schritt_bezahlung") {
    db.prepare("UPDATE orders SET download_freigegeben = 1 WHERE id = ?").run(orderId);
  }
  return getOrder(orderId);
}

// Schritt 7: schließt die Bestellung ab und erhöht den Verkaufszähler der verknüpften Designs
const completeOrder = db.transaction((orderId) => {
  const order = getOrder(orderId);
  if (!order) return null;
  for (const step of ORDER_STEPS) {
    if (!order[step]) {
      throw new Error(`Schritt "${step}" ist noch nicht erledigt`);
    }
  }
  if (!order.terms_confirmed_at) {
    throw new Error('Schritt "Kunde hat bestätigt" ist noch nicht erledigt');
  }
  if (!order.download_freigegeben) {
    throw new Error('Schritt "Für Download freigegeben" ist noch nicht erledigt');
  }

  db.prepare("UPDATE orders SET status = 'Erledigt' WHERE id = ?").run(orderId);
  const incrementCounter = db.prepare(
    "UPDATE designs SET verkaufszaehler = verkaufszaehler + 1 WHERE id = ?"
  );
  for (const design of order.designs) incrementCounter.run(design.id);

  return getOrder(orderId);
});

module.exports = {
  getDesigns,
  getDesign,
  nextId,
  addDesign,
  updateDesign,
  deleteDesign,
  renameDesignId,
  IMAGE_TYP_VALUES,
  getCategories,
  addCategory,
  renameCategory,
  deleteCategory,
  ORDER_STEPS,
  ORDER_STATUS_VALUES,
  KONTAKT_PRAEFERENZ_VALUES,
  createOrder,
  setOrderDesigns,
  getOrder,
  getOrderByToken,
  confirmOrderTerms,
  regenerateOrderToken,
  setDownloadFreigabe,
  setOrderFile,
  ORDER_TOKEN_VALIDITY_DAYS,
  listOrders,
  advanceOrderStep,
  completeOrder,
  updateOrder,
  deleteOrder,
  getDesignImages,
  addDesignImage,
  replaceDesignImage,
  setDesignImageVisibility,
  setDesignImageEigenschaften,
  setHauptbild,
  deleteDesignImage,
  listFeedback,
  addFeedback,
  setFeedbackStatus,
  deleteFeedback,
};
