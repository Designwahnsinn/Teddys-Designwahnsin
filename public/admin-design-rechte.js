const searchInput = document.getElementById("rechte-search");
const rowsEl = document.getElementById("rechte-rows");
const emptyEl = document.getElementById("rechte-empty");

let allRechte = [];

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const BESTANDTEIL_LABEL = { design: "Design", png: "PNG-Dateien", hintergrund: "Hintergrund" };

function renderRow(r) {
  return el("tr", {}, [
    el("td", {}, [
      el("span", { textContent: `${r.design_id} · ${r.designName}` }),
    ]),
    el("td", { textContent: r.gruppe || "(ohne Gruppe)" }),
    el("td", { textContent: BESTANDTEIL_LABEL[r.bestandteil] || r.bestandteil }),
    el("td", { textContent: `${r.kunde_name} (${r.kunde_email})` }),
    el("td", { textContent: formatDate(r.createdAt) }),
    el("td", {}, [el("a", { className: "admin-nav-link", textContent: "Bestellung ansehen", href: `/mitarbeiter/bestellungen/bearbeiten?id=${r.order_id}` })]),
  ]);
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = query
    ? allRechte.filter((r) =>
        r.design_id.toLowerCase().includes(query) ||
        r.designName.toLowerCase().includes(query) ||
        (r.gruppe || "").toLowerCase().includes(query) ||
        r.kunde_name.toLowerCase().includes(query) ||
        r.kunde_email.toLowerCase().includes(query)
      )
    : allRechte;

  rowsEl.innerHTML = "";
  emptyEl.hidden = filtered.length > 0;
  filtered.forEach((r) => rowsEl.appendChild(renderRow(r)));
}

searchInput.addEventListener("input", render);

// --- Rechte manuell erfassen (außerhalb des Bestellassistenten) ---

const manualForm = document.getElementById("rechte-manual-form");
const manualDesignInput = document.getElementById("rechte-manual-design");
const manualDesignList = document.getElementById("rechte-manual-design-list");
const manualGruppeInput = document.getElementById("rechte-manual-gruppe");
const manualGruppeList = document.getElementById("rechte-manual-gruppe-list");
const manualKundeInput = document.getElementById("rechte-manual-kunde");
const manualNotizInput = document.getElementById("rechte-manual-notiz");
const manualError = document.getElementById("rechte-manual-error");

let allDesigns = [];

function findDesignByInput(value) {
  const trimmed = value.trim();
  return allDesigns.find((d) => d.id.toLowerCase() === trimmed.toLowerCase())
    || allDesigns.find((d) => `${d.id} · ${d.name}` === trimmed);
}

async function updateGruppeSuggestions() {
  manualGruppeList.innerHTML = "";
  const design = findDesignByInput(manualDesignInput.value);
  if (!design) return;
  const res = await fetch(`/api/admin/designs/${design.id}/images`);
  if (!res.ok) return;
  const images = await res.json();
  const gruppen = [...new Set(images.map((img) => img.gruppe).filter(Boolean))];
  gruppen.forEach((g) => manualGruppeList.appendChild(el("option", { value: g })));
}

manualDesignInput.addEventListener("change", updateGruppeSuggestions);

manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  manualError.textContent = "";
  const design = findDesignByInput(manualDesignInput.value);
  if (!design) {
    manualError.textContent = "Design nicht gefunden - bitte aus der Liste wählen.";
    return;
  }
  const res = await fetch("/api/admin/design-lizenzen/manuell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      designId: design.id,
      gruppe: manualGruppeInput.value,
      kundeName: manualKundeInput.value,
      notiz: manualNotizInput.value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    manualError.textContent = data.error || "Fehler beim Erfassen.";
    return;
  }
  allRechte = data;
  render();
  manualForm.reset();
});

async function init() {
  const [rechteRes, designsRes] = await Promise.all([
    fetch("/api/admin/design-lizenzen"),
    fetch("/api/admin/designs"),
  ]);
  allRechte = await rechteRes.json();
  allDesigns = await designsRes.json();
  allDesigns.forEach((d) => manualDesignList.appendChild(el("option", { value: `${d.id} · ${d.name}` })));
  render();
}

init();
