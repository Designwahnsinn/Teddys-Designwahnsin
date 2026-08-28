const IMAGE_TYP_VALUES = ["Design", "Hintergrund-Variante", "Hintergrund", "Motiv 1", "Motiv 2", "Motiv 3", "sonstiges"];

const designId = new URLSearchParams(window.location.search).get("id");
const titleEl = document.getElementById("design-title");
const gridEl = document.getElementById("image-grid");
const uploadForm = document.getElementById("image-upload-form");
const uploadMessage = document.getElementById("upload-message");
const uploadProgress = document.getElementById("upload-progress");
const fileInput = document.getElementById("image-file");
const filePreview = document.getElementById("image-file-preview");
const perFileRows = document.getElementById("per-file-rows");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

// Zoom-Ansicht für Kachel-Thumbnails (Feedback: Thumbnails sind mit
// height:120px + object-fit:cover stark beschnitten, Details/Bildqualität
// lassen sich darin kaum beurteilen) - ein einziges wiederverwendetes
// Overlay statt eins pro Kachel, damit nicht dutzende versteckte
// Lightbox-Elemente im DOM hängen.
const imageLightbox = el("div", { className: "image-lightbox", hidden: true }, [
  el("button", { type: "button", className: "image-lightbox-close", textContent: "×", "aria-label": "Schließen" }),
  el("img", { className: "image-lightbox-img" }),
]);
document.body.appendChild(imageLightbox);
const lightboxImg = imageLightbox.querySelector(".image-lightbox-img");

function openImageLightbox(src, alt) {
  lightboxImg.src = src;
  lightboxImg.alt = alt || "";
  imageLightbox.hidden = false;
}
function closeImageLightbox() {
  imageLightbox.hidden = true;
  lightboxImg.src = "";
}
imageLightbox.querySelector(".image-lightbox-close").addEventListener("click", closeImageLightbox);
imageLightbox.addEventListener("click", (e) => {
  if (e.target === imageLightbox) closeImageLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !imageLightbox.hidden) closeImageLightbox();
});

// "Als exklusiv markieren" direkt aus der Bilder-Verwaltung (Feedback #16) -
// ohne Seitenwechsel zur Design-Rechte-Seite. Bestandteil ist immer "design"
// (geschäftlich nie exklusiv für PNG/Hintergrund möglich, siehe Validierung
// in server-admin.js), Gruppe kommt fest aus der Karte, von der aus geöffnet
// wurde - kein Dropdown nötig, der Kontext (dieses Design, diese Variante)
// ist bereits eindeutig.
let currentDesignName = "";
const exklusivModal = el("div", { className: "exklusiv-modal", hidden: true });
document.body.appendChild(exklusivModal);

function closeExklusivModal() {
  exklusivModal.hidden = true;
  exklusivModal.innerHTML = "";
}
exklusivModal.addEventListener("click", (e) => {
  if (e.target === exklusivModal) closeExklusivModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !exklusivModal.hidden) closeExklusivModal();
});

function openExklusivModal(gruppe) {
  const kundeInput = el("input", { type: "text", required: true });
  const notizInput = el("input", { type: "text", placeholder: "z. B. wie und wann vereinbart" });
  const errorMsg = el("p", { className: "edit-error" });
  const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
  cancelBtn.addEventListener("click", closeExklusivModal);

  const form = el("form", { className: "exklusiv-modal-form" }, [
    el("h3", { textContent: "Als exklusiv markieren" }),
    el("p", { className: "field-hint", textContent: `${designId} · ${currentDesignName} · ${gruppe || "(ohne Gruppe, ganzes Design)"}` }),
    el("label", { textContent: "Kundin/Kunde" }), kundeInput,
    el("label", { textContent: "Notiz (optional)" }), notizInput,
    errorMsg,
    el("div", { className: "card-actions" }, [el("button", { type: "submit", textContent: "Als exklusiv erfassen" }), cancelBtn]),
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorMsg.textContent = "";
    const res = await fetch("/api/admin/design-lizenzen/manuell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ designId, gruppe: gruppe || "" }],
        kundeName: kundeInput.value,
        notiz: notizInput.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorMsg.textContent = data.error || "Fehler beim Erfassen.";
      return;
    }
    closeExklusivModal();
  });

  exklusivModal.innerHTML = "";
  exklusivModal.appendChild(form);
  exklusivModal.hidden = false;
  kundeInput.focus();
}

function typSelect(name, selected) {
  const s = el("select", { name });
  IMAGE_TYP_VALUES.forEach((t) => s.appendChild(el("option", { value: t, textContent: t, selected: t === selected })));
  return s;
}

