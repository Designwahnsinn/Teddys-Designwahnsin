const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "designs.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");

const DEFAULT_CATEGORIES = [
  "Tiere",
  "Blumen / Natur",
  "Muster / Abstrakt",
  "Kindermotive",
  "Saisonal",
];

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");
  if (!fs.existsSync(CATEGORIES_FILE)) {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(DEFAULT_CATEGORIES, null, 2));
  }
}

function getDesigns() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDesigns(designs) {
  ensureStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(designs, null, 2));
}

// TD-XXXX: fortlaufende Nummer über alle bisher vergebenen IDs hinweg
function nextId() {
  const designs = getDesigns();
  const max = designs.reduce((acc, d) => {
    const match = /^TD-(\d+)$/.exec(d.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `TD-${String(max + 1).padStart(4, "0")}`;
}

function addDesign(design) {
  const designs = getDesigns();
  designs.unshift(design);
  saveDesigns(designs);
  return design;
}

function updateDesign(id, changes) {
  const designs = getDesigns();
  const target = designs.find((d) => d.id === id);
  if (!target) return null;
  Object.assign(target, changes);
  saveDesigns(designs);
  return target;
}

function deleteDesign(id) {
  const designs = getDesigns();
  const target = designs.find((d) => d.id === id);
  saveDesigns(designs.filter((d) => d.id !== id));
  return target;
}

function getCategories() {
  ensureStore();
  return JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf-8"));
}

function saveCategories(categories) {
  ensureStore();
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categories, null, 2));
}

function addCategory(name) {
  const categories = getCategories();
  categories.push(name);
  saveCategories(categories);
  return categories;
}

// Umbenennen zieht alle Designs der Kategorie mit um
function renameCategory(oldName, newName) {
  const categories = getCategories();
  const index = categories.indexOf(oldName);
  if (index === -1) return null;
  categories[index] = newName;
  saveCategories(categories);

  const designs = getDesigns();
  let changed = false;
  designs.forEach((d) => {
    if (d.category === oldName) {
      d.category = newName;
      changed = true;
    }
  });
  if (changed) saveDesigns(designs);

  return categories;
}

function deleteCategory(name) {
  const categories = getCategories();
  if (!categories.includes(name)) return null;
  saveCategories(categories.filter((c) => c !== name));
  return getCategories();
}

module.exports = {
  getDesigns,
  nextId,
  addDesign,
  updateDesign,
  deleteDesign,
  getCategories,
  addCategory,
  renameCategory,
  deleteCategory,
};
