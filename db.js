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
// Der dritte Teil (Ciphertext) darf leer sein - AES-GCM eines leeren Strings
// (z.B. kunde_email bei manuell erfassten Rechten ohne E-Mail) erzeugt einen
// 0-Byte-Ciphertext, nur iv und authTag haben immer feste Länge > 0.
function looksEncrypted(value) {
  return typeof value === "string" && /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(value);
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
// sevdesk_kundennummer zählt dazu, weil sie zusammen mit dem Zugriff auf
// sevDesk auf eine konkrete Kundin zurückführt.
const ORDER_PII_FIELDS = ["kunde_name", "kunde_email", "kunde_instagram", "kunde_whatsapp", "notiz", "terms_confirmed_ip", "sevdesk_kundennummer"];

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
    pricePng REAL,
    priceHintergrund REAL,
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
    preisoptionen TEXT,
    PRIMARY KEY (order_id, design_id)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS design_tags (
    design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (design_id, tag_id)
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

  -- Rechte-Nachweis für Farbexklusive Varianten: hält pro abgeschlossener
  -- Bestellung fest, welche Gruppe (Farbvariante) und welcher Preisbaustein
  -- (design/png/hintergrund - siehe PREISOPTIONEN_VALUES) gekauft wurde und ob
  -- exklusiv. Exklusivität gilt pro Bestandteil, nicht pauschal für die ganze
  -- Gruppe - ein Hintergrund kann exklusiv an eine Kundin gehen, während
  -- Design und PNG derselben Gruppe für andere frei bleiben. gruppe NULL =
  -- Design ohne Varianten-Gruppen (siehe design_images.gruppe unten).
  CREATE TABLE IF NOT EXISTS design_lizenzen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    design_id TEXT NOT NULL REFERENCES designs(id),
    gruppe TEXT,
    bestandteil TEXT NOT NULL,
    exklusiv INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_designs_category ON designs(category);
  CREATE INDEX IF NOT EXISTS idx_designs_status ON designs(status);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_design_images_design ON design_images(design_id);
  CREATE INDEX IF NOT EXISTS idx_design_tags_tag ON design_tags(tag_id);
  CREATE INDEX IF NOT EXISTS idx_design_lizenzen_design ON design_lizenzen(design_id, gruppe);
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
// Testkonzept: "Aus dem Abstand zwischen Anlegen und Onlineschalten ergibt
// sich die Bearbeitungsdauer je Design" - ohne diesen Zeitstempel lässt sich
// das nicht auswerten (createdAt allein sagt nichts darüber, wann ein Design
// tatsächlich veröffentlicht wurde). NULL = noch nie online gewesen, wird
// beim ersten Wechsel auf online=1 einmalig gesetzt (siehe addDesign/updateDesign)
// und danach nicht mehr verändert, auch wenn später wieder offline geschaltet wird.
ensureColumn("designs", "onlineSetAt", "TEXT");
// Testkonzept-Auswertung, feiner als nur Anlegen->Online: uploadDurationMs
// ist die Zeit vom ersten Datei-Auswählen bis zum Absenden, im Browser
// gemessen und über alle Upload-Vorgänge zu diesem Design aufaddiert (Anlegen
// + spätere Ergänzungen über die Bilder-Verwaltung). serverProcessingMs ist
// die reine Verarbeitungszeit auf dem Server für dieselben Vorgänge - zeigt,
// ob technische Performance irgendwann zum Flaschenhals wird, unabhängig vom
// Personal. Die eigentliche "Bearbeitungsdauer" (Ausfüllen von Beschreibung,
// Tags, Preisen) muss dafür nicht extra gemessen werden: sie ergibt sich als
// (onlineSetAt - createdAt) minus uploadDurationMs, reine Rechnung bei der Auswertung.
ensureColumn("designs", "uploadDurationMs", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("designs", "serverProcessingMs", "INTEGER NOT NULL DEFAULT 0");
// Reine Canva-Arbeitszeit: Start-Knopf auf "Design hochladen" wird VOR dem
// Wechsel zu Canva gedrückt, die Uhr stoppt automatisch beim ersten
// Datei-Auswählen danach (siehe admin-neu.js) - eigenständige Phase VOR
// uploadDurationMs (das misst nur Datei-auswählen bis Absenden, also das
// Ausfüllen des Formulars, nicht die eigentliche Design-Erstellung).
ensureColumn("designs", "canvaDurationMs", "INTEGER NOT NULL DEFAULT 0");
// Rein für die manuelle CSV-Auswertung der Zeitmessung (z.B. "hat länger
// gedauert, weil ..."), keine operative Bedeutung, taucht nirgends beim
// Kunden oder in der normalen Design-Verwaltung auf.
ensureColumn("designs", "auswertungsNotiz", "TEXT");
// Upload-Plan Schritt 9 (Grundlage, Oberfläche folgt später): wie oft ein
// Design ohne eigene Varianten-Gruppen verkauft werden darf. NULL =
// unbegrenzt. Für Designs MIT Gruppen (siehe design_images.gruppe und die
// design_lizenzen-Tabelle) übernimmt stattdessen die dortige, feinere
// Rechte-Erfassung pro Gruppe/Bestandteil diese Aufgabe.
ensureColumn("designs", "maxVerkaeufe", "INTEGER");
// Nicht jedes Design ist 20x20cm - die Kantenlänge in cm bestimmt, wie viele
// Pixel bei 300dpi für einen scharfen Druck nötig sind (siehe
// minPrintDimensionPx in server-admin.js). 20 als Standardwert für
// bestehende Designs, damit sich an deren Qualitätsprüfung nichts ändert.
ensureColumn("designs", "groesseCm", "INTEGER NOT NULL DEFAULT 20");
// Gestaffelte Preise statt eines einzigen Werts: "price" bleibt der
// Design-Preis (jetzt Standard 10€ statt vorher optional), dazu die
// PNG-Dateien (alle Motive einzeln, Standard 6€) und der Hintergrund separat
// (Standard 5€) - Kundinnen können alle drei Bausteine addierend kombinieren.
// Bestehende Designs bekommen die neuen Standardwerte nachgezogen, damit
// nicht plötzlich NULL/0€ für PNG/Hintergrund dasteht.
if (ensureColumn("designs", "pricePng", "REAL")) {
  db.prepare("UPDATE designs SET pricePng = 6 WHERE pricePng IS NULL").run();
}
if (ensureColumn("designs", "priceHintergrund", "REAL")) {
  db.prepare("UPDATE designs SET priceHintergrund = 5 WHERE priceHintergrund IS NULL").run();
}
ensureColumn("design_images", "qualityWarning", "TEXT");
// Verkleinertes Web-Vorschaubild (von sharp erzeugt, z.B. WebP) - die
// öffentliche Seite zeigt bevorzugt dieses statt der oft sehr großen
// Original-Canva-Exportdatei, um die Ladezeit klein zu halten. Original bleibt
// unangetastet für den Druck/die Verkaufsdatei erhalten. NULL = altes Bild von
// vor Einführung dieses Features, Fallback bleibt das Original.
ensureColumn("design_images", "previewImage", "TEXT");
ensureColumn("design_images", "typ", "TEXT");
// Manuelle Reihenfolge der Bild-Varianten (Admin-Verwaltung + öffentliche
// Galerie nutzen dieselbe Sortierung) - ohne diese Spalte bestimmt nur die
// Einfügereihenfolge (rowid) die Anzeige, Mitarbeitende wollen sie aber
// selbst festlegen können. Bestehende Bilder behalten ihre bisherige
// Reihenfolge (id als Startwert), erst danach per moveDesignImage änderbar.
if (ensureColumn("design_images", "sortOrder", "INTEGER")) {
  db.exec("UPDATE design_images SET sortOrder = id WHERE sortOrder IS NULL");
}
// Verknüpft die beiden zusammengehörigen Zeilen einer hochgeladenen
// Originaldatei (mit + ohne Wasserzeichen) - damit lassen sich beide in der
// Bilder-Verwaltung als eine Kachel mit gemeinsamem Typ/Bezeichnung
// bearbeiten, statt zweimal dasselbe einzutragen. Wird beim Hochladen ab
// jetzt immer gesetzt (siehe server-admin.js); bestehende Zeilen ohne
// pairId einmalig über den Fallback aus Schritt 8 nachziehen: Zeilen mit
// gleichem Design, Typ und Bezeichnung, bei denen genau eine "mit" und eine
// "ohne" Wasserzeichen ist, gelten als Paar. Ohne passenden Partner bleibt
// die Zeile eine eigene Einzel-Kachel.
if (ensureColumn("design_images", "pairId", "TEXT")) {
  const rows = db.prepare("SELECT id, design_id, typ, bezeichnung, wasserzeichen FROM design_images WHERE pairId IS NULL").all();
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.design_id}\u0000${row.typ || ""}\u0000${row.bezeichnung || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const setPairId = db.prepare("UPDATE design_images SET pairId = ? WHERE id = ?");
  for (const group of groups.values()) {
    const withWm = group.filter((r) => r.wasserzeichen);
    const withoutWm = group.filter((r) => !r.wasserzeichen);
    const n = Math.min(withWm.length, withoutWm.length);
    for (let i = 0; i < n; i++) {
      const pairId = crypto.randomUUID();
      setPairId.run(pairId, withWm[i].id);
      setPairId.run(pairId, withoutWm[i].id);
    }
    for (let i = n; i < withWm.length; i++) setPairId.run(crypto.randomUUID(), withWm[i].id);
    for (let i = n; i < withoutWm.length; i++) setPairId.run(crypto.randomUUID(), withoutWm[i].id);
  }
}
// Upload-Plan Schritt 10 (Grundlage, Oberfläche folgt später): Farbvarianten
// wie "Blau"/"Rot" - freier Text statt fester Liste, damit keine
// Obergrenze entsteht. NULL = kein Teil einer Varianten-Gruppe. Gilt pro
// Bild, nicht pro Design - eine Gruppe kann Design, Motive und Hintergrund
// gleichzeitig enthalten.
ensureColumn("design_images", "gruppe", "TEXT");
ensureColumn("orders", "kunde_instagram", "TEXT");
ensureColumn("orders", "kunde_whatsapp", "TEXT");
ensureColumn("orders", "kontakt_praeferenz", "TEXT NOT NULL DEFAULT 'E-Mail'");
// Testkonzept Test A: Art des Eintrags (Fehler/Umständlich/Fehlt/Idee) und
// automatisch mitgeschickter Kontext (Seite + ggf. Design-ID), von wo der
// Eintrag kam - macht aus "Hochladen ist umständlich" ein "aus der
// Bilderverwaltung von TD-0042" statt einer bloßen Ahnung bei der Auswertung.
ensureColumn("feedback", "art", "TEXT");
ensureColumn("feedback", "kontext", "TEXT");
// Von der Kundin (öffentliche Anfrage) oder Mitarbeitenden (Bestellung
// neu/bearbeiten) pro zugeordnetem Design ausgewählte Bild-Varianten, als
// JSON-Array der nummerierten Labels (z.B. ["1. Design", "3. Motiv 2"]).
// NULL/kein Eintrag = keine spezifische Variante gewünscht (ganzes Design).
ensureColumn("order_designs", "varianten", "TEXT");
// Welche Preisbausteine (design/png/hintergrund) für dieses Design in dieser
// Bestellung im Angebot enthalten sind - JSON-Array, z.B. ["design","png"].
// NULL/kein Eintrag = noch nicht konfiguriert, Angebot-Schritt setzt dann
// standardmäßig nur "design" (entspricht dem alten Verhalten vor Einführung
// der gestaffelten Preise).
ensureColumn("order_designs", "preisoptionen", "TEXT");
// Farbexklusive Varianten: JSON-Array aus {gruppe, bestandteil}, das
// festhält, welche Gruppe/Preisbaustein-Kombinationen in dieser Bestellung
// exklusiv verkauft werden. Wird erst beim Abschließen der Bestellung in
// design_lizenzen übernommen (siehe completeOrder) - ein offenes Angebot
// reserviert noch nichts, genau wie preisoptionen auch erst zählt, wenn die
// Bestellung tatsächlich abgeschlossen wird.
ensureColumn("order_designs", "exklusiveGruppen", "TEXT");
// Neuer Schritt "Auf Bezahlung warten" zwischen Rechnung und Download - für
// Bestellungen, die schon weiter waren als der neue Schritt (schritt_download
// bereits erledigt), rückwirkend als erledigt markieren, sonst würden sie
// durch den neuen Zwischenschritt scheinbar wieder zurückfallen.
if (ensureColumn("orders", "schritt_bezahlung", "INTEGER NOT NULL DEFAULT 0")) {
  db.prepare("UPDATE orders SET schritt_bezahlung = 1 WHERE schritt_download = 1").run();
}
// Markiert die Beleg-Bestellungen aus addManualLizenz (Rechte-Vergabe außerhalb
// des Bestellassistenten) - die durchlaufen keinen echten Schritt-Ablauf und
// sollen deshalb nicht zwischen echten Kundenbestellungen auftauchen (siehe
// listOrders).
ensureColumn("orders", "manuell", "INTEGER NOT NULL DEFAULT 0");
// Ob wir die Kundin auf Webseite/Instagram nennen dürfen (z.B. "getragen
// von..."), von ihr beim Bestätigen im Order-Portal beantwortet - NULL
// (Default) heißt "nicht gefragt/keine Angabe", nicht "Nein", damit alte
// Bestellungen ohne diese Frage nicht fälschlich als abgelehnt gelten.
ensureColumn("orders", "nennung_erlaubt", "INTEGER");
// Nachweis wie terms_text_snapshot: welcher genaue Fragetext zugestimmt
// wurde, falls der Text später mal angepasst wird.
ensureColumn("orders", "nennung_text_snapshot", "TEXT");
// Rabatt gilt für die gesamte Bestellung (nicht pro Design) - Prozent oder
// fester Euro-Betrag. Nur fürs eigene System nachgebildet (die tatsächliche
// Rechnung mit Rabatt entsteht weiterhin manuell in sevdesk), sonst würden
// Bestellungen-Übersicht und Kunden-Bestätigungsseite einen zu hohen
// Gesamtpreis zeigen. rabatt_typ NULL = kein Rabatt.
ensureColumn("orders", "rabatt_typ", "TEXT");
ensureColumn("orders", "rabatt_wert", "REAL");
// Kunde hat schon über Instagram (o.ä.) gekauft, das Design ist aber noch
// nicht im System - Erinnerung, das nachzutragen, sobald das Design
// hochgeladen ist (siehe auch design_lizenzen/addManualLizenz für die
// Exklusivitäts-Seite davon).
ensureColumn("orders", "design_ausstehend", "INTEGER NOT NULL DEFAULT 0");
// Testbestellung beim Ausprobieren des Systems - erhöht beim Abschließen
// bewusst NICHT den echten Verkaufszähler und vergibt keine echten
// Exklusivrechte (siehe completeOrder), damit Testläufe keine echten Zahlen
// verfälschen oder eine Farbvariante fälschlich blockieren.
ensureColumn("orders", "ist_test", "INTEGER NOT NULL DEFAULT 0");
// Referenz auf die Kundennummer in sevDesk (manuell eingetragen, keine
// API-Anbindung) - macht sichtbar, wenn dieselbe Kundin mehrere Bestellungen
// hat, auch wenn der Name mal anders geschrieben wurde, ohne eine eigene
// Kunden-Verwaltung aufzubauen.
ensureColumn("orders", "sevdesk_kundennummer", "TEXT");

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
// der Feldverschlüsselung) verschlüsseln. looksEncrypted() PRO FELD (nicht
// pauschal am Namen-Feld) erkennt bereits migrierte Werte - eine frühere
// Version prüfte das nur an kunde_name und verschlüsselte dann alle 6 Felder
// pauschal mit, was bei Zeilen mit uneinheitlichem Stand (z.B. kunde_name
// noch Klartext, kunde_instagram aber schon verschlüsselt) zur versehentlichen
// Doppel-Verschlüsselung einzelner Felder führte (siehe repairDoubleEncryptedOrderFields()).
// Absichtlich eine eigene, feste Liste statt ORDER_PII_FIELDS zu verwenden -
// diese Migration ist nur für das historische Klartext-Aufräumen der
// UNTEN fest verdrahteten SELECT/UPDATE-Spalten gedacht. Ein später neu
// hinzugefügtes PII-Feld wie sevdesk_kundennummer hat keine solche
// Klartext-Altlast (verschlüsselt schon von Anfang an über updateOrder) und
// würde hier nur, weil es nicht selektiert wird, als "undefined" und damit
// fälschlich immer als "noch zu migrieren" durchgehen - bei jedem
// Serverstart ein sinnloses Re-Update aller Bestellungen.
const LEGACY_ORDER_PII_MIGRATION_FIELDS = ["kunde_name", "kunde_email", "kunde_instagram", "kunde_whatsapp", "notiz", "terms_confirmed_ip"];

function migrateEncryptOrderFields() {
  const rows = db.prepare(`
    SELECT id, kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, notiz, terms_confirmed_ip
    FROM orders
  `).all();
  const toMigrate = rows.filter((row) => LEGACY_ORDER_PII_MIGRATION_FIELDS.some((field) => !looksEncrypted(row[field])));
  if (toMigrate.length === 0) return;
  const update = db.prepare(`
    UPDATE orders SET kunde_name = ?, kunde_email = ?, kunde_instagram = ?, kunde_whatsapp = ?, notiz = ?, terms_confirmed_ip = ?
    WHERE id = ?
  `);
  const migrate = db.transaction((rows) => {
    for (const row of rows) {
      update.run(
        looksEncrypted(row.kunde_name) ? row.kunde_name : encryptField(row.kunde_name),
        looksEncrypted(row.kunde_email) ? row.kunde_email : encryptField(row.kunde_email),
        looksEncrypted(row.kunde_instagram) ? row.kunde_instagram : encryptField(row.kunde_instagram),
        looksEncrypted(row.kunde_whatsapp) ? row.kunde_whatsapp : encryptField(row.kunde_whatsapp),
        looksEncrypted(row.notiz) ? row.notiz : encryptField(row.notiz),
        looksEncrypted(row.terms_confirmed_ip) ? row.terms_confirmed_ip : encryptField(row.terms_confirmed_ip),
        row.id
      );
    }
  });
  migrate(toMigrate);
}
migrateEncryptOrderFields();

// Einmalige Reparatur: einzelne PII-Felder, die durch die frühere, an
// kunde_name gekoppelte Migration versehentlich doppelt verschlüsselt wurden,
// bekommen eine Verschlüsselungsschicht entfernt. looksEncrypted() nach dem
// Entschlüsseln erkennt zuverlässig eine verbleibende äußere Schicht - ein
// echter Klartext (Name, Handynummer, Instagram-Handle) trifft das enge
// "base64:base64:base64"-Format praktisch nie zufällig.
function repairDoubleEncryptedOrderFields() {
  const rows = db.prepare(`
    SELECT id, kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, notiz, terms_confirmed_ip
    FROM orders
  `).all();
  const update = db.prepare(`
    UPDATE orders SET kunde_name = ?, kunde_email = ?, kunde_instagram = ?, kunde_whatsapp = ?, notiz = ?, terms_confirmed_ip = ?
    WHERE id = ?
  `);
  const repair = db.transaction((rows) => {
    for (const row of rows) {
      let changed = false;
      const fixed = {};
      for (const field of LEGACY_ORDER_PII_MIGRATION_FIELDS) {
        let value = row[field];
        // Mehrschichtig doppelt-verschlüsselte Werte (sollte es eigentlich
        // nicht geben, aber sicherheitshalber mit Obergrenze statt Endlosschleife).
        for (let i = 0; i < 5 && looksEncrypted(value); i++) {
          const once = decryptField(value);
          if (once === null || !looksEncrypted(once)) break;
          value = once;
          changed = true;
        }
        fixed[field] = value;
      }
      if (changed) {
        update.run(fixed.kunde_name, fixed.kunde_email, fixed.kunde_instagram, fixed.kunde_whatsapp, fixed.notiz, fixed.terms_confirmed_ip, row.id);
      }
    }
  });
  repair(rows);
}
repairDoubleEncryptedOrderFields();

migrateFromLegacyJson();
normalizeExistingTags();

// K5 (Ausbau-Dokument): "Unsortiert" muss als Ausweg existieren, BEVOR die
// Kategorie im Formular zur reinen Auswahlliste ohne Freitext wird (Ausbau
// 1.6) - sonst blockiert die Liste genau den Fall, für den sie gedacht ist.
// Einmalig nachziehen, unabhängig davon ob die Kategorien gerade frisch
// geseedet wurden (s.o.) oder schon länger bestehen.
if (!db.prepare("SELECT 1 FROM categories WHERE name = ?").get("Unsortiert")) {
  db.prepare("INSERT INTO categories (name) VALUES (?)").run("Unsortiert");
}

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
    INSERT INTO design_images (design_id, kategorie, typ, bezeichnung, image, sichtbar, ist_hauptbild, sortOrder, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Design', 'Hauptbild', ?, 1, 1, 1, ?)
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
  // Bilder-verwalten-Seite pro Design aufrufen muss. Tags kommen als "||"-
  // getrennte Liste aus einer Subquery mit, statt für jedes Design einzeln
  // nachzuladen (N+1) - bei potenziell hunderten Designs in der Übersicht.
  return db.prepare(`
    SELECT designs.*, design_images.qualityWarning AS qualityWarning, design_images.previewImage AS previewImage,
      (SELECT GROUP_CONCAT(t.name, '||') FROM design_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.design_id = designs.id) AS tagsRaw
    FROM designs
    LEFT JOIN design_images ON design_images.design_id = designs.id AND design_images.ist_hauptbild = 1
    ORDER BY designs.rowid DESC
  `).all().map(({ tagsRaw, ...d }) => ({ ...d, tags: tagsRaw ? tagsRaw.split("||") : [] }));
}

function getDesign(id) {
  const design = db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
  if (!design) return design;
  return { ...design, tags: getDesignTags(id) };
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
  const onlineFlag = design.online === undefined ? 1 : (design.online ? 1 : 0);
  db.prepare(`
    INSERT INTO designs (id, name, description, category, price, pricePng, priceHintergrund, status, kaufLink, driveLink, instagramLink, image, online, onlineSetAt, uploadDurationMs, serverProcessingMs, groesseCm, verkaufszaehler, auswertungsNotiz, createdAt)
    VALUES (@id, @name, @description, @category, @price, @pricePng, @priceHintergrund, @status, @kaufLink, @driveLink, @instagramLink, @image, @online, @onlineSetAt, @uploadDurationMs, @serverProcessingMs, @groesseCm, 0, @auswertungsNotiz, @createdAt)
  `).run({
    id: design.id,
    name: design.name,
    description: design.description || "",
    category: design.category,
    // Standardwerte 10€/6€/5€, falls beim Hochladen nichts (anderes) angegeben wurde.
    price: design.price ?? 10,
    pricePng: design.pricePng ?? 6,
    priceHintergrund: design.priceHintergrund ?? 5,
    status: design.status,
    kaufLink: design.kaufLink || "",
    driveLink: design.driveLink || "",
    instagramLink: design.instagramLink || "",
    image: design.image,
    online: onlineFlag,
    onlineSetAt: onlineFlag ? design.createdAt : null,
    uploadDurationMs: design.uploadDurationMs || 0,
    serverProcessingMs: design.serverProcessingMs || 0,
    groesseCm: design.groesseCm || 20,
    auswertungsNotiz: design.auswertungsNotiz || "",
    createdAt: design.createdAt,
  });
  db.prepare(`
    INSERT INTO design_images (design_id, kategorie, typ, bezeichnung, image, previewImage, sichtbar, ist_hauptbild, qualityWarning, sortOrder, pairId, createdAt)
    VALUES (?, 'Mit Wasserzeichen', 'Design', 'Hauptbild', ?, ?, 1, 1, ?, 1, ?, ?)
  `).run(design.id, design.image, design.previewImage || null, design.qualityWarning || null, design.pairId || null, design.createdAt);
  if (design.tags && design.tags.length > 0) setDesignTags(design.id, design.tags);
  return getDesign(design.id);
}

// Zählt einen weiteren Upload-Vorgang zu einem bestehenden Design dazu (z.B.
// nachträglich Bilder über die Bilder-Verwaltung ergänzt) - addiert statt zu
// überschreiben, damit die Gesamt-Upload-Dauer über alle Vorgänge zu diesem
// Design erhalten bleibt.
function addUploadTiming(id, { uploadDurationMs, serverProcessingMs, canvaDurationMs }) {
  db.prepare(`
    UPDATE designs SET uploadDurationMs = uploadDurationMs + ?, serverProcessingMs = serverProcessingMs + ?, canvaDurationMs = canvaDurationMs + ?
    WHERE id = ?
  `).run(uploadDurationMs || 0, serverProcessingMs || 0, canvaDurationMs || 0, id);
}

const DESIGN_UPDATE_FIELDS = ["name", "description", "category", "price", "pricePng", "priceHintergrund", "status", "kaufLink", "driveLink", "instagramLink", "online", "groesseCm", "auswertungsNotiz"];

function updateDesign(id, changes) {
  const existing = db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
  if (!existing) return null;

  const fields = Object.keys(changes).filter((k) => DESIGN_UPDATE_FIELDS.includes(k));
  const values = { ...changes };
  // Erster Wechsel auf online=1 setzt einmalig onlineSetAt - Grundlage für
  // die Testkonzept-Auswertung "Dauer von Anlegen bis Online". Danach nicht
  // mehr verändert, auch nicht bei späterem Offline-/wieder Online-Schalten.
  if (fields.includes("online") && Number(changes.online) === 1 && !existing.onlineSetAt) {
    fields.push("onlineSetAt");
    values.onlineSetAt = new Date().toISOString();
  }
  if (fields.length > 0) {
    const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
    db.prepare(`UPDATE designs SET ${setClause} WHERE id = @id`).run({ ...values, id });
  }
  if (changes.tags !== undefined) setDesignTags(id, changes.tags);
  return getDesign(id);
}

function deleteDesign(id) {
  const target = db.prepare("SELECT * FROM designs WHERE id = ?").get(id);
  if (!target) return null;
  // order_designs und design_lizenzen referenzieren designs bewusst OHNE ON
  // DELETE CASCADE (siehe Schema oben) - ein Design, das bereits bestellt
  // wurde oder für das Rechte-/Exklusivitätsnachweise bestehen, darf nicht
  // gelöscht werden, sonst geht echte Bestell-/Rechtehistorie verloren. Ohne
  // diesen Check wirft SQLite hier einen FOREIGN KEY-Fehler, der unbehandelt
  // bis zum Prozess durchschlägt und den ganzen Server crasht.
  const usedInOrder = db.prepare("SELECT 1 FROM order_designs WHERE design_id = ? LIMIT 1").get(id);
  const hasLizenz = db.prepare("SELECT 1 FROM design_lizenzen WHERE design_id = ? LIMIT 1").get(id);
  if (usedInOrder || hasLizenz) {
    const err = new Error("Design kann nicht gelöscht werden, da es bereits in mindestens einer Bestellung verwendet wurde.");
    err.status = 409;
    throw err;
  }
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
      db.prepare("UPDATE design_tags SET design_id = ? WHERE design_id = ?").run(newId, oldId);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return getDesign(newId);
}

// --- Bild-Varianten pro Design ---

function getDesignImages(designId) {
  return db.prepare("SELECT * FROM design_images WHERE design_id = ? ORDER BY sortOrder ASC, rowid ASC").all(designId);
}

function addDesignImage({ design_id, wasserzeichen, typ, bezeichnung, image, previewImage, sichtbar, qualityWarning, pairId }) {
  const wz = wasserzeichen ? 1 : 0;
  const hg = typImpliesHintergrundVariante(typ) ? 1 : 0;
  const maxOrder = db.prepare("SELECT MAX(sortOrder) AS m FROM design_images WHERE design_id = ?").get(design_id).m || 0;
  const info = db.prepare(`
    INSERT INTO design_images (design_id, kategorie, wasserzeichen, hintergrundVariante, typ, bezeichnung, image, previewImage, sichtbar, ist_hauptbild, qualityWarning, sortOrder, pairId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(design_id, kategorieLabel(wz, typ), wz, hg, typ || null, bezeichnung || "", image, previewImage || null, sichtbar ? 1 : 0, qualityWarning || null, maxOrder + 1, pairId || null, new Date().toISOString());
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

// Nachträgliche Korrektur der Kategorie/Bezeichnung (z.B. versehentlich "Mit
// Wasserzeichen" statt "Ohne Wasserzeichen" gewählt, oder freihändige
// Umbenennung wie "Hintergrundvariante 3") - gibt die alte Zeile mit zurück,
// damit der Aufrufer die sortierte Ablage (uploads-sorted/) entsprechend
// verschieben/umbenennen kann.
function setDesignImageEigenschaften(imageId, { wasserzeichen, typ, bezeichnung }) {
  const existing = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!existing) return null;
  const wz = wasserzeichen === undefined ? existing.wasserzeichen : (wasserzeichen ? 1 : 0);
  const newTyp = typ === undefined ? existing.typ : typ;
  const hg = typ === undefined ? existing.hintergrundVariante : (typImpliesHintergrundVariante(typ) ? 1 : 0);
  const newBezeichnung = bezeichnung === undefined ? existing.bezeichnung : bezeichnung;
  db.prepare("UPDATE design_images SET wasserzeichen = ?, hintergrundVariante = ?, typ = ?, bezeichnung = ?, kategorie = ? WHERE id = ?")
    .run(wz, hg, newTyp, newBezeichnung, kategorieLabel(wz, newTyp), imageId);
  return { old: existing, updated: db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId) };
}

// Vertauscht die Sortierposition eines Bilds mit seinem Nachbarn in der
// aktuellen Anzeigereihenfolge (Admin-Verwaltung + öffentliche Galerie nutzen
// dieselbe getDesignImages()-Sortierung). Am jeweiligen Rand ein No-Op.
const moveDesignImage = db.transaction((imageId, direction) => {
  const existing = db.prepare("SELECT * FROM design_images WHERE id = ?").get(imageId);
  if (!existing) return null;
  const siblings = getDesignImages(existing.design_id);
  const idx = siblings.findIndex((img) => img.id === existing.id);
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= siblings.length) return siblings;
  const other = siblings[swapIdx];
  db.prepare("UPDATE design_images SET sortOrder = ? WHERE id = ?").run(other.sortOrder, existing.id);
  db.prepare("UPDATE design_images SET sortOrder = ? WHERE id = ?").run(existing.sortOrder, other.id);
  return getDesignImages(existing.design_id);
});

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

// --- Kachel-Bearbeitung: beide Zeilen eines Paars (mit + ohne Wasserzeichen)
// gemeinsam ändern, statt Typ/Bezeichnung zweimal einzutragen (Schritt 8) ---

// Setzt Typ/Bezeichnung für BEIDE Zeilen eines Paars auf einmal. Gibt beide
// alten Zeilen mit zurück, damit der Aufrufer die sortierte Ablage für beide
// Varianten nachziehen kann, falls sich Typ oder Bezeichnung geändert haben.
function setPairEigenschaften(designId, pairId, { typ, bezeichnung, gruppe }) {
  const members = db.prepare("SELECT * FROM design_images WHERE design_id = ? AND pairId = ?").all(designId, pairId);
  if (members.length === 0) return null;
  const updated = members.map((existing) => {
    const newTyp = typ === undefined ? existing.typ : typ;
    const hg = typ === undefined ? existing.hintergrundVariante : (typImpliesHintergrundVariante(typ) ? 1 : 0);
    const newBezeichnung = bezeichnung === undefined ? existing.bezeichnung : bezeichnung;
    const newGruppe = gruppe === undefined ? existing.gruppe : gruppe || null;
    db.prepare("UPDATE design_images SET hintergrundVariante = ?, typ = ?, bezeichnung = ?, kategorie = ?, gruppe = ? WHERE id = ?")
      .run(hg, newTyp, newBezeichnung, kategorieLabel(existing.wasserzeichen, newTyp), newGruppe, existing.id);
    return db.prepare("SELECT * FROM design_images WHERE id = ?").get(existing.id);
  });
  return { old: members, updated };
}

// Löscht beide Zeilen eines Paars auf einmal. Blockiert wie beim Löschen
// einer einzelnen Zeile, wenn eine der beiden das Hauptbild ist.
const deleteDesignImagePair = db.transaction((designId, pairId) => {
  const members = db.prepare("SELECT * FROM design_images WHERE design_id = ? AND pairId = ?").all(designId, pairId);
  if (members.length === 0) return null;
  if (members.some((m) => m.ist_hauptbild)) {
    const err = new Error("Das Hauptbild kann nicht gelöscht werden - erst ein anderes Bild als Hauptbild festlegen");
    err.status = 400;
    throw err;
  }
  db.prepare("DELETE FROM design_images WHERE design_id = ? AND pairId = ?").run(designId, pairId);
  return members;
});

// Ziehen statt Pfeiltasten (Schritt 8): nimmt die komplette neue Reihenfolge
// als Liste von pairId entgegen, ein einziger Aufruf statt eines Requests pro
// Verschiebung. Beide Zeilen eines Paars bekommen dieselbe sortOrder, die
// öffentliche Seite sieht ohnehin nur die Wasserzeichen-Zeile.
const reorderDesignImagePairs = db.transaction((designId, orderedPairIds) => {
  const update = db.prepare("UPDATE design_images SET sortOrder = ? WHERE design_id = ? AND pairId = ?");
  orderedPairIds.forEach((pairId, i) => update.run(i + 1, designId, pairId));
  return getDesignImages(designId);
});

// Mehrfachauswahl: mehrere Bilder auf einmal online/offline schalten statt
// Checkbox für Checkbox. Beim Online-Schalten (sichtbar=true) zusätzlich
// serverseitig auf Wasserzeichen-Zeilen beschränkt - keine Massenaktion darf
// versehentlich eine Verkaufsdatei sichtbar machen (dieselbe Regel wie beim
// einzelnen Sichtbarkeits-Schalter, siehe setDesignImageVisibility-Route).
const setDesignImagesVisibilityBulk = db.transaction((imageIds, sichtbar) => {
  const stmt = sichtbar
    ? db.prepare("UPDATE design_images SET sichtbar = 1 WHERE id = ? AND wasserzeichen = 1")
    : db.prepare("UPDATE design_images SET sichtbar = 0 WHERE id = ?");
  for (const id of imageIds) stmt.run(id);
});

// --- Feedback-Notizen (Dashboard) ---

// Testkonzept Test A: entscheidend für die Auswertung nach dem Testlauf -
// Fehler gehören sofort behoben, Umständliches wandert in Schritt 8 des
// Upload-Plans, Fehlendes ins Ausbau-Dokument.
const FEEDBACK_ART_VALUES = ["Fehler", "Umständlich", "Fehlt", "Idee"];

function listFeedback() {
  return db.prepare("SELECT * FROM feedback ORDER BY (status = 'offen') DESC, rowid DESC").all();
}

function addFeedback({ text, art, kontext }) {
  const info = db
    .prepare("INSERT INTO feedback (text, art, kontext, status, createdAt) VALUES (?, ?, ?, 'offen', ?)")
    .run(text, art || null, kontext || null, new Date().toISOString());
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

// --- Tags ---
// Im Gegensatz zu Kategorien (feste, vorher anzulegende Liste) sind Tags
// frei: neue Tags entstehen einfach dadurch, dass sie einem Design zugewiesen
// werden (siehe setDesignTags) - kein separater "Tag zuerst anlegen"-Schritt.

function getTags() {
  return db.prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE ASC").all().map((r) => r.name);
}

// Schreibkonvention aus Ausbau 1.6/1.8 (Phase 0): durchgehend Kleinschreibung,
// Leerzeichen am Rand entfernt - ohne das entstehen Dubletten wie "Blume"
// und "blume", die später mühsam von Hand zusammenzuführen sind.
function normalizeTagName(name) {
  return String(name).trim().toLowerCase();
}

function getOrCreateTagId(name) {
  const normalized = normalizeTagName(name);
  const existing = db.prepare("SELECT id FROM tags WHERE name = ?").get(normalized);
  if (existing) return existing.id;
  return db.prepare("INSERT INTO tags (name) VALUES (?)").run(normalized).lastInsertRowid;
}

// Einmalige Migration für Tags aus der Zeit vor der Schreibkonvention
// (Kleinschreibung, Phase 0). Kollidieren dabei zwei Tags auf denselben
// normalisierten Namen (z.B. "Blume" und "blume"), werden sie zusammengeführt:
// alle design_tags-Zuordnungen wandern zum zuerst angelegten Tag, der jüngere
// wird entfernt. Danach ein No-Op bei jedem weiteren Start.
// Als function-Deklaration (statt const = db.transaction(...)) definiert,
// damit der Aufruf weiter oben beim Modul-Start unabhängig von der
// Reihenfolge im Datei-Quelltext funktioniert (function-Deklarationen werden
// gehoistet, const-Zuweisungen nicht).
function normalizeExistingTags() {
  const run = db.transaction(() => {
    const rows = db.prepare("SELECT id, name FROM tags ORDER BY id ASC").all();
    const survivorByName = new Map();
    for (const row of rows) {
      const normalized = normalizeTagName(row.name);
      // Erste Zeile mit diesem normalisierten Namen wird zum Überlebenden,
      // egal ob ihr eigener Name schon normalisiert war oder nicht - jede
      // WEITERE Zeile mit demselben normalisierten Namen wird in sie
      // zusammengeführt. Nur auf "hat sich der Name geändert" zu prüfen
      // hätte den Fall übersehen, dass zwei bereits-kleingeschriebene
      // Schreibweisen wie "blume" (id 3) nach "Blume" (id 1) kollidieren.
      if (!survivorByName.has(normalized)) {
        if (normalized !== row.name) {
          db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(normalized, row.id);
        }
        survivorByName.set(normalized, row.id);
        continue;
      }
      const survivorId = survivorByName.get(normalized);
      db.prepare(
        "INSERT OR IGNORE INTO design_tags (design_id, tag_id) SELECT design_id, ? FROM design_tags WHERE tag_id = ?"
      ).run(survivorId, row.id);
      db.prepare("DELETE FROM design_tags WHERE tag_id = ?").run(row.id);
      db.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
    }
  });
  run();
}

function getDesignTags(designId) {
  return db.prepare(`
    SELECT t.name FROM tags t
    JOIN design_tags dt ON dt.tag_id = t.id
    WHERE dt.design_id = ?
    ORDER BY t.name COLLATE NOCASE ASC
  `).all(designId).map((r) => r.name);
}

// Ersetzt die komplette Tag-Zuordnung eines Designs durch die übergebene
// Liste (wie setOrderDesigns bei Varianten) - leere/doppelte Einträge werden
// rausgefiltert, unbekannte Tag-Namen automatisch neu angelegt.
const setDesignTags = db.transaction((designId, tagNames) => {
  db.prepare("DELETE FROM design_tags WHERE design_id = ?").run(designId);
  const insert = db.prepare("INSERT OR IGNORE INTO design_tags (design_id, tag_id) VALUES (?, ?)");
  const uniqueNames = [...new Set((tagNames || []).map((t) => String(t).trim()).filter(Boolean))];
  for (const name of uniqueNames) {
    insert.run(designId, getOrCreateTagId(name));
  }
});

// Legt einen Tag ohne Zuordnung zu einem Design an (z.B. vorab in der
// Tag-Verwaltung), sonst entstehen Tags sonst nur implizit über setDesignTags.
function addTag(name) {
  getOrCreateTagId(name);
  return getTags();
}

// Umbenennen wirkt sich automatisch überall aus, wo der Tag verwendet wird -
// anders als bei Kategorien reicht die eine Zeile in der tags-Tabelle,
// design_tags verweist nur per tag_id, keine Textkopie zum Nachziehen.
function renameTag(oldName, newName) {
  const result = db.prepare("UPDATE tags SET name = ? WHERE name = ?").run(normalizeTagName(newName), oldName);
  if (result.changes === 0) return null;
  return getTags();
}

function deleteTag(name) {
  const result = db.prepare("DELETE FROM tags WHERE name = ?").run(name);
  if (result.changes === 0) return null;
  return getTags();
}

// --- Bestellungen ---

function createOrder({ kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, ist_test }) {
  const info = db.prepare(`
    INSERT INTO orders (kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, bestelldatum, status, access_token, token_created_at, ist_test)
    VALUES (?, ?, ?, ?, ?, ?, 'Offen', ?, ?, ?)
  `).run(
    encryptField(kunde_name),
    encryptField(kunde_email),
    encryptField(kunde_instagram || ""),
    encryptField(kunde_whatsapp || ""),
    kontakt_praeferenz || "E-Mail",
    new Date().toISOString(),
    generateOrderToken(),
    new Date().toISOString(),
    ist_test ? 1 : 0
  );
  return getOrder(info.lastInsertRowid);
}

// variantenMap: { [designId]: string[] } - von der Kundin (öffentliche
// Anfrage) oder Mitarbeitenden (Bestellung neu/bearbeiten) pro Design
// ausgewählte Varianten-Labels, optional.
function setOrderDesigns(orderId, designIds, variantenMap = {}) {
  const setDesigns = db.transaction((ids, varianten) => {
    // preisoptionen wird an anderer Stelle (Angebot-Schritt) gepflegt - beim
    // Neuzuordnen von Designs hier erhalten bleiben, statt beim
    // Löschen+Neuanlegen der Zeilen verloren zu gehen.
    const existingPreisoptionen = new Map(
      db.prepare("SELECT design_id, preisoptionen FROM order_designs WHERE order_id = ?").all(orderId)
        .map((r) => [r.design_id, r.preisoptionen])
    );
    db.prepare("DELETE FROM order_designs WHERE order_id = ?").run(orderId);
    const insert = db.prepare("INSERT INTO order_designs (order_id, design_id, varianten, preisoptionen) VALUES (?, ?, ?, ?)");
    for (const designId of ids) {
      const selected = Array.isArray(varianten[designId]) ? varianten[designId].filter((v) => typeof v === "string") : [];
      insert.run(orderId, designId, selected.length > 0 ? JSON.stringify(selected) : null, existingPreisoptionen.get(designId) || null);
    }
    // Wenn der Kunde die Bestellung schon über das Order-Portal bestätigt
    // hatte, macht eine nachträgliche Design-Änderung diese Bestätigung
    // ungültig - Kunde muss die (jetzt andere) Bestellung erneut bestätigen.
    // nennung_erlaubt gehört zum selben Bestätigungsakt und wird deshalb
    // ebenfalls zurückgesetzt (siehe Kommentar an regenerateOrderToken).
    db.prepare(`
      UPDATE orders SET terms_confirmed_at = NULL, terms_confirmed_ip = NULL, terms_text_snapshot = NULL,
        nennung_erlaubt = NULL, nennung_text_snapshot = NULL
      WHERE id = ? AND terms_confirmed_at IS NOT NULL
    `).run(orderId);
  });
  setDesigns(designIds, variantenMap || {});
  return getOrder(orderId);
}

const PREISOPTIONEN_VALUES = ["design", "png", "hintergrund"];

// Legt fest, welche Preisbausteine für ein Design in dieser Bestellung im
// Angebot enthalten sind (addierend, siehe berechneterPreis in designsWithVarianten).
function setOrderDesignPreisoptionen(orderId, designId, optionen) {
  const valid = Array.isArray(optionen) ? optionen.filter((o) => PREISOPTIONEN_VALUES.includes(o)) : [];
  const json = valid.length > 0 ? JSON.stringify(valid) : null;
  const info = db.prepare("UPDATE order_designs SET preisoptionen = ? WHERE order_id = ? AND design_id = ?").run(json, orderId, designId);
  return info.changes > 0;
}

// Prüft, ob eine der gewünschten Gruppe/Bestandteil-Kombinationen bereits
// exklusiv vergeben ist - nur abgeschlossene Bestellungen zählen (ein noch
// offenes Angebot reserviert nichts, siehe Kommentar an exklusiveGruppen
// oben). Gibt die betroffenen Einträge zurück, leeres Array = kein Konflikt.
function findExklusivKonflikte(designId, entries) {
  if (!entries || entries.length === 0) return [];
  const vergeben = db.prepare(`
    SELECT dl.gruppe, dl.bestandteil FROM design_lizenzen dl
    JOIN orders o ON o.id = dl.order_id
    WHERE dl.design_id = ? AND dl.exklusiv = 1 AND o.status = 'Erledigt'
  `).all(designId);
  return entries.filter((e) => vergeben.some((v) => (v.gruppe || "") === (e.gruppe || "") && v.bestandteil === e.bestandteil));
}

// Legt fest, welche Gruppe/Bestandteil-Kombinationen für dieses Design in
// dieser Bestellung exklusiv verkauft werden sollen. Der Aufrufer (Route)
// prüft vorher mit findExklusivKonflikte, ob das überhaupt noch frei ist.
function setOrderDesignExklusivitaet(orderId, designId, exklusiveGruppen) {
  const json = exklusiveGruppen && exklusiveGruppen.length > 0 ? JSON.stringify(exklusiveGruppen) : null;
  const info = db.prepare("UPDATE order_designs SET exklusiveGruppen = ? WHERE order_id = ? AND design_id = ?").run(json, orderId, designId);
  return info.changes > 0;
}

// Zählt, wie viele der in Schritt 2 gewählten Varianten vom Typ "Design"
// sind - jede Design-Variante (z.B. eine von 5-10 Farbvarianten desselben
// Designs) ist ein eigenes Verkaufsobjekt zum jeweiligen Design-Preis, nicht
// nur eine von mehreren Ansichten desselben einen Kaufs. PNG ("alle Motive")
// und Hintergrund sind dagegen Pauschalpreise, unabhängig davon, wie viele
// Motiv-/Hintergrund-Varianten ausgewählt wurden. Labels werden genauso
// aufgebaut wie variantLabel() im Client, damit derselbe String matcht.
function countDesignTypVarianten(designId, varianten) {
  if (!varianten || varianten.length === 0) return 0;
  const images = getDesignImages(designId).filter((img) => img.wasserzeichen);
  let count = 0;
  images.forEach((img, i) => {
    const typ = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
    const label = img.bezeichnung ? `${i + 1}. ${typ} – ${img.bezeichnung}` : `${i + 1}. ${typ}`;
    if (typ === "Design" && varianten.includes(label)) count++;
  });
  return count;
}

function designsWithVarianten(orderId) {
  return db.prepare(`
    SELECT d.*, od.varianten AS varianten, od.preisoptionen AS preisoptionen, od.exklusiveGruppen AS exklusiveGruppen FROM designs d
    JOIN order_designs od ON od.design_id = d.id
    WHERE od.order_id = ?
  `).all(orderId).map((d) => {
    // Noch nicht konfiguriert (NULL) = wie vor Einführung der gestaffelten
    // Preise nur der Design-Preis, kein automatisches Aufschlagen von
    // PNG/Hintergrund ohne bewusste Auswahl im Angebot-Schritt.
    const preisoptionen = d.preisoptionen ? JSON.parse(d.preisoptionen) : ["design"];
    const varianten = d.varianten ? JSON.parse(d.varianten) : [];
    // Keine spezifische Design-Variante ausgewählt (z.B. Design ohne
    // mehrere Farbvarianten, oder "leer = ganzes Design ohne Varianten")
    // zählt als 1, nicht als 0.
    const designVariantenAnzahl = Math.max(countDesignTypVarianten(d.id, varianten), 1);
    let berechneterPreis = 0;
    if (preisoptionen.includes("design")) berechneterPreis += (d.price || 0) * designVariantenAnzahl;
    if (preisoptionen.includes("png")) berechneterPreis += d.pricePng || 0;
    if (preisoptionen.includes("hintergrund")) berechneterPreis += d.priceHintergrund || 0;
    return {
      ...d,
      varianten,
      preisoptionen,
      exklusiveGruppen: d.exklusiveGruppen ? JSON.parse(d.exklusiveGruppen) : [],
      berechneterPreis,
      designVariantenAnzahl,
    };
  });
}

// Rabatt gilt für die gesamte Bestellung (Summe über alle Designs), nicht
// pro Design - deshalb hier und nicht in designsWithVarianten() berechnet.
function berechneRabattBetrag(subtotal, rabattTyp, rabattWert) {
  if (!rabattTyp || !rabattWert) return 0;
  if (rabattTyp === "prozent") return subtotal * (rabattWert / 100);
  if (rabattTyp === "euro") return rabattWert;
  return 0;
}

function attachOrderTotals(order, designs) {
  const subtotal = designs.reduce((sum, d) => sum + (d.berechneterPreis || 0), 0);
  const rabattBetrag = Math.min(berechneRabattBetrag(subtotal, order.rabatt_typ, order.rabatt_wert), subtotal);
  const gesamtBetrag = Math.max(subtotal - rabattBetrag, 0);
  return { ...order, designs, subtotal, rabattBetrag, gesamtBetrag };
}

function getOrder(id) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!order) return null;
  return decryptOrderRow(attachOrderTotals(order, designsWithVarianten(id)));
}

// --- Order-Portal (Kunden-Bestätigungsseite) ---

function getOrderByToken(token) {
  const order = db.prepare("SELECT * FROM orders WHERE access_token = ?").get(token);
  if (!order) return null;
  return decryptOrderRow(attachOrderTotals(order, designsWithVarianten(order.id)));
}

// nennungErlaubt: true/false = Kundin hat sich beim Bestätigen entschieden,
// undefined = Frage übersprungen (z.B. bei manueller Bestätigung durchs
// Personal) - bleibt dann NULL, nicht fälschlich "Nein". nennungTextSnapshot
// hält wie terms_text_snapshot fest, welcher genaue Fragetext zugestimmt
// wurde - wichtig als Nachweis, falls der Text später mal angepasst wird.
function confirmOrderTerms(orderId, ip, textSnapshot, nennungErlaubt, nennungTextSnapshot) {
  const info = db
    .prepare("UPDATE orders SET terms_confirmed_at = ?, terms_confirmed_ip = ?, terms_text_snapshot = ?, nennung_erlaubt = ?, nennung_text_snapshot = ? WHERE id = ?")
    .run(
      new Date().toISOString(),
      encryptField(ip),
      textSnapshot,
      nennungErlaubt === undefined ? null : (nennungErlaubt ? 1 : 0),
      nennungErlaubt === undefined ? null : nennungTextSnapshot,
      orderId
    );
  if (info.changes === 0) return null;
  return getOrder(orderId);
}

// Neuer Token nach Ablauf oder falls der alte Link versehentlich woanders
// gelandet ist - macht eine vorherige Bestätigung ungültig, da diese sich auf
// den alten Link bezog. nennung_erlaubt gehört zu demselben Bestätigungsakt
// wie die AGB (dieselbe Checkbox-Seite, derselbe Klick) und muss deshalb
// genauso zurückgesetzt werden - sonst bliebe eine Antwort stehen, die sich
// eigentlich auf eine jetzt ungültige Bestätigung bezog.
function regenerateOrderToken(orderId) {
  const info = db
    .prepare(`
      UPDATE orders SET access_token = ?, token_created_at = ?,
        terms_confirmed_at = NULL, terms_confirmed_ip = NULL, terms_text_snapshot = NULL,
        nennung_erlaubt = NULL, nennung_text_snapshot = NULL
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

// manuell=1 (Beleg-Bestellungen aus addManualLizenz) taucht hier absichtlich
// nie auf - das sind keine echten Kundenbestellungen und würden in der
// normalen Übersicht (z.B. mit Status "Erledigt" aber ohne Kunden-Bestätigung)
// nur verwirren. Direkt per getOrder(id) weiterhin abrufbar (siehe
// Design-Rechte-Seite, "Bestellung ansehen").
function listOrders(status) {
  const orders = status
    ? db.prepare("SELECT * FROM orders WHERE status = ? AND manuell = 0 ORDER BY bestelldatum DESC").all(status)
    : db.prepare("SELECT * FROM orders WHERE manuell = 0 ORDER BY bestelldatum DESC").all();

  const designCountStmt = db.prepare(`
    SELECT d.id, d.name FROM designs d
    JOIN order_designs od ON od.design_id = d.id
    WHERE od.order_id = ?
  `);
  return orders.map((order) => decryptOrderRow({ ...order, designs: designCountStmt.all(order.id) }));
}

const ORDER_STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt", "Storniert"];
const RABATT_TYP_VALUES = ["prozent", "euro"];
const ORDER_UPDATE_FIELDS = [
  "kunde_name",
  "kunde_email",
  "kunde_instagram",
  "kunde_whatsapp",
  "kontakt_praeferenz",
  "status",
  "notiz",
  "rabatt_typ",
  "rabatt_wert",
  "design_ausstehend",
  "ist_test",
  "sevdesk_kundennummer",
  ...ORDER_STEPS,
];
const KONTAKT_PRAEFERENZ_VALUES = ["E-Mail", "WhatsApp"];

// Freie Bearbeitung: im Gegensatz zu advanceOrderStep() keine Reihenfolge-Pflicht,
// Schritte lassen sich einzeln an-/abhaken, auch bei bereits abgeschlossenen Bestellungen.
// Der Verkaufszähler der Designs wird hier bewusst NICHT automatisch angepasst.
function updateOrder(id, changes) {
  const existing = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!existing) return null;

  const BOOLEAN_FIELDS = [...ORDER_STEPS, "design_ausstehend", "ist_test"];
  const sanitized = {};
  for (const key of Object.keys(changes)) {
    if (!ORDER_UPDATE_FIELDS.includes(key)) continue;
    if (BOOLEAN_FIELDS.includes(key)) sanitized[key] = changes[key] ? 1 : 0;
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

  // Erneute Konflikt-Prüfung: findExklusivKonflikte lief schon beim Setzen der
  // Exklusivität in Schritt 3 (siehe exklusivitaet-Route), aber zu dem
  // Zeitpunkt zählen nur bereits ABGESCHLOSSENE Bestellungen als vergeben.
  // Zwei parallel laufende Bestellungen für dieselbe Gruppe/denselben
  // Bestandteil können beide diese erste Prüfung unabhängig voneinander
  // bestehen, wenn keine von beiden schon abgeschlossen war - ohne diese
  // zweite Prüfung direkt vor dem Vergeben könnte dieselbe Exklusivität an
  // zwei Kundinnen gehen, wenn beide Bestellungen kurz hintereinander
  // abgeschlossen werden.
  for (const design of order.designs) {
    const entries = design.exklusiveGruppen || [];
    if (entries.length === 0) continue;
    const konflikte = findExklusivKonflikte(design.id, entries);
    if (konflikte.length > 0) {
      const err = new Error(
        `Design ${design.id}: Exklusivität wurde inzwischen anderweitig vergeben (Konflikt mit einer zwischenzeitlich abgeschlossenen Bestellung) - bitte in Schritt 3 prüfen und ggf. anpassen.`
      );
      err.status = 409;
      throw err;
    }
  }

  db.prepare("UPDATE orders SET status = 'Erledigt' WHERE id = ?").run(orderId);

  // Testbestellungen (siehe ensureColumn-Kommentar zu ist_test) durchlaufen
  // den kompletten Ablauf inkl. Konfliktprüfung oben, lösen aber bewusst
  // keine echten Nebenwirkungen aus - sonst würde jeder Testlauf des Wizards
  // die echten Verkaufszahlen verfälschen oder eine Farbvariante blockieren,
  // die eigentlich noch frei ist.
  if (!order.ist_test) {
    // Zählt verkaufte Varianten, nicht nur "wurde dieses Design in irgendeiner
    // Bestellung verkauft" - 2 gekaufte Design-Varianten (siehe
    // designVariantenAnzahl/countDesignTypVarianten) erhöhen den Zähler um 2,
    // nicht nur um 1. Wurde nur PNG oder Hintergrund gekauft (kein
    // Design-Baustein), zählt das wie bisher als 1 Verkauf.
    const incrementCounter = db.prepare(
      "UPDATE designs SET verkaufszaehler = verkaufszaehler + ? WHERE id = ?"
    );
    for (const design of order.designs) {
      const preisoptionen = design.preisoptionen && design.preisoptionen.length > 0 ? design.preisoptionen : ["design"];
      const anzahl = preisoptionen.includes("design") ? Math.max(design.designVariantenAnzahl || 1, 1) : 1;
      incrementCounter.run(anzahl, design.id);
    }

    // Exklusive Rechte werden erst jetzt, beim tatsächlichen Abschluss, fest
    // vergeben (siehe Kommentar an order_designs.exklusiveGruppen) - vorher war
    // es nur ein Vorschlag im Angebot, den ein Kunde nie bestätigt haben könnte.
    const insertLizenz = db.prepare(
      "INSERT INTO design_lizenzen (order_id, design_id, gruppe, bestandteil, exklusiv, createdAt) VALUES (?, ?, ?, ?, 1, ?)"
    );
    const now = new Date().toISOString();
    for (const design of order.designs) {
      for (const entry of design.exklusiveGruppen || []) {
        insertLizenz.run(orderId, design.id, entry.gruppe || null, entry.bestandteil, now);
      }
    }
  }

  return getOrder(orderId);
});

// Übersicht "Design-Rechte": wer hat an welcher Design-Variante exklusive
// Rechte. Kundendaten liegen verschlüsselt in orders - Entschlüsselung
// passiert hier beim Lesen, nicht über eine SQL-Suche auf den Klartext.
function getDesignLizenzenUebersicht() {
  const rows = db.prepare(`
    SELECT dl.id, dl.design_id, dl.gruppe, dl.bestandteil, dl.createdAt,
           d.name AS designName, d.category AS designCategory,
           o.id AS order_id, o.kunde_name, o.kunde_email
    FROM design_lizenzen dl
    JOIN designs d ON d.id = dl.design_id
    JOIN orders o ON o.id = dl.order_id
    WHERE dl.exklusiv = 1
    ORDER BY dl.createdAt DESC
  `).all();
  return rows.map((r) => ({
    ...r,
    kunde_name: decryptField(r.kunde_name),
    kunde_email: decryptField(r.kunde_email),
  }));
}

// Nimmt eine vergebene Exklusivität zurück (z.B. Testdaten aufräumen oder
// eine irrtümliche Vergabe korrigieren) - löscht nur den Lizenz-Eintrag,
// die zugehörige Bestellung bleibt unangetastet als Beleg erhalten.
function revokeLizenz(id) {
  const info = db.prepare("DELETE FROM design_lizenzen WHERE id = ?").run(id);
  return info.changes > 0;
}

// Rechte-Vergabe außerhalb des Bestellassistenten - z.B. wenn ein Verkauf
// persönlich/außerhalb des Systems vereinbart wurde und nachträglich als
// exklusiv erfasst werden muss. Legt dafür eine minimale, bereits
// abgeschlossene Bestellung an (nur um die Kundenzuordnung wie bei jeder
// anderen Rechte-Vergabe nachvollziehbar zu dokumentieren), ohne den
// vollen Schritt-Ablauf des Wizards zu durchlaufen. Nur "design" ist
// exklusiv möglich (siehe Validierung in server-admin.js).
const addManualLizenz = db.transaction(({ designId, gruppe, kundeName, notiz }) => {
  const design = db.prepare("SELECT id FROM designs WHERE id = ?").get(designId);
  if (!design) {
    const err = new Error("Design nicht gefunden");
    err.status = 404;
    throw err;
  }
  const konflikte = findExklusivKonflikte(designId, [{ gruppe: gruppe || null, bestandteil: "design" }]);
  if (konflikte.length > 0) {
    const err = new Error("Diese Design-Variante ist bereits exklusiv vergeben");
    err.status = 409;
    throw err;
  }
  const now = new Date().toISOString();
  const orderInfo = db.prepare(`
    INSERT INTO orders (kunde_name, kunde_email, kunde_instagram, kunde_whatsapp, kontakt_praeferenz, bestelldatum, status, notiz, access_token, token_created_at, manuell)
    VALUES (?, ?, ?, ?, 'E-Mail', ?, 'Erledigt', ?, ?, ?, 1)
  `).run(
    encryptField(kundeName),
    encryptField(""),
    encryptField(""),
    encryptField(""),
    now,
    encryptField(notiz || "Manuell erfasste Rechte-Vergabe (außerhalb des Bestellassistenten)"),
    generateOrderToken(),
    now
  );
  const orderId = orderInfo.lastInsertRowid;
  db.prepare("INSERT INTO order_designs (order_id, design_id) VALUES (?, ?)").run(orderId, designId);
  db.prepare(
    "INSERT INTO design_lizenzen (order_id, design_id, gruppe, bestandteil, exklusiv, createdAt) VALUES (?, ?, ?, 'design', 1, ?)"
  ).run(orderId, designId, gruppe || null, now);
  return getDesignLizenzenUebersicht();
});

module.exports = {
  getDesigns,
  getDesign,
  nextId,
  addDesign,
  addUploadTiming,
  updateDesign,
  deleteDesign,
  renameDesignId,
  IMAGE_TYP_VALUES,
  getCategories,
  addCategory,
  renameCategory,
  deleteCategory,
  getTags,
  addTag,
  renameTag,
  deleteTag,
  ORDER_STEPS,
  ORDER_STATUS_VALUES,
  RABATT_TYP_VALUES,
  KONTAKT_PRAEFERENZ_VALUES,
  createOrder,
  setOrderDesigns,
  setOrderDesignPreisoptionen,
  PREISOPTIONEN_VALUES,
  findExklusivKonflikte,
  setOrderDesignExklusivitaet,
  getDesignLizenzenUebersicht,
  addManualLizenz,
  revokeLizenz,
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
  moveDesignImage,
  setHauptbild,
  deleteDesignImage,
  setPairEigenschaften,
  deleteDesignImagePair,
  reorderDesignImagePairs,
  setDesignImagesVisibilityBulk,
  listFeedback,
  addFeedback,
  setFeedbackStatus,
  deleteFeedback,
  FEEDBACK_ART_VALUES,
  normalizeTagName,
};
