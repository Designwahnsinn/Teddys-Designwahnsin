const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const cardsEl = document.getElementById("admin-cards");
const categorySelect = document.getElementById("category");

const STATUS_VALUES = ["verfügbar", "exklusiv", "verkauft"];

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

async function loadCategories() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categorySelect.innerHTML = "";
  config.categories.forEach((c) => {
    categorySelect.appendChild(el("option", { value: c, textContent: c }));
  });
}

async function loadDesigns() {
  const res = await fetch("/api/admin/designs");
  const designs = await res.json();
  cardsEl.innerHTML = "";
  designs.forEach((d) => {
    const img = el("img", { src: d.image, alt: d.name });

    const statusSelect = el("select", { className: "status-select" });
    STATUS_VALUES.forEach((s) => {
      statusSelect.appendChild(el("option", { value: s, textContent: s, selected: s === d.status }));
    });
    statusSelect.dataset.id = d.id;

    const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
    deleteBtn.dataset.id = d.id;

    const body = el("div", { className: "admin-card-body" }, [
      el("span", { className: "design-id", textContent: d.id }),
      el("p", { className: "category", textContent: d.category || "" }),
      el("h3", { textContent: d.name }),
      el("p", { textContent: [d.description, formatPrice(d.price)].filter(Boolean).join(" · ") }),
      el("div", { className: "card-actions" }, [statusSelect, deleteBtn]),
    ]);
    const card = el("div", { className: "admin-card" }, [img, body]);
    cardsEl.appendChild(card);
  });
}

cardsEl.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.dataset.id;
  if (!confirm("Dieses Design wirklich löschen?")) return;
  await fetch(`/api/admin/designs/${id}`, { method: "DELETE" });
  loadDesigns();
});

cardsEl.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("status-select")) return;
  const id = e.target.dataset.id;
  await fetch(`/api/admin/designs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: e.target.value }),
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  message.className = "";

  const formData = new FormData(form);
  const res = await fetch("/api/admin/designs", { method: "POST", body: formData });

  if (res.ok) {
    message.textContent = "Design hochgeladen.";
    message.className = "success";
    form.reset();
    loadDesigns();
  } else {
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || "Fehler beim Hochladen.";
    message.className = "error";
  }
});

loadCategories();
loadDesigns();