// Eine Zeile pro ausgewählter Datei (Schritt 5) - Bildtyp und Bezeichnung
// werden pro Datei mitgeschickt, statt für den ganzen Upload-Vorgang zu gelten.
// Ein gemeinsamer Vorgabewert oben füllt alle Zeilen auf einmal, jede Zeile
// bleibt danach einzeln änderbar.
function renderPerFileRows(files) {
  perFileRows.innerHTML = "";
  perFileRows.hidden = files.length === 0;
  if (files.length === 0) return;

  const defaultsRow = el("div", { className: "per-file-row per-file-defaults" }, [
    el("span", { className: "per-file-thumb-placeholder", textContent: "Für alle:" }),
    typSelect("typ-default", "Design"),
    el("input", { type: "text", placeholder: "Bezeichnung für alle Zeilen (optional)", className: "per-file-bezeichnung-default" }),
  ]);
  const defaultTypSelect = defaultsRow.querySelector("select");
  const defaultBezeichnungInput = defaultsRow.querySelector("input");
  perFileRows.appendChild(defaultsRow);

  const rows = files.map((file) => {
    const thumb = el("img", { src: URL.createObjectURL(file), alt: "", className: "per-file-thumb" });
    const typ = typSelect("typ", "Design");
    const bezeichnung = el("input", { type: "text", name: "bezeichnung", placeholder: "Bezeichnung", value: "" });
    const row = el("div", { className: "per-file-row" }, [
      thumb,
      el("span", { className: "per-file-name", textContent: file.name }),
      typ,
      bezeichnung,
    ]);
    perFileRows.appendChild(row);
    return { typ, bezeichnung };
  });

  defaultTypSelect.addEventListener("change", () => {
    rows.forEach((r) => (r.typ.value = defaultTypSelect.value));
  });
  defaultBezeichnungInput.addEventListener("input", () => {
    rows.forEach((r) => (r.bezeichnung.value = defaultBezeichnungInput.value));
  });
}

// Testkonzept-Auswertung: Startzeitpunkt dieses Upload-Vorgangs (erstes
// Datei-Auswählen) - wird beim Absenden zum Design dazugezählt.
let uploadStartedAt = null;

fileInput.addEventListener("change", () => {
  if (uploadStartedAt === null) uploadStartedAt = Date.now();
  filePreview.innerHTML = "";
  const files = [...fileInput.files];
  files.forEach((file) => {
    filePreview.appendChild(el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }));
  });
  renderPerFileRows(files);
});

// Warnt vor versehentlichem Verlassen der Seite, solange Dateien für den
// Upload ausgewählt, aber noch nicht abgeschickt sind.
window.addEventListener("beforeunload", (e) => {
  if (fileInput.files.length > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// --- Mehrfachauswahl (Massen-Online/Offline) ---
const bulkBar = document.getElementById("bulk-bar");
const bulkCount = document.getElementById("bulk-count");
const bulkOnlineBtn = document.getElementById("bulk-online");
const bulkOfflineBtn = document.getElementById("bulk-offline");
const bulkClearBtn = document.getElementById("bulk-clear");
const selectedIds = new Set();

function updateBulkBar() {
  bulkBar.hidden = selectedIds.size === 0;
  bulkCount.textContent = `${selectedIds.size} ausgewählt`;
}

async function bulkSetVisibility(sichtbar) {
  await fetch(`/api/admin/designs/${designId}/images/bulk-visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageIds: [...selectedIds], sichtbar }),
  });
  selectedIds.clear();
  updateBulkBar();
  loadImages();
}
bulkOnlineBtn.addEventListener("click", () => bulkSetVisibility(true));
bulkOfflineBtn.addEventListener("click", () => bulkSetVisibility(false));
bulkClearBtn.addEventListener("click", () => {
  selectedIds.clear();
  updateBulkBar();
  loadImages();
});

// --- Ziehen statt Pfeiltasten (Schritt 8) ---
let draggedCard = null;

function findDropTarget(container, clientX, clientY) {
  const cards = [...container.querySelectorAll(".image-card:not(.dragging)")];
  let closest = null;
  let closestDist = Infinity;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dist = Math.hypot(clientX - cx, clientY - cy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = { card, after: clientX > cx };
    }
  }
  return closest;
}

gridEl.addEventListener("dragover", (e) => {
  if (!draggedCard) return;
  e.preventDefault();
  const target = findDropTarget(gridEl, e.clientX, e.clientY);
  if (!target || target.card === draggedCard) return;
  if (target.after) target.card.after(draggedCard);
  else target.card.before(draggedCard);
});

async function persistOrder() {
  const pairIds = [...gridEl.querySelectorAll(".image-card")].map((c) => c.dataset.pairId);
  await fetch(`/api/admin/designs/${designId}/images/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairIds }),
  });
}

