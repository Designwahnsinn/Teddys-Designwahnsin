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

fileInput.addEventListener("change", () => {
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

async function loadImages() {
  const res = await fetch(`/api/admin/designs/${designId}/images`);
  if (!res.ok) {
    gridEl.textContent = "Design nicht gefunden.";
    return;
  }
  const images = await res.json();
  gridEl.innerHTML = "";
  images.forEach((img) => gridEl.appendChild(renderImageCard(img)));
}

function renderImageCard(img) {
  const isVerkaufsdatei = !img.wasserzeichen;

  const sichtbarLabel = el("label", { className: "image-visible-toggle" });
  const sichtbarCheckbox = el("input", {
    type: "checkbox",
    checked: !isVerkaufsdatei && !!img.sichtbar,
    disabled: isVerkaufsdatei,
  });
  sichtbarCheckbox.addEventListener("change", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sichtbar: sichtbarCheckbox.checked }),
    });
  });
  sichtbarLabel.append(
    sichtbarCheckbox,
    document.createTextNode(isVerkaufsdatei ? " Nie öffentlich sichtbar (Verkaufsdatei)" : " Sichtbar auf Webseite")
  );

  // Die Verkaufsdatei darf nie Hauptbild werden - server-admin.js lehnt das
  // ohnehin hart ab (siehe /hauptbild-Route), hier zusätzlich schon gar nicht erst anbieten.
  const hauptbildBtn = isVerkaufsdatei
    ? null
    : el("button", {
        className: "hauptbild-btn",
        textContent: img.ist_hauptbild ? "★ Hauptbild" : "Als Hauptbild festlegen",
        disabled: !!img.ist_hauptbild,
      });
  if (hauptbildBtn) {
    hauptbildBtn.addEventListener("click", async () => {
      await fetch(`/api/admin/designs/${designId}/images/${img.id}/hauptbild`, { method: "POST" });
      loadImages();
    });
  }

  const replaceInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/avif", hidden: true });
  const replaceBtn = el("button", { className: "edit-btn", textContent: "Datei ersetzen" });
  replaceBtn.addEventListener("click", () => replaceInput.click());
  replaceInput.addEventListener("change", async () => {
    if (!replaceInput.files[0]) return;
    const formData = new FormData();
    formData.append("image", replaceInput.files[0]);
    replaceBtn.disabled = true;
    replaceBtn.textContent = "Wird ersetzt …";
    const res = await fetch(`/api/admin/designs/${designId}/images/${img.id}/replace`, { method: "POST", body: formData });
    if (res.ok) {
      loadImages();
    } else {
      const data = await res.json().catch(() => ({}));
      replaceBtn.disabled = false;
      replaceBtn.textContent = "Datei ersetzen";
      alert(data.error || "Fehler beim Ersetzen der Datei.");
    }
  });

  const moveUpBtn = el("button", { className: "move-btn", textContent: "↑", title: "Nach oben verschieben" });
  moveUpBtn.addEventListener("click", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "up" }),
    });
    loadImages();
  });

  const moveDownBtn = el("button", { className: "move-btn", textContent: "↓", title: "Nach unten verschieben" });
  moveDownBtn.addEventListener("click", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "down" }),
    });
    loadImages();
  });

  const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
  if (img.ist_hauptbild) {
    deleteBtn.disabled = true;
    deleteBtn.title = "Hauptbild kann nicht gelöscht werden";
  } else {
    deleteBtn.addEventListener("click", async () => {
      // Schritt 7: klar sagen, was durch den Klick tatsächlich verschwindet -
      // nicht nur diese eine Ansicht, sondern die dazugehörige zweite Variante
      // (mit/ohne Wasserzeichen) und die Kopie in der sortierten NAS-Ablage.
      const partner = isVerkaufsdatei ? "die zugehörige Wasserzeichen-Ansicht" : "die zugehörige Verkaufsdatei";
      if (!confirm(`Dieses Bild wirklich löschen? Nicht ${partner} - nur diese eine Zeile. Die Kopie in der sortierten Ablage (NAS) wird ebenfalls entfernt.`)) return;
      const res = await fetch(`/api/admin/designs/${designId}/images/${img.id}`, { method: "DELETE" });
      if (res.ok) loadImages();
    });
  }

  const wasserzeichenSelectEl = el("select", { className: "category-select" });
  wasserzeichenSelectEl.appendChild(el("option", { value: "true", textContent: "Mit Wasserzeichen", selected: !!img.wasserzeichen }));
  wasserzeichenSelectEl.appendChild(el("option", { value: "false", textContent: "Ohne Wasserzeichen", selected: !img.wasserzeichen }));

  // img.typ ist bei Bildern von vor Einführung dieses Felds NULL - dann grob
  // aus dem alten hintergrundVariante-Häkchen ableiten, damit die Auswahl
  // nicht einfach leer/falsch beim ersten Wert startet.
  const initialTyp = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
  const typSelectEl = el("select", { className: "category-select" });
  IMAGE_TYP_VALUES.forEach((t) => {
    typSelectEl.appendChild(el("option", { value: t, textContent: t, selected: t === initialTyp }));
  });

  const savedHint = el("span", { className: "saved-hint", textContent: "Gespeichert ✓", hidden: true });
  let savedHintTimer = null;
  function showSavedHint() {
    savedHint.hidden = false;
    clearTimeout(savedHintTimer);
    savedHintTimer = setTimeout(() => (savedHint.hidden = true), 2000);
  }

  async function patchEigenschaften(extra) {
    const body = {
      wasserzeichen: wasserzeichenSelectEl.value === "true",
      typ: typSelectEl.value,
      ...extra,
    };
    // Verkaufsdatei darf nie als sichtbar markiert bleiben - direkt mit korrigieren.
    if (!body.wasserzeichen) body.sichtbar = false;
    await fetch(`/api/admin/designs/${designId}/images/${img.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showSavedHint();
    loadImages();
  }
  wasserzeichenSelectEl.addEventListener("change", () => patchEigenschaften());
  typSelectEl.addEventListener("change", () => patchEigenschaften());

  // Freihändige Bezeichnung statt automatisch durchnummerierter Namen
  // ("Bild 2", "Bild 3") - Mitarbeitende sollen z.B. "Hintergrundvariante 4"
  // frei vergeben können, damit die Auswahl in der Bestellung eindeutig ist.
  const bezeichnungInput = el("input", {
    type: "text",
    className: "bezeichnung-input",
    placeholder: "Bezeichnung (z. B. Hintergrundvariante 1)",
    value: img.bezeichnung || "",
  });
  bezeichnungInput.addEventListener("change", () => patchEigenschaften({ bezeichnung: bezeichnungInput.value.trim() }));

  const verkaufHinweis = isVerkaufsdatei
    ? el("p", { className: "kategorie-verkauf", textContent: "🛒 Verkaufsdatei" })
    : null;

  return el("div", { className: "image-card" }, [
    el("img", { src: img.image, alt: img.bezeichnung || img.kategorie }),
    wasserzeichenSelectEl,
    typSelectEl,
    verkaufHinweis,
    bezeichnungInput,
    savedHint,
    img.qualityWarning ? el("p", { className: "quality-warning", textContent: `⚠️ ${img.qualityWarning}` }) : null,
    sichtbarLabel,
    el("div", { className: "card-actions" }, [moveUpBtn, moveDownBtn, hauptbildBtn, replaceBtn, replaceInput, deleteBtn].filter(Boolean)),
  ].filter(Boolean));
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

    const res = await fetch(`/api/admin/designs/${designId}/images`, { method: "POST", body: formData });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      uploadForm.reset();
      filePreview.innerHTML = "";
      renderPerFileRows([]);
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

  loadImages();
}

init();
