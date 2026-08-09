const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "teddys.db");
const LEGACY_DESIGNS_FILE = path.join(DATA_DIR, "designs.json");
const LEGACY_CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");

const IMAGE_KATEGORIE_VALUES = ["Mit Wasserzeichen", "Ohne Wasserzeichen", "Hintergrund-Variante"];

const DEFAULT_CATEGORIES = [
  "Tiere",
  "Blumen / Natur",
  "Muster / Abstrakt",
  "Kindermotive",
  "Saisonal",
];

// Reihenfolge der Bestell-Wizard-Schritte 3-7 (Schritt 1 = Bestellung anlegen,
// Schritt 2 = Designs zuordnen, Schritt 8 = Abschluss laufen über eigene Funktionen)
const ORDER_STEPS = [
  "schritt_rechnung",
  "schritt_download",
  "schritt_email_vorbereitet",
  "schritt_verschickt",
  "schritt_datei_geloescht",
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
    schritt_download INTEGER NOT NULL DEFAULT 0,
    schritt_email_vorbereitet INTEGER NOT NULL DEFAULT 0,
    schritt_verschickt INTEGER NOT NULL DEFAULT 0,
    schritt_datei_geloescht INTEGER NOT NULL DEFAULT 0,
    notiz TEXT
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
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("designs", "instagramLink", "TEXT");
ensureColumn("designs", "online", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("design_images", "qualityWarning", "TEXT");
ensureColumn("orders", "kunde_instagram", "TEXT");
ensureColumn("orders", "kunde_whatsapp", "TEXT");
ensureColumn("orders", "kontakt_praeferenz", "TEXT NOT NULL DEFAULT 'E-Mail'");

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
    INSERT INTO design_images (design_id, kategorie, bezeichnung, image, sichtbar, ist_hauptbild, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Hauptbild', ?, 1, 1, ?)
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
  return db.prepare("SELECT * FROM designs ORDER BY rowid DESC").all();
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
    INSERT INTO design_images (design_id, kategorie, bezeichnung, image, sichtbar, ist_hauptbild, qualityWarning, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Hauptbild', ?, 1, 1, ?, ?)
  `).run(design.id, design.image, design.qualityWarning || null, design.createdAt);
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
  // Alle Bild-Dateipfade vorher einsammeln (design_images fällt per ON DELETE
  // CASCADE mit weg, die Dateien auf der Platte muss der Aufrufer selbst löschen)
  const imagePaths = db.prepare("SELECT image FROM design_images WHERE design_id = ?").all(id).map((r) => r.image);
  db.prepare("DELETE FROM designs WHERE id = ?").run(id);
  return { ...target, allImagePaths: [...new Set([target.image, ...imagePaths])] };
}

// --- Bild-Varianten pro Design ---

function getDesignImages(designId) {
  return db.prepare("SELECT * FROM design_images WHERE design_id = ? ORDER BY rowid ASC").all(designId);
}

function addDesignImage({ design_id, kategorie, bezeichnung, image, sichtbar, qualityWarning }) {
  const info = db.prepare(`
    INSERT INTO design_images (design_id, kategorie, bezeichnung, image, sichtbar, ist_hauptbild, qualityWarning, createdAt)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(design_id, kategorie, bezeichnung || "", image, sichtbar ? 1 : 0, qualityWarning || null, new Date().toISOString());
  return db.prepare("SELECT * FROM design_images WHERE id = ?").get(info.lastInsertRowid);
}

// Ersetzt die Bilddatei einer bestehenden design_images-Zeile (z.B. falsche
// Auflösung durch korrekte Datei ersetzen), behält Kategorie/Bezeichnung/
// Sichtbarkeit/Hauptbild-Flag. Gibt die alte Zeile mit zurück, damit der
// Aufrufer die alte Datei von der Platte löschen und ggf. designs.image
// (falls Hauptbild) sowie die sortierte Ablage aktualisieren kann.
function replaceDesignImage(imageId, { image, qualityWarning }) {
  const existing = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!existing) return null;
  db.prepare("UPDATE design_images SET image = ?, qualityWarning = ?, driveSynced = 0 WHERE id = ?")
    .run(image, qualityWarning || null, imageId);
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
    INSERT INTO orders (kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, bestelldatum, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Offen')
  `).run(
    kunde_name,
    kunde_email,
    kunde_instagram || "",
    kunde_whatsapp || "",
    kontakt_praeferenz || "E-Mail",
    new Date().toISOString()
  );
  return getOrder(info.lastInsertRowid);
}

function setOrderDesigns(orderId, designIds) {
  const setDesigns = db.transaction((ids) => {
    db.prepare("DELETE FROM order_designs WHERE order_id = ?").run(orderId);
    const insert = db.prepare("INSERT INTO order_designs (order_id, design_id) VALUES (?, ?)");
    for (const designId of ids) insert.run(orderId, designId);
  });
  setDesigns(designIds);
  return getOrder(orderId);
}

function getOrder(id) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return null;
  const designs = db.prepare(`
    SELECT d.* FROM designs d
    JOIN order_designs od ON od.design_id = d.id
    WHERE od.order_id = ?
  `).all(id);
  return { ...order, designs };
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
  return orders.map((order) => ({ ...order, designs: designCountStmt.all(order.id) }));
}

const ORDER_STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt"];
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
    sanitized[key] = ORDER_STEPS.includes(key) ? (changes[key] ? 1 : 0) : changes[key];
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
  return existing;
}

// Setzt den angegebenen Wizard-Schritt (Schritte 3-7), lehnt ab wenn der
// vorherige Schritt noch nicht erledigt ist oder noch keine Designs zugeordnet sind
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

  db.prepare(`UPDATE orders SET ${stepName} = 1, status = 'In Bearbeitung' WHERE id = ?`).run(orderId);
  return getOrder(orderId);
}

// Schritt 8: schließt die Bestellung ab und erhöht den Verkaufszähler der verknüpften Designs
const completeOrder = db.transaction((orderId) => {
  const order = getOrder(orderId);
  if (!order) return null;
  for (const step of ORDER_STEPS) {
    if (!order[step]) {
      throw new Error(`Schritt "${step}" ist noch nicht erledigt`);
    }
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
  listOrders,
  advanceOrderStep,
  completeOrder,
  updateOrder,
  deleteOrder,
  IMAGE_KATEGORIE_VALUES,
  getDesignImages,
  addDesignImage,
  replaceDesignImage,
  setDesignImageVisibility,
  setHauptbild,
  deleteDesignImage,
};