async function loadImages() {
  const res = await fetch(`/api/admin/designs/${designId}/images`);
  if (!res.ok) {
    gridEl.textContent = "Design nicht gefunden.";
    return;
  }
  const images = await res.json();
  // Nach pairId gruppieren (Schritt 8) - Wasserzeichen- und Verkaufsdatei-Zeile
  // derselben Originaldatei werden zusammen als eine Kachel dargestellt.
  const pairs = new Map();
  for (const img of images) {
    const key = img.pairId || `solo-${img.id}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(img);
  }
  const orderedPairs = [...pairs.entries()].sort((a, b) => {
    const orderOf = (members) => Math.min(...members.map((m) => m.sortOrder ?? m.id));
    return orderOf(a[1]) - orderOf(b[1]);
  });
  // Für die Vorschlagsliste im Gruppenfeld (Schritt 10) - verhindert
  // Tippfehler wie "Blau" und "blau", ohne die Freiheit einzuschränken.
  const allGruppen = [...new Set(images.map((i) => i.gruppe).filter(Boolean))];
  gridEl.innerHTML = "";
  orderedPairs.forEach(([pairId, members]) => gridEl.appendChild(renderPairCard(pairId, members, allGruppen)));
}

function renderPairCard(pairId, members, allGruppen) {
  const watermarked = members.find((m) => m.wasserzeichen);
  const clean = members.find((m) => !m.wasserzeichen);
  const qualityWarning = watermarked?.qualityWarning || clean?.qualityWarning;

  const selectCheckbox = el("input", { type: "checkbox", checked: watermarked ? selectedIds.has(watermarked.id) : false, disabled: !watermarked });
  selectCheckbox.addEventListener("change", () => {
    if (!watermarked) return;
    if (selectCheckbox.checked) selectedIds.add(watermarked.id);
    else selectedIds.delete(watermarked.id);
    updateBulkBar();
  });

  function zoomableThumb(member, alt, labelText) {
    const img = el("img", { src: member.image, alt, title: "Klicken zum Vergrößern" });
    img.addEventListener("click", () => openImageLightbox(member.image, alt));
    return el("div", { className: "pair-thumb" }, [img, el("span", { className: "pair-thumb-label", textContent: labelText })]);
  }
  const thumbs = el("div", { className: "pair-thumbs" }, [
    watermarked ? zoomableThumb(watermarked, "Mit Wasserzeichen", "Mit Wasserzeichen") : null,
    clean ? zoomableThumb(clean, "Verkaufsdatei", "🛒 Verkaufsdatei") : null,
  ].filter(Boolean));

  // img.typ ist bei Bildern von vor Einführung dieses Felds NULL - dann grob
  // aus dem alten hintergrundVariante-Häkchen ableiten, damit die Auswahl
  // nicht einfach leer/falsch beim ersten Wert startet.
  const reference = watermarked || clean;
  const initialTyp = reference.typ || (reference.hintergrundVariante ? "Hintergrund-Variante" : "Design");
  const typSelectEl = typSelect("typ", initialTyp);
  typSelectEl.className = "category-select";

  const savedHint = el("span", { className: "saved-hint", textContent: "Gespeichert ✓", hidden: true });
  let savedHintTimer = null;
  function showSavedHint() {
    savedHint.hidden = false;
    clearTimeout(savedHintTimer);
    savedHintTimer = setTimeout(() => (savedHint.hidden = true), 2000);
  }

  // Patcht Typ/Bezeichnung für BEIDE Varianten auf einmal (Schritt 8) - vorher
  // musste dieselbe Änderung zweimal eingetragen werden.
  async function patchPair(extra) {
    const body = { typ: typSelectEl.value, ...extra };
    await fetch(`/api/admin/designs/${designId}/images/pair/${pairId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showSavedHint();
    loadImages();
  }
  typSelectEl.addEventListener("change", () => patchPair());

  const bezeichnungInput = el("input", {
    type: "text",
    className: "bezeichnung-input",
    placeholder: "Bezeichnung (z. B. Hintergrundvariante 1)",
    value: reference.bezeichnung || "",
  });
  bezeichnungInput.addEventListener("change", () => patchPair({ bezeichnung: bezeichnungInput.value.trim() }));

  // Varianten-Gruppe (Schritt 10) - freier Text statt fester Liste, mit
  // Vorschlagsliste aus den in diesem Design bereits verwendeten Gruppen.
  const gruppeListId = `gruppe-list-${pairId}`;
  const gruppeDatalist = el("datalist", { id: gruppeListId }, allGruppen.map((g) => el("option", { value: g })));
  const gruppeInput = el("input", {
    type: "text",
    className: "gruppe-input",
    placeholder: "Gruppe / Farbvariante (optional, z. B. Blau)",
    value: reference.gruppe || "",
  });
  gruppeInput.setAttribute("list", gruppeListId);
  gruppeInput.addEventListener("change", () => patchPair({ gruppe: gruppeInput.value.trim() }));

  const sichtbarLabel = watermarked
    ? el("label", { className: "image-visible-toggle" })
    : el("p", { className: "kategorie-verkauf", textContent: "Nur Verkaufsdatei, keine Wasserzeichen-Ansicht vorhanden" });
  if (watermarked) {
    const sichtbarCheckbox = el("input", { type: "checkbox", checked: !!watermarked.sichtbar });
    sichtbarCheckbox.addEventListener("change", async () => {
      await fetch(`/api/admin/designs/${designId}/images/${watermarked.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sichtbar: sichtbarCheckbox.checked }),
      });
    });
    sichtbarLabel.append(sichtbarCheckbox, document.createTextNode(" Sichtbar auf Webseite"));
  }

  // Die Verkaufsdatei darf nie Hauptbild werden - server-admin.js lehnt das
  // ohnehin hart ab, hier zusätzlich schon gar nicht erst anbieten.
  const hauptbildBtn = watermarked
    ? el("button", {
        className: "hauptbild-btn",
        textContent: watermarked.ist_hauptbild ? "★ Hauptbild" : "Als Hauptbild festlegen",
        disabled: !!watermarked.ist_hauptbild,
      })
    : null;
  if (hauptbildBtn) {
    hauptbildBtn.addEventListener("click", async () => {
      await fetch(`/api/admin/designs/${designId}/images/${watermarked.id}/hauptbild`, { method: "POST" });
      loadImages();
    });
  }

  // Ersetzt beide Varianten auf einmal aus einer neuen Originaldatei.
  const replaceInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/avif", hidden: true });
  const replaceBtn = el("button", { className: "edit-btn", textContent: "Datei ersetzen" });
  replaceBtn.addEventListener("click", () => replaceInput.click());
  replaceInput.addEventListener("change", async () => {
    if (!replaceInput.files[0]) return;
    const formData = new FormData();
    formData.append("image", replaceInput.files[0]);
    replaceBtn.disabled = true;
    replaceBtn.textContent = "Wird ersetzt …";
    const res = await fetch(`/api/admin/designs/${designId}/images/pair/${pairId}/replace`, { method: "POST", body: formData });
    if (res.ok) {
      loadImages();
    } else {
      const data = await res.json().catch(() => ({}));
      replaceBtn.disabled = false;
      replaceBtn.textContent = "Datei ersetzen";
      alert(data.error || "Fehler beim Ersetzen der Datei.");
    }
  });

  const exklusivBtn = el("button", { className: "edit-btn", textContent: "🔒 Als exklusiv markieren" });
  exklusivBtn.addEventListener("click", () => openExklusivModal(gruppeInput.value.trim()));

  const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
  if (watermarked?.ist_hauptbild) {
    deleteBtn.disabled = true;
    deleteBtn.title = "Hauptbild kann nicht gelöscht werden";
  } else {
    deleteBtn.addEventListener("click", async () => {
      if (!confirm("Beide Varianten (mit und ohne Wasserzeichen) wirklich löschen? Die Kopien in der sortierten Ablage (NAS) werden ebenfalls entfernt.")) return;
      const res = await fetch(`/api/admin/designs/${designId}/images/pair/${pairId}`, { method: "DELETE" });
      if (res.ok) loadImages();
    });
  }

  const card = el("div", { className: "image-card" }, [
    el("div", { className: "image-card-head" }, [selectCheckbox]),
    thumbs,
    typSelectEl,
    bezeichnungInput,
    gruppeInput,
    gruppeDatalist,
    savedHint,
    qualityWarning ? el("p", { className: "quality-warning", textContent: `⚠️ ${qualityWarning}` }) : null,
    sichtbarLabel,
    el("div", { className: "card-actions" }, [hauptbildBtn, replaceBtn, replaceInput, exklusivBtn, deleteBtn].filter(Boolean)),
  ].filter(Boolean));

  card.draggable = true;
  card.dataset.pairId = pairId;
  card.addEventListener("dragstart", () => {
    draggedCard = card;
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    draggedCard = null;
    persistOrder();
  });

  return card;
}

const uploadSubmitBtn = uploadForm.querySelector('button[type="submit"]');

// Baut die Fehlermeldung nach Schritt 7 aus: welche Datei, was ist das
// Problem, was ist der nächste Schritt - statt eines rohen Servertexts.
function formatFehlgeschlagen(list) {
  return list.map((f) => `${f.dateiname}: ${f.grund}`).join(" | ");
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  uploadMessage.textContent = "";
  uploadMessage.className = "";

  // Verhindert doppeltes Anlegen derselben Variante bei einem zweiten Klick,
  // während der erste Upload (mit automatischer Wasserzeichen-Erzeugung
  // spürbar langsamer) noch läuft.
  if (uploadSubmitBtn.disabled) return;
  uploadSubmitBtn.disabled = true;
  uploadSubmitBtn.textContent = "Lädt hoch …";
  const fileCount = fileInput.files.length;
  uploadProgress.hidden = false;
  uploadProgress.textContent =
    fileCount > 1
      ? `${fileCount} Dateien werden verarbeitet … Bitte dieses Fenster nicht schließen.`
      : "Wird verarbeitet … Bitte dieses Fenster nicht schließen.";

  try {
    const formData = new FormData();
    const files = [...fileInput.files];
    const rows = [...perFileRows.querySelectorAll(".per-file-row:not(.per-file-defaults)")];
    files.forEach((file, i) => {
      formData.append("images", file);
      const row = rows[i];
      formData.append("typ", row ? row.querySelector("select").value : "Design");
      formData.append("bezeichnung", row ? row.querySelector("input").value : "");
    });
    if (uploadStartedAt !== null) formData.append("uploadDurationMs", String(Date.now() - uploadStartedAt));

    const res = await fetch(`/api/admin/designs/${designId}/images`, { method: "POST", body: formData });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      uploadForm.reset();
      filePreview.innerHTML = "";
      renderPerFileRows([]);
      uploadStartedAt = null;
      const okCount = data.images.length / 2; // je Datei 2 Zeilen (mit/ohne Wasserzeichen)
      const parts = [`${okCount} Bild${okCount === 1 ? "" : "er"} hochgeladen.`];
      let className = "success";
      if (data.qualityWarnings && data.qualityWarnings.length > 0) {
        parts.push(`⚠️ Qualitätswarnung: ${data.qualityWarnings.join(" | ")}`);
        className = "warning";
      }
      if (data.fehlgeschlagen && data.fehlgeschlagen.length > 0) {
        parts.push(`❌ Fehlgeschlagen: ${formatFehlgeschlagen(data.fehlgeschlagen)}`);
        className = "warning";
      }
      uploadMessage.textContent = parts.join(" ");
      uploadMessage.className = className;
      loadImages();
    } else {
      uploadMessage.textContent =
        data.fehlgeschlagen && data.fehlgeschlagen.length > 0
          ? `Nichts konnte verarbeitet werden: ${formatFehlgeschlagen(data.fehlgeschlagen)}`
          : data.error || "Fehler beim Hochladen.";
      uploadMessage.className = "error";
    }
  } catch {
    uploadMessage.textContent = "Verbindungsfehler. Bitte später erneut versuchen.";
    uploadMessage.className = "error";
  } finally {
    uploadSubmitBtn.disabled = false;
    uploadSubmitBtn.textContent = "Hochladen";
    uploadProgress.hidden = true;
  }
});

async function init() {
  if (!designId) {
    gridEl.textContent = "Kein Design ausgewählt.";
    return;
  }

  const designsRes = await fetch("/api/admin/designs");
  const designs = await designsRes.json();
  const design = designs.find((d) => d.id === designId);

  titleEl.textContent = design ? `Bilder verwalten – ${design.name}` : "Bilder verwalten";
  currentDesignName = design ? design.name : "";

  // Mindestauflösung im Hinweistext an die tatsächliche Größe dieses Designs
  // anpassen (Standard 20cm, kann pro Design abweichen).
  const groesseHint = document.getElementById("groesse-hint");
  if (design && groesseHint) {
    const cm = design.groesseCm || 20;
    const minPx = Math.round((cm / 2.54) * 300);
    groesseHint.textContent = `Größe: ${cm} × ${cm} cm bei 300 dpi (≈ ${minPx} × ${minPx} Pixel)`;
  }

  loadImages();
}

init();
