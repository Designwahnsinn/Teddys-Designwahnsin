const cardsEl = document.getElementById("admin-cards");
const emptyEl = document.getElementById("admin-empty");
const categoryFilterEl = document.getElementById("filter-category");
const onlineFilterEl = document.getElementById("filter-online");
const sortEl = document.getElementById("sort-designs");
const bulkToolbarEl = document.getElementById("bulk-toolbar");
const bulkCountEl = document.getElementById("bulk-count");

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];
let categories = [];
let allTags = [];
let allDesigns = [];
const selectedIds = new Set();

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

// Freies Mehrfach-Tag-Eingabefeld mit Autovervollständigung aus bereits
// vorhandenen Tags. Anders als beim Upload (admin-neu.js, FormData wegen
// Datei-Upload) geht die Auswahl hier direkt als Array in ein JSON-PATCH -
// getTags() liefert die aktuelle Auswahl beim Speichern.
function buildTagInput(existingTags, availableTags) {
  const selected = [...existingTags];
  const wrap = el("div", { className: "tag-input" });
  const chipsEl = el("div", { className: "tag-input-chips" });
  const textInput = el("input", { type: "text", placeholder: "Tag eingeben und Enter …", className: "tag-input-field" });
  const suggestionsEl = el("div", { className: "tag-input-suggestions", hidden: true });

  function renderChips() {
    chipsEl.innerHTML = "";
    selected.forEach((tag) => {
      const removeBtn = el("button", { type: "button", textContent: "×", "aria-label": `${tag} entfernen` });
      removeBtn.addEventListener("click", () => {
        selected.splice(selected.indexOf(tag), 1);
        renderChips();
      });
      chipsEl.appendChild(el("span", { className: "tag-chip" }, [document.createTextNode(tag), removeBtn]));
    });
  }

  function addTag(name) {
    // Kleinschreibung passend zur Schreibkonvention (Ausbau 1.6/1.8).
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || selected.includes(trimmed)) return;
    selected.push(trimmed);
    renderChips();
    textInput.value = "";
    suggestionsEl.hidden = true;
  }

  function updateSuggestions() {
    const query = textInput.value.trim().toLowerCase();
    suggestionsEl.innerHTML = "";
    if (!query) { suggestionsEl.hidden = true; return; }
    const matches = availableTags.filter((t) => t.toLowerCase().includes(query) && !selected.includes(t)).slice(0, 8);
    if (matches.length === 0) { suggestionsEl.hidden = true; return; }
    matches.forEach((t) => {
      const item = el("button", { type: "button", className: "tag-input-suggestion", textContent: t });
      item.addEventListener("click", () => addTag(t));
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.hidden = false;
  }

  textInput.addEventListener("input", updateSuggestions);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(textInput.value);
    }
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) suggestionsEl.hidden = true;
  });

  renderChips();
  wrap.append(chipsEl, textInput, suggestionsEl);
  wrap.getTags = () => [...selected];
  return wrap;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

function renderCardView(d, body) {
  body.innerHTML = "";

  const statusSelect = el("select", { className: "status-select" });
  STATUS_VALUES.forEach((s) => {
    statusSelect.appendChild(el("option", { value: s, textContent: s, selected: s === d.status }));
  });
  statusSelect.dataset.id = d.id;

  const onlineSelect = el("select", { className: "online-select" });
  [["1", "Online"], ["0", "Offline"]].forEach(([value, label]) => {
    onlineSelect.appendChild(el("option", { value, textContent: label, selected: Boolean(d.online) === (value === "1") }));
  });
  onlineSelect.dataset.id = d.id;

  const editBtn = el("button", { className: "edit-btn", textContent: "Bearbeiten" });
  editBtn.addEventListener("click", () => renderCardEdit(d, body));

  const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
  deleteBtn.dataset.id = d.id;

  const children = [
    el("span", { className: "design-id", textContent: d.id }),
    el("p", { className: "category", textContent: d.category || "" }),
    el("h3", { textContent: d.name }),
    el("p", { textContent: [d.description, formatPrice(d.price)].filter(Boolean).join(" · ") }),
  ];
  if (d.tags && d.tags.length > 0) {
    children.push(el("p", { className: "tag-list" }, d.tags.map((t) => el("span", { className: "tag-chip-static", textContent: t }))));
  }
  if (d.driveLink) {
    children.push(el("p", { className: "drive-link" }, [
      el("a", { href: d.driveLink, target: "_blank", rel: "noopener", textContent: "📁 Originaldatei auf Drive" }),
    ]));
  }
  children.push(el("div", { className: "card-actions" }, [statusSelect, onlineSelect, editBtn, deleteBtn]));

  body.append(...children);
}

