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

const UPLOADS_DIR = path.join(__dirname, "uploads");

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
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Nur PNG, JPG oder WEBP erlaubt"), ok);
  },
});

function requireAuth(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect("/mitarbeiter");
}

// --- Public API ---
app.get("/api/designs", (req, res) => {
  res.json(db.getDesigns());
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

app.get("/api/admin/designs", requireAuth, (req, res) => {
  res.json(db.getDesigns());
});

app.post("/api/admin/designs", requireAuth, upload.single("image"), (req, res) => {
  const { name, description } = req.body;
  if (!name || !req.file) {
    return res.status(400).json({ error: "Name und Bild sind Pflichtfelder" });
  }
  const design = db.addDesign({
    id: crypto.randomUUID(),
    name,
    description: description || "",
    image: `/uploads/${req.file.filename}`,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(design);
});

app.delete("/api/admin/designs/:id", requireAuth, (req, res) => {
  const removed = db.deleteDesign(req.params.id);
  if (!removed) return res.status(404).json({ error: "Nicht gefunden" });

  const filePath = path.join(UPLOADS_DIR, path.basename(removed.image));
  fs.unlink(filePath, () => {});

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Teddys Designwahnsinn läuft auf http://localhost:${PORT}`);
});
