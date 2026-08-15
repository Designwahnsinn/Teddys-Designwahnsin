const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const categorySelect = document.getElementById("category");
const nextIdHint = document.getElementById("next-id-hint");
const imageInput = document.getElementById("image");
const filePreview = document.getElementById("image-file-preview");
const tagsField = document.getElementById("tags-field");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

// Freies Mehrfach-Tag-Eingabefeld mit Autovervollständigung aus bereits
// vorhandenen Tags. Die Auswahl landet in einem versteckten JSON-Feld
// (name="tags"), damit sie über das normale <form>/FormData (wegen
// Datei-Upload) mitgeschickt wird - server-admin.js parst es dort.
function buildTagInput(allTags) {
  const selected = [];
  const wrap = el("div", { className: "tag-input" });
  const chipsEl = el("div", { className: "tag-input-chips" });
  const textInput = el("input", { type: "text", placeholder: "Tag eingeben und Enter …", className: "tag-input-field" });
  const suggestionsEl = el("div", { className: "tag-input-suggestions", hidden: true });
  const hiddenInput = el("input", { type: "hidden", name: "tags" });

  function syncHidden() {
    hiddenInput.value = JSON.stringify(selected);
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    selected.forEach((tag) => {
      const removeBtn = el("button", { type: "button", textContent: "×", "aria-label": `${tag} entfernen` });
      removeBtn.addEventListener("click", () => {
        selected.splice(selected.indexOf(tag), 1);
        renderChips();
        syncHidden();
      });
      chipsEl.appendChild(el("span", { className: "tag-chip" }, [document.createTextNode(tag), removeBtn]));
    });
  }

  function addTag(name) {
    const trimmed = name.trim();
    if (!trimmed || selected.includes(trimmed)) return;
    selected.push(trimmed);
    renderChips();
    syncHidden();
    textInput.value = "";
    suggestionsEl.hidden = true;
  }

  function updateSuggestions() {
    const query = textInput.value.trim().toLowerCase();
    suggestionsEl.innerHTML = "";
    if (!query) { suggestionsEl.hidden = true; return; }
    const matches = allTags.filter((t) => t.toLowerCase().includes(query) && !selected.includes(t)).slice(0, 8);
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
  syncHidden();
  wrap.append(chipsEl, textInput, suggestionsEl, hiddenInput);
  return wrap;
}

async function loadCategories() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categorySelect.innerHTML = "";
  config.categories.forEach((c) => {
    categorySelect.appendChild(el("option", { value: c, textContent: c }));
  });
  tagsField.appendChild(buildTagInput(config.tags || []));
}

async function loadNextId() {
  const res = await fetch("/api/admin/designs/next-id");
  if (!res.ok) return;
  const data = await res.json();
  nextIdHint.textContent = `Nächste ID: ${data.id}`;
}

imageInput.addEventListener("change", () => {
  filePreview.innerHTML = "";
  [...imageInput.files].forEach((file) => {
    filePreview.appendChild(el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }));
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  message.className = "";

  const formData = new FormData(form);
  const res = await fetch("/api/admin/designs", { method: "POST", body: formData });

  if (res.ok) {
    const data = await res.json();
    if (data.qualityWarnings && data.qualityWarnings.length > 0) {
      message.textContent = `Design hochgeladen. ⚠️ ${data.qualityWarnings.join(" | ")} Weiter zur Bilder-Zuordnung …`;
      message.className = "warning";
    } else {
      message.textContent = "Design hochgeladen. Weiter zur Bilder-Zuordnung …";
      message.className = "success";
    }
    window.location.href = `/mitarbeiter/designs/bilder?id=${data.id}`;
  } else {
    const data = await res.json().catch(() => ({}));
    message.textContent = data.error || "Fehler beim Hochladen.";
    message.className = "error";
  }
});

loadCategories();
loadNextId();
