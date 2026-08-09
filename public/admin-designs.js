const cardsEl = document.getElementById("admin-cards");
const emptyEl = document.getElementById("admin-empty");
const categoryFilterEl = document.getElementById("filter-category");
const onlineFilterEl = document.getElementById("filter-online");
const sortEl = document.getElementById("sort-designs");
const bulkToolbarEl = document.getElementById("bulk-toolbar");
const bulkCountEl = document.getElementById("bulk-count");

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];
let categories = [];
let allDesigns = [];
const selectedIds = new Set();

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
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

  const imagesLink = el("a", { className: "edit-btn", textContent: "🖼️ Bilder", href: `/mitarbeiter/designs/bilder?id=${d.id}` });

  const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
  deleteBtn.dataset.id = d.id;

  const children = [
    el("span", { className: "design-id", textContent: d.id }),
    el("p", { className: "category", textContent: d.category || "" }),
    el("h3", { textContent: d.name }),
    el("p", { textContent: [d.description, formatPrice(d.price)].filter(Boolean).join(" · ") }),
  ];
  if (d.driveLink) {
    children.push(el("p", { className: "drive-link" }, [
      el("a", { href: d.driveLink, target: "_blank", rel: "noopener", textContent: "📁 Originaldatei auf Drive" }),
    ]));
  }
  children.push(el("div", { className: "card-actions" }, [statusSelect, onlineSelect, editBtn, imagesLink, deleteBtn]));

  body.append(...children);
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
  const linkInput = el("input", { type: "url", value: d.kaufLink || "", placeholder: "https://…" });
  const instagramInput = el("input", { type: "url", value: d.instagramLink || "", placeholder: "https://instagram.com/p/…" });
  const driveInput = el("input", { type: "url", value: d.driveLink || "", placeholder: "https://drive.google.com/…" });

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
        kaufLink: linkInput.value.trim(),
        instagramLink: instagramInput.value.trim(),
        driveLink: driveInput.value.trim(),
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

  body.append(
    el("span", { className: "design-id", textContent: d.id }),
    el("label", { textContent: "Name" }), nameInput,
    el("label", { textContent: "Kategorie" }), catSelect,
    el("label", { textContent: "Beschreibung" }), descInput,
    el("label", { textContent: "Preis (€)" }), priceInput,
    el("label", { textContent: "Kauf-Link" }), linkInput,
    el("label", { textContent: "Instagram-Link" }), instagramInput,
    el("label", { textContent: "Google-Drive-Link (intern)" }), driveInput,
    errorMsg,
    el("div", { className: "card-actions" }, [saveBtn, cancelBtn])
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

async function init() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categories = config.categories;

  categoryFilterEl.appendChild(el("option", { value: "alle", textContent: "Alle Kategorien" }));
  categories.forEach((c) => categoryFilterEl.appendChild(el("option", { value: c, textContent: c })));

  loadDesigns();
}

init();