function renderImageThumbs(d) {
  const wrap = el("div", { className: "edit-image-thumbs" });
  wrap.appendChild(el("p", { textContent: "Lädt Bilder …" }));

  fetch(`/api/admin/designs/${d.id}/images`)
    .then((res) => res.json())
    .then((images) => {
      wrap.innerHTML = "";
      images.forEach((img) => {
        const typ = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
        const label = `${typ} (${img.wasserzeichen ? "mit WZ" : "ohne WZ"})`;
        wrap.appendChild(
          el("div", { className: "edit-image-thumb", title: img.bezeichnung ? `${label} – ${img.bezeichnung}` : label }, [
            el("img", { src: img.image, alt: label }),
            img.ist_hauptbild ? el("span", { className: "edit-image-thumb-badge", textContent: "★" }) : null,
          ].filter(Boolean))
        );
      });
      wrap.appendChild(
        el("a", { className: "edit-btn", textContent: "🖼️ Alle Bilder verwalten →", href: `/mitarbeiter/designs/bilder?id=${d.id}` })
      );
    });

  return wrap;
}

function renderCardEdit(d, body) {
  body.innerHTML = "";

  const nameInput = el("input", { type: "text", value: d.name });
  const catSelect = el("select");
  categories.forEach((c) => {
    catSelect.appendChild(el("option", { value: c, textContent: c, selected: c === d.category }));
  });
  const descInput = el("textarea", { rows: 2, value: d.description || "" });
  const priceInput = el("input", { type: "number", step: "0.01", min: "0", value: d.price != null ? d.price : "" });
  const pricePngInput = el("input", { type: "number", step: "0.01", min: "0", value: d.pricePng != null ? d.pricePng : "" });
  const priceHintergrundInput = el("input", { type: "number", step: "0.01", min: "0", value: d.priceHintergrund != null ? d.priceHintergrund : "" });
  const linkInput = el("input", { type: "url", value: d.kaufLink || "", placeholder: "https://…" });
  const instagramInput = el("input", { type: "url", value: d.instagramLink || "", placeholder: "https://instagram.com/p/…" });
  const driveInput = el("input", { type: "url", value: d.driveLink || "", placeholder: "https://drive.google.com/…" });
  const tagInput = buildTagInput(d.tags || [], allTags);

  const errorMsg = el("p", { className: "edit-error" });

  const saveBtn = el("button", { className: "save-btn", textContent: "Speichern" });
  saveBtn.addEventListener("click", async () => {
    const res = await fetch(`/api/admin/designs/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value.trim(),
        category: catSelect.value,
        description: descInput.value.trim(),
        price: priceInput.value,
        pricePng: pricePngInput.value,
        priceHintergrund: priceHintergrundInput.value,
        kaufLink: linkInput.value.trim(),
        instagramLink: instagramInput.value.trim(),
        driveLink: driveInput.value.trim(),
        tags: tagInput.getTags(),
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      Object.assign(d, updated);
      renderCardView(d, body);
    } else {
      const data = await res.json().catch(() => ({}));
      errorMsg.textContent = data.error || "Fehler beim Speichern.";
    }
  });

  const cancelBtn = el("button", { className: "cancel-btn", textContent: "Abbrechen" });
  cancelBtn.addEventListener("click", () => renderCardView(d, body));

  const idInput = el("input", { type: "text", value: d.id, placeholder: "TD-0000" });
  const idErrorMsg = el("p", { className: "edit-error" });
  const idSaveBtn = el("button", { className: "edit-btn", textContent: "ID ändern" });
  idSaveBtn.addEventListener("click", async () => {
    const newId = idInput.value.trim();
    if (newId === d.id) return;
    if (!confirm(`TD-ID wirklich von ${d.id} auf ${newId} ändern? Nur für Testzwecke gedacht.`)) return;
    const res = await fetch(`/api/admin/designs/${d.id}/rename-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newId }),
    });
    if (res.ok) {
      idErrorMsg.textContent = "";
      loadDesigns();
    } else {
      const data = await res.json().catch(() => ({}));
      idErrorMsg.textContent = data.error || "Fehler beim Ändern der ID.";
    }
  });

  body.append(
    el("span", { className: "design-id", textContent: d.id }),
    el("label", { textContent: "TD-ID (nur für Testzwecke ändern)" }),
    el("div", { className: "card-actions" }, [idInput, idSaveBtn]),
    idErrorMsg,
    el("label", { textContent: "Name" }), nameInput,
    el("label", { textContent: "Kategorie" }), catSelect,
    el("label", { textContent: "Beschreibung" }), descInput,
    el("label", { textContent: "Preis Design (€)" }), priceInput,
    el("label", { textContent: "Preis PNG-Dateien, alle Motive (€)" }), pricePngInput,
    el("label", { textContent: "Preis Hintergrund (€)" }), priceHintergrundInput,
    el("label", { textContent: "Kauf-Link" }), linkInput,
    el("label", { textContent: "Instagram-Link" }), instagramInput,
    el("label", { textContent: "Google-Drive-Link (intern)" }), driveInput,
    el("label", { textContent: "Tags" }), tagInput,
    errorMsg,
    el("div", { className: "card-actions" }, [saveBtn, cancelBtn]),
    el("label", { textContent: "Bilder-Varianten" }),
    renderImageThumbs(d)
  );
}

