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

async function init() {
  const res = await fetch("/api/admin/design-lizenzen");
  allRechte = await res.json();
  render();
}

init();
