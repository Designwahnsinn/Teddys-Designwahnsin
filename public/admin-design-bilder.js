const designId = new URLSearchParams(window.location.search).get("id");
const titleEl = document.getElementById("design-title");
const gridEl = document.getElementById("image-grid");
const kategorieSelect = document.getElementById("image-kategorie");
const uploadForm = document.getElementById("image-upload-form");
const uploadMessage = document.getElementById("upload-message");

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

  return el("div", { className: "image-card" }, [
    el("img", { src: img.image, alt: img.bezeichnung || img.kategorie }),
    el("p", { className: "category", textContent: img.kategorie }),
    img.bezeichnung ? el("p", { textContent: img.bezeichnung }) : null,
    sichtbarLabel,
    el("div", { className: "card-actions" }, [hauptbildBtn, deleteBtn]),
  ].filter(Boolean));
}

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  uploadMessage.textContent = "";
  uploadMessage.className = "";

  const formData = new FormData(uploadForm);
  const res = await fetch(`/api/admin/designs/${designId}/images`, { method: "POST", body: formData });

  if (res.ok) {
    const data = await res.json();
    uploadForm.reset();
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

  config.imageKategorien.forEach((k) => {
    kategorieSelect.appendChild(el("option", { value: k, textContent: k }));
  });

  titleEl.textContent = design ? `Bilder verwalten – ${design.name}` : "Bilder verwalten";

  loadImages();
}

init();
