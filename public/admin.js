const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const cardsEl = document.getElementById("admin-cards");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

async function loadDesigns() {
  const res = await fetch("/api/admin/designs");
  const designs = await res.json();
  cardsEl.innerHTML = "";
  designs.forEach((d) => {
    const img = el("img", { src: d.image, alt: d.name });
    const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen" });
    deleteBtn.dataset.id = d.id;
    const body = el("div", { className: "admin-card-body" }, [
      el("h3", { textContent: d.name }),
      el("p", { textContent: d.description || "" }),
      deleteBtn,
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

loadDesigns();
