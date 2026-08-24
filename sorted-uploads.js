const fs = require("fs");
const path = require("path");

const SORTED_DIR = process.env.SORTED_UPLOADS_DIR || path.join(__dirname, "uploads-sorted");

// Gleiche Bereinigung wie für Google-Drive-Dateinamen - keine Pfad-/
// Sonderzeichen aus Nutzereingaben (Bezeichnung) landen ungefiltert im Pfad.
function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|]/g, "").trim();
}

// Spiegelt eine hochgeladene Datei zusätzlich in eine nach Design und
// Wasserzeichen-Kategorie sortierte Ordnerstruktur (uploads-sorted/<Design-ID>/<Kategorie>/...),
// getrennt von der flachen uploads/-Struktur mit UUID-Dateinamen, die die
// Webseite referenziert und unangetastet bleiben soll. Dient als Quelle für
// den NAS-Sync -> Google Drive (Cloud Sync auf der NAS). Async statt
// synchron (Schritt 1) - sonst blockiert der komplette Mitarbeiterbereich,
// solange z.B. eine große Druckdatei auf die (oft langsamere NAS-)Freigabe kopiert wird.
async function mirrorSorted(localFilePath, designId, kategorie, bezeichnung, ext) {
  try {
    const dir = path.join(SORTED_DIR, safeName(designId), safeName(kategorie));
    await fs.promises.mkdir(dir, { recursive: true });

    const base = safeName(bezeichnung) || safeName(kategorie) || "Bild";
    let target = path.join(dir, `${base}.${ext}`);
    let n = 2;
    while (await fs.promises.access(target).then(() => true, () => false)) {
      target = path.join(dir, `${base} (${n}).${ext}`);
      n++;
    }
    await fs.promises.copyFile(localFilePath, target);
  } catch (err) {
    console.error(`Sortierte Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

// Bestmögliches Aufräumen beim Löschen eines einzelnen Bilds - findet die
// wahrscheinlichste Datei (Bezeichnung ohne Kollisions-Suffix). Bei seltenen
// Namenskollisionen kann eine Karteileiche zurückbleiben, das ist für diese
// reine Archiv-Kopie unkritisch.
async function removeSorted(designId, kategorie, bezeichnung, ext) {
  try {
    const dir = path.join(SORTED_DIR, safeName(designId), safeName(kategorie));
    const base = safeName(bezeichnung) || safeName(kategorie) || "Bild";
    const target = path.join(dir, `${base}.${ext}`);
    await fs.promises.unlink(target).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
  } catch (err) {
    console.error(`Aufräumen der sortierten Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

async function removeSortedDesign(designId) {
  try {
    await fs.promises.rm(path.join(SORTED_DIR, safeName(designId)), { recursive: true, force: true });
  } catch (err) {
    console.error(`Aufräumen der sortierten Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

async function renameSortedDesign(oldId, newId) {
  try {
    const oldDir = path.join(SORTED_DIR, safeName(oldId));
    const newDir = path.join(SORTED_DIR, safeName(newId));
    if (await fs.promises.access(oldDir).then(() => true, () => false)) {
      await fs.promises.rename(oldDir, newDir);
    }
  } catch (err) {
    console.error(`Umbenennen der sortierten Ablage fehlgeschlagen für ${oldId} -> ${newId}:`, err.message);
  }
}

module.exports = { mirrorSorted, removeSorted, removeSortedDesign, renameSortedDesign, SORTED_DIR };
