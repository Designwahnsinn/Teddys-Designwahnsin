const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const categorySelect = document.getElementById("category");
const nextIdHint = document.getElementById("next-id-hint");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

async function loadCategories() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categorySelect.innerHTML = "";
  config.categories.forEach((c) => {
    categorySelect.appendChild(el("option", { value: c, textContent: c }));
  });
}

async function loadNextId() {
  const res = await fetch("/api/admin/designs/next-id");
  if (!res.ok) return;
  const data = await res.json();
  nextIdHint.textContent = `Nächste ID: ${data.id}`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  message.className = "";

  const formData = new FormData(form);
  const res = await fetch("/api/admin/designs", { method: "POST", body: formData });

  if (res.ok) {
    const data = await res.json();
    if (data.qualityWarnings && data.qualityWarnings.length > 0) {
      message.textContent = `Design hochgeladen. ⚠️ ${data.qualityWarnings.join(" | ")}`;
      message.className = "warning";
    } else {
      message.textContent = "Design hochgeladen.";
      message.className = "success";
    }
    form.reset();
    loadNextId();
  } else {
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || "Fehler beim Hochladen.";
    message.className = "error";
  }
});

loadCategories();
loadNextId();
