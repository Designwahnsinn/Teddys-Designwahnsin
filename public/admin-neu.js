const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const categorySelect = document.getElementById("category");

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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  message.className = "";

  const formData = new FormData(form);
  const res = await fetch("/api/admin/designs", { method: "POST", body: formData });

  if (res.ok) {
    const data = await res.json();
    if (data.qualityWarning) {
      message.textContent = `Design hochgeladen. ⚠️ ${data.qualityWarning}`;
      message.className = "warning";
    } else {
      message.textContent = "Design hochgeladen.";
      message.className = "success";
    }
    form.reset();
  } else {
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || "Fehler beim Hochladen.";
    message.className = "error";
  }
});

loadCategories();