function sortedFilteredDesigns() {
  const categoryFilter = categoryFilterEl.value;
  const onlineFilter = onlineFilterEl.value;

  let list = allDesigns.filter((d) => {
    const matchesCategory = categoryFilter === "alle" || d.category === categoryFilter;
    const matchesOnline =
      onlineFilter === "alle" ||
      (onlineFilter === "online" && Boolean(d.online)) ||
      (onlineFilter === "offline" && !d.online);
    return matchesCategory && matchesOnline;
  });

  list = [...list];
  if (sortEl.value === "kategorie") {
    list.sort((a, b) => a.category.localeCompare(b.category, "de") || a.name.localeCompare(b.name, "de"));
  } else if (sortEl.value === "name") {
    list.sort((a, b) => a.name.localeCompare(b.name, "de"));
  }
  // "neueste" entspricht der vom Server gelieferten Reihenfolge (neueste zuerst)

  return list;
}

function updateBulkToolbar() {
  bulkToolbarEl.hidden = selectedIds.size === 0;
  bulkCountEl.textContent = `${selectedIds.size} ausgewählt`;
}

function renderDesigns() {
  const designs = sortedFilteredDesigns();
  cardsEl.innerHTML = "";
  emptyEl.hidden = designs.length > 0;

  designs.forEach((d) => {
    const checkbox = el("input", { type: "checkbox", className: "select-checkbox", checked: selectedIds.has(d.id) });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(d.id);
      else selectedIds.delete(d.id);
      updateBulkToolbar();
    });

    const img = el("img", { src: d.image, alt: d.name });
    const body = el("div", { className: "admin-card-body" });
    renderCardView(d, body);
    const card = el("div", { className: "admin-card" }, [checkbox, img, body]);
    cardsEl.appendChild(card);
  });
}

async function loadDesigns() {
  const res = await fetch("/api/admin/designs");
  allDesigns = await res.json();
  renderDesigns();
}

cardsEl.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.dataset.id;
  if (!confirm("Dieses Design wirklich löschen?")) return;
  await fetch(`/api/admin/designs/${id}`, { method: "DELETE" });
  loadDesigns();
});

cardsEl.addEventListener("change", async (e) => {
  if (e.target.classList.contains("status-select")) {
    const id = e.target.dataset.id;
    await fetch(`/api/admin/designs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: e.target.value }),
    });
  } else if (e.target.classList.contains("online-select")) {
    const id = e.target.dataset.id;
    await fetch(`/api/admin/designs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ online: e.target.value === "1" }),
    });
    const design = allDesigns.find((d) => d.id === id);
    if (design) design.online = e.target.value === "1";
  }
});

document.getElementById("bulk-online").addEventListener("click", () => bulkSetOnline(true));
document.getElementById("bulk-offline").addEventListener("click", () => bulkSetOnline(false));
document.getElementById("bulk-delete").addEventListener("click", async () => {
  if (!confirm(`${selectedIds.size} Design(s) wirklich unwiderruflich löschen?`)) return;
  await Promise.all([...selectedIds].map((id) => fetch(`/api/admin/designs/${id}`, { method: "DELETE" })));
  selectedIds.clear();
  updateBulkToolbar();
  loadDesigns();
});

async function bulkSetOnline(online) {
  await Promise.all(
    [...selectedIds].map((id) =>
      fetch(`/api/admin/designs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ online }),
      })
    )
  );
  selectedIds.clear();
  updateBulkToolbar();
  loadDesigns();
}

categoryFilterEl.addEventListener("change", renderDesigns);
onlineFilterEl.addEventListener("change", renderDesigns);
sortEl.addEventListener("change", renderDesigns);

// "Unsortiert" ist der bewusste Ausweg, wenn nichts passt (Ausbau 1.8/K5) -
// steht deshalb immer als letzter Eintrag der Liste, nie als Vorauswahl.
function sortCategoriesUnsortiertLast(cats) {
  return [...cats].sort((a, b) => (a === "Unsortiert") - (b === "Unsortiert"));
}

async function init() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categories = sortCategoriesUnsortiertLast(config.categories);
  allTags = config.tags || [];

  categoryFilterEl.appendChild(el("option", { value: "alle", textContent: "Alle Kategorien" }));
  categories.forEach((c) => categoryFilterEl.appendChild(el("option", { value: c, textContent: c })));

  loadDesigns();
}

init();
