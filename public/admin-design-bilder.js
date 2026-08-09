const designId = new URLSearchParams(window.location.search).get("id");
const titleEl = document.getElementById("design-title");
const gridEl = document.getElementById("image-grid");
const kategorieSelect = document.getElementById("image-kategorie");
const uploadForm = document.getElementById("image-upload-form");
const uploadMessage = document.getElementById("upload-message");
const fileInput = document.getElementById("image-file");
const filePreview = document.getElementById("image-file-preview");

let imageKategorien = [];

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
  const sichtbarLabel = el("label", { className: "image-visible-toggle" });
  const sichtbarCheckbox = el("input", { type: "checkbox", checked: !!img.sichtbar });
  sichtbarCheckbox.addEventListener("change", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sichtbar: sichtbarCheckbox.checked }),
    });
  });
  sichtbarLabel.append(sichtbarCheckbox, document.createTextNode(" Sichtbar auf Webseite"));

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

  const kategorieSelectEl = el("select", { className: "category-select" });
  imageKategorien.forEach((k) => {
    kategorieSelectEl.appendChild(el("option", { value: k, textContent: k, selected: k === img.kategorie }));
  });
  kategorieSelectEl.addEventListener("change", async () => {
    await fetch(`/api/admin/designs/${designId}/images/${img.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kategorie: kategorieSelectEl.value }),
    });
    loadImages();
  });

  const verkaufHinweis =
    img.kategorie === "Ohne Wasserzeichen"
      ? el("p", { className: "kategorie-verkauf", textContent: "🛒 Verkaufsdatei" })
      : null;

  return el("div", { className: "image-card" }, [
    el("img", { src: img.image, alt: img.bezeichnung || img.kategorie }),
    kategorieSelectEl,
    verkaufHinweis,
    img.bezeichnung ? el("p", { textContent: img.bezeichnung }) : null,
    img.qualityWarning ? el("p", { className: "quality-warning", textContent: `⚠️ ${img.qualityWarning}` }) : null,
    sichtbarLabel,
    el("div", { className: "card-actions" }, [hauptbildBtn, replaceBtn, replaceInput, deleteBtn]),
  ].filter(Boolean));
}

fileInput.addEventListener("change", () => {
  filePreview.innerHTML = "";
  const file = fileInput.files[0];
  if (!file) return;
  filePreview.appendChild(el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }));
});

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  uploadMessage.textContent = "";
  uploadMessage.className = "";

  const formData = new FormData(uploadForm);
  const res = await fetch(`/api/admin/designs/${designId}/images`, { method: "POST", body: formData });

  if (res.ok) {
    const data = await res.json();
    uploadForm.reset();
    filePreview.innerHTML = "";
    if (data.qualityWarning) {
      uploadMessage.textContent = `Bild hochgeladen. ⚠️ ${data.qualityWarning}`;
      uploadMessage.className = "warning";
    } else {
      uploadMessage.textContent = "Bild hochgeladen.";
      uploadMessage.className = "success";
    }
    loadImages();
  } else {
    const data = await res.json().catch(() => ({}));
    uploadMessage.textContent = data.error || "Fehler beim Hochladen.";
    uploadMessage.className = "error";
  }
});

async function init() {
  if (!designId) {
    gridEl.textContent = "Kein Design ausgewählt.";
    return;
  }

  const [configRes, designsRes] = await Promise.all([fetch("/api/config"), fetch("/api/admin/designs")]);
  const config = await configRes.json();
  const designs = await designsRes.json();
  const design = designs.find((d) => d.id === designId);

  imageKategorien = config.imageKategorien;
  imageKategorien.forEach((k) => {
    kategorieSelect.appendChild(el("option", { value: k, textContent: k }));
  });

  titleEl.textContent = design ? `Bilder verwalten – ${design.name}` : "Bilder verwalten";

  loadImages();
}

init();
