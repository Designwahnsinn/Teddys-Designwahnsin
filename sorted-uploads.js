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
// den NAS-Sync -> Google Drive (Cloud Sync auf der NAS).
function mirrorSorted(localFilePath, designId, kategorie, bezeichnung, ext) {
  try {
    const dir = path.join(SORTED_DIR, safeName(designId), safeName(kategorie));
    fs.mkdirSync(dir, { recursive: true });

    const base = safeName(bezeichnung) || safeName(kategorie) || "Bild";
    let target = path.join(dir, `${base}.${ext}`);
    let n = 2;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${base} (${n}).${ext}`);
      n++;
    }
    fs.copyFileSync(localFilePath, target);
  } catch (err) {
    console.error(`Sortierte Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

// Bestmögliches Aufräumen beim Löschen eines einzelnen Bilds - findet die
// wahrscheinlichste Datei (Bezeichnung ohne Kollisions-Suffix). Bei seltenen
// Namenskollisionen kann eine Karteileiche zurückbleiben, das ist für diese
// reine Archiv-Kopie unkritisch.
function removeSorted(designId, kategorie, bezeichnung, ext) {
  try {
    const dir = path.join(SORTED_DIR, safeName(designId), safeName(kategorie));
    const base = safeName(bezeichnung) || safeName(kategorie) || "Bild";
    const target = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err) {
    console.error(`Aufräumen der sortierten Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

function removeSortedDesign(designId) {
  try {
    fs.rmSync(path.join(SORTED_DIR, safeName(designId)), { recursive: true, force: true });
  } catch (err) {
    console.error(`Aufräumen der sortierten Ablage fehlgeschlagen für ${designId}:`, err.message);
  }
}

module.exports = { mirrorSorted, removeSorted, removeSortedDesign, SORTED_DIR };
