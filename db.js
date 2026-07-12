const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "designs.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");
}

function getDesigns() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDesigns(designs) {
  ensureStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(designs, null, 2));
}

function addDesign(design) {
  const designs = getDesigns();
  designs.unshift(design);
  saveDesigns(designs);
  return design;
}

function deleteDesign(id) {
  const designs = getDesigns();
  const target = designs.find((d) => d.id === id);
  saveDesigns(designs.filter((d) => d.id !== id));
  return target;
}

module.exports = { getDesigns, addDesign, deleteDesign };
