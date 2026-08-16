const IMAGE_TYP_VALUES = ["Design", "Hintergrund-Variante", "Hintergrund", "Motiv 1", "Motiv 2", "Motiv 3", "sonstiges"];

const designId = new URLSearchParams(window.location.search).get("id");
const titleEl = document.getElementById("design-title");
const gridEl = document.getElementById("image-grid");
const uploadForm = document.getElementById("image-upload-form");
const uploadMessage = document.getElementById("upload-message");
const fileInput = document.getElementById("image-file");
const filePreview = document.getElementById("image-file-preview");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

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

  const hauptbildBtn = el("button", {
    className: "hauptbild-btn",
    textContent: img.ist_hauptbild ? "★ Hauptbild" : "Als Hauptbild festlegen",
    disabled: !!img.ist_hauptbild,
  });
  hauptbildBtn.addEventListener("click", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}/hauptbild`, { method: "POST" });
    loadImages();
  });

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
      if (!confirm("Dieses Bild wirklich löschen?")) return;
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
    img.qualityWarning ? el("p", { className: "quality-warning", textContent: `⚠️ ${img.qualityWarning}` }) : null,
    sichtbarLabel,
    el("div", { className: "card-actions" }, [moveUpBtn, moveDownBtn, hauptbildBtn, replaceBtn, replaceInput, deleteBtn]),
  ].filter(Boolean));
}

fileInput.addEventListener("change", () => {
  filePreview.innerHTML = "";
  [...fileInput.files].forEach((file) => {
    filePreview.appendChild(el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }));
  });
});

const uploadSubmitBtn = uploadForm.querySelector('button[type="submit"]');

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  uploadMessage.textContent = "";
  uploadMessage.className = "";

  // Verhindert doppeltes Anlegen derselben Variante bei einem zweiten Klick,
  // während der erste Upload (jetzt mit automatischer Wasserzeichen-Erzeugung
  // spürbar langsamer) noch läuft.
  if (uploadSubmitBtn.disabled) return;
  uploadSubmitBtn.disabled = true;
  uploadSubmitBtn.textContent = "Lädt hoch …";

  try {
    const formData = new FormData(uploadForm);
    const res = await fetch(`/api/admin/designs/${designId}/images`, { method: "POST", body: formData });

    if (res.ok) {
      const data = await res.json();
      uploadForm.reset();
      filePreview.innerHTML = "";
      const count = data.images.length;
      if (data.qualityWarnings.length > 0) {
        uploadMessage.textContent = `${count} Bild${count === 1 ? "" : "er"} hochgeladen. ⚠️ ${data.qualityWarnings.join(" | ")}`;
        uploadMessage.className = "warning";
      } else {
        uploadMessage.textContent = `${count} Bild${count === 1 ? "" : "er"} hochgeladen.`;
        uploadMessage.className = "success";
      }
      loadImages();
    } else {
      const data = await res.json().catch(() => ({}));
      uploadMessage.textContent = data.error || "Fehler beim Hochladen.";
      uploadMessage.className = "error";
    }
  } finally {
    uploadSubmitBtn.disabled = false;
    uploadSubmitBtn.textContent = "Hochladen";
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
