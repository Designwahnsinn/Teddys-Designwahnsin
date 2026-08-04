const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "teddy2026";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || "";

const UPLOADS_DIR = path.join(__dirname, "uploads");

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp", "image/avif"].includes(file.mimetype);
    cb(ok ? null : new Error("Nur PNG, JPG, WEBP oder AVIF erlaubt"), ok);
  },
});

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/mitarbeiter");
}

// --- Public API ---
function toPublicDesign(d) {
  // driveLink ist nur für den internen Mitarbeiter-Bereich gedacht
  const { driveLink, ...publicDesign } = d;
  return publicDesign;
}

app.get("/api/designs", (req, res) => {
  // Verkaufte Designs erscheinen nicht auf der öffentlichen Seite
  res.json(db.getDesigns().filter((d) => d.status !== "verkauft").map(toPublicDesign));
});

app.get("/api/config", (req, res) => {
  res.json({ categories: db.getCategories(), whatsappNumber: WHATSAPP_NUMBER });
});

// --- Login ---
app.get("/mitarbeiter", (req, res) => {
  if (req.session.loggedIn) return res.redirect("/mitarbeiter/upload");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/mitarbeiter/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect("/mitarbeiter/upload");
  }
  res.redirect("/mitarbeiter?error=1");
});

app.post("/mitarbeiter/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// --- Protected admin area ---
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

app.get("/api/admin/designs", requireAuth, (req, res) => {
  res.json(db.getDesigns());
});

app.post("/api/admin/designs", requireAuth, upload.single("image"), (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink } = req.body;
  if (!name || !category || !req.file) {
    return res.status(400).json({ error: "Name, Kategorie und Bild sind Pflichtfelder" });
  }
  if (!db.getCategories().includes(category)) {
    return res.status(400).json({ error: "Ungültige Kategorie" });
  }
  if (status && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "Ungültiger Status" });
  }
  const design = db.addDesign({
    id: db.nextId(),
    name,
    description: description || "",
    category,
    price: price ? Number(price) : null,
    status: status || "verfügbar",
    kaufLink: kaufLink || "",
    driveLink: driveLink || "",
    image: `/uploads/${req.file.filename}`,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(design);
});

app.patch("/api/admin/designs/:id", requireAuth, (req, res) => {
  const { name, description, category, price, status, kaufLink, driveLink } = req.body;

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

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn läuft auf http://localhost:${PORT}`);
});
