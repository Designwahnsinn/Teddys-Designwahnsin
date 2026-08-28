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
  const revokeBtn = el("button", { type: "button", className: "delete-btn", textContent: "Aufheben" });
  revokeBtn.addEventListener("click", async () => {
    if (!confirm(`Exklusivität für ${r.design_id} · ${r.designName}${r.gruppe ? ` (${r.gruppe})` : ""} wirklich aufheben? Die Bestellung selbst bleibt erhalten, nur die Rechte-Vergabe wird gelöscht.`)) return;
    const res = await fetch(`/api/admin/design-lizenzen/${r.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("Fehler beim Aufheben.");
      return;
    }
    allRechte = await res.json();
    render();
  });

  return el("tr", {}, [
    el("td", {}, [
      el("span", { textContent: `${r.design_id} · ${r.designName}` }),
    ]),
    el("td", { textContent: r.gruppe || "(ohne Gruppe)" }),
    el("td", { textContent: BESTANDTEIL_LABEL[r.bestandteil] || r.bestandteil }),
    el("td", { textContent: `${r.kunde_name} (${r.kunde_email})` }),
    el("td", { textContent: formatDate(r.createdAt) }),
    el("td", { className: "order-table-actions" }, [
      el("a", { className: "admin-nav-link", textContent: "Bestellung ansehen", href: `/mitarbeiter/bestellungen/bearbeiten?id=${r.order_id}` }),
      revokeBtn,
    ]),
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
// Mehrzeilig (Feedback #17): mehrere Design/Varianten-Kombinationen aus
// demselben persönlich vereinbarten Verkauf landen dadurch in einer
// gemeinsamen Beleg-Bestellung statt in mehreren unabhängigen. Die
// Variante/Gruppe ist bewusst ein <select> aus den tatsächlich am Design
// vorhandenen Gruppen statt Freitext - ein Tippfehler würde sonst dazu
// führen, dass die Exklusivität nirgends greift (exakter String-Abgleich
// in findExklusivKonflikte).

const manualForm = document.getElementById("rechte-manual-form");
const manualRowsEl = document.getElementById("rechte-manual-rows");
const manualAddRowBtn = document.getElementById("rechte-manual-add-row");
const manualDesignList = document.getElementById("rechte-manual-design-list");
const manualKundeInput = document.getElementById("rechte-manual-kunde");
const manualNotizInput = document.getElementById("rechte-manual-notiz");
const manualError = document.getElementById("rechte-manual-error");

let allDesigns = [];
let manualRows = [];

function findDesignByInput(value) {
  const trimmed = (value || "").trim();
  return allDesigns.find((d) => d.id.toLowerCase() === trimmed.toLowerCase())
    || allDesigns.find((d) => `${d.id} · ${d.name}` === trimmed);
}

async function fetchGruppen(designId) {
  const res = await fetch(`/api/admin/designs/${designId}/images`);
  if (!res.ok) return [];
  const images = await res.json();
  return [...new Set(images.map((img) => img.gruppe).filter(Boolean))];
}

function addManualRow() {
  const designInput = el("input", { type: "text", placeholder: "TD-ID oder Name …" });
  designInput.setAttribute("list", "rechte-manual-design-list");
  const gruppeSelect = el("select");
  gruppeSelect.appendChild(el("option", { value: "", textContent: "— ganzes Design ohne Varianten —" }));
  gruppeSelect.disabled = true;

  designInput.addEventListener("change", async () => {
    const design = findDesignByInput(designInput.value);
    gruppeSelect.innerHTML = "";
    gruppeSelect.appendChild(el("option", { value: "", textContent: "— ganzes Design ohne Varianten —" }));
    if (!design) {
      gruppeSelect.disabled = true;
      return;
    }
    const gruppen = await fetchGruppen(design.id);
    gruppen.forEach((g) => gruppeSelect.appendChild(el("option", { value: g, textContent: g })));
    gruppeSelect.disabled = false;
  });

  const removeBtn = el("button", { type: "button", className: "delete-btn", textContent: "✕" });
  const row = { designInput, gruppeSelect, wrap: null };
  removeBtn.addEventListener("click", () => {
    if (manualRows.length <= 1) return; // mindestens eine Zeile muss bleiben
    manualRows = manualRows.filter((r) => r !== row);
    row.wrap.remove();
  });

  const wrap = el("div", { className: "rechte-manual-row" }, [designInput, gruppeSelect, removeBtn]);
  row.wrap = wrap;
  manualRows.push(row);
  manualRowsEl.appendChild(wrap);
}

manualAddRowBtn.addEventListener("click", addManualRow);

manualForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  manualError.textContent = "";

  const items = [];
  for (const row of manualRows) {
    const design = findDesignByInput(row.designInput.value);
    if (!design) {
      manualError.textContent = "Bei jeder Zeile muss ein Design aus der Liste gewählt werden.";
      return;
    }
    items.push({ designId: design.id, gruppe: row.gruppeSelect.value });
  }

  const res = await fetch("/api/admin/design-lizenzen/manuell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items,
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
  manualRowsEl.innerHTML = "";
  manualRows = [];
  addManualRow();
});

async function init() {
  const [rechteRes, designsRes] = await Promise.all([
    fetch("/api/admin/design-lizenzen"),
    fetch("/api/admin/designs"),
  ]);
  allRechte = await rechteRes.json();
  allDesigns = await designsRes.json();
  allDesigns.forEach((d) => manualDesignList.appendChild(el("option", { value: `${d.id} · ${d.name}` })));
  addManualRow();
  render();
}

init();
