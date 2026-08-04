const categoryListEl = document.getElementById("category-list");
const categoryMessage = document.getElementById("category-message");
const newCategoryInput = document.getElementById("new-category-name");
const addCategoryBtn = document.getElementById("add-category-btn");

let categories = [];

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function setCategoryMessage(text, type) {
  categoryMessage.textContent = text;
  categoryMessage.className = type || "";
}

function renderCategoryManager() {
  categoryListEl.innerHTML = "";
  categories.forEach((c) => {
    const input = el("input", { type: "text", value: c });

    const saveBtn = el("button", { className: "save-btn", textContent: "Umbenennen", type: "button" });
    saveBtn.addEventListener("click", async () => {
      const newName = input.value.trim();
      if (newName === c) return;
      const res = await fetch("/api/admin/categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldName: c, newName }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCategoryMessage(`"${c}" wurde zu "${newName}" umbenannt.`, "success");
        loadCategories();
      } else {
        setCategoryMessage(data.error || "Fehler beim Umbenennen.", "error");
      }
    });

    const deleteBtn = el("button", { className: "delete-btn", textContent: "Löschen", type: "button" });
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Kategorie "${c}" wirklich löschen?`)) return;
      const res = await fetch(`/api/admin/categories/${encodeURIComponent(c)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCategoryMessage(`"${c}" gelöscht.`, "success");
        loadCategories();
      } else {
        setCategoryMessage(data.error || "Fehler beim Löschen.", "error");
      }
    });

    categoryListEl.appendChild(el("div", { className: "category-row" }, [input, saveBtn, deleteBtn]));
  });
}

async function loadCategories() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categories = config.categories;
  renderCategoryManager();
}

addCategoryBtn.addEventListener("click", async () => {
  const name = newCategoryInput.value.trim();
  if (!name) return;
  const res = await fetch("/api/admin/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    setCategoryMessage(`"${name}" hinzugefügt.`, "success");
    newCategoryInput.value = "";
    loadCategories();
  } else {
    setCategoryMessage(data.error || "Fehler beim Hinzufügen.", "error");
  }
});

loadCategories();
