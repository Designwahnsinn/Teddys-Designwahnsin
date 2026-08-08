const filtersEl = document.getElementById("order-filters");
const rowsEl = document.getElementById("order-rows");
const emptyEl = document.getElementById("order-empty");

const STATUS_FILTERS = ["Alle", "Offen", "In Bearbeitung", "Erledigt"];
const STEP_LABELS = {
  schritt_rechnung: "Rechnung erstellen",
  schritt_download: "Design(s) herunterladen",
  schritt_email_vorbereitet: "E-Mail vorbereiten",
  schritt_verschickt: "Als verschickt markieren",
  schritt_datei_geloescht: "Datei(en) lokal löschen",
};
const STEP_ORDER = Object.keys(STEP_LABELS);

let activeFilter = "Alle";

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function currentStepLabel(order) {
  if (order.status === "Erledigt") return "Abgeschlossen";
  if (order.designs.length === 0) return "Designs auswählen";
  for (const step of STEP_ORDER) {
    if (!order[step]) return STEP_LABELS[step];
  }
  return "Bereit zum Abschließen";
}

function renderFilters() {
  filtersEl.innerHTML = "";
  STATUS_FILTERS.forEach((label) => {
    const btn = el("button", {
      type: "button",
      className: `filter-btn${label === activeFilter ? " active" : ""}`,
      textContent: label,
    });
    btn.addEventListener("click", () => {
      activeFilter = label;
      renderFilters();
      loadOrders();
    });
    filtersEl.appendChild(btn);
  });
}

async function loadOrders() {
  const query = activeFilter === "Alle" ? "" : `?status=${encodeURIComponent(activeFilter)}`;
  const res = await fetch(`/api/admin/orders${query}`);
  const orders = await res.json();

  rowsEl.innerHTML = "";
  emptyEl.hidden = orders.length > 0;

  orders.forEach((order) => {
    const row = el("tr", { className: "order-row" });
    row.addEventListener("click", () => {
      window.location.href = `/mitarbeiter/bestellungen/neu?id=${order.id}`;
    });

    const editLink = el("a", { className: "admin-nav-link", textContent: "✏️ Bearbeiten", href: `/mitarbeiter/bestellungen/bearbeiten?id=${order.id}` });
    editLink.addEventListener("click", (e) => e.stopPropagation());

    const contactIcon = order.kontakt_praeferenz === "WhatsApp" ? "💬 WhatsApp" : "📧 E-Mail";

    row.append(
      el("td", {}, [
        el("strong", { textContent: order.kunde_name }),
        el("div", { className: "muted", textContent: order.kunde_email }),
        el("div", { className: "muted", textContent: contactIcon }),
      ]),
      el("td", { textContent: order.designs.map((d) => d.name).join(", ") || "–" }),
      el("td", { textContent: currentStepLabel(order) }),
      el("td", { textContent: formatDate(order.bestelldatum) }),
      el("td", {}, [el("span", { className: `status-badge status-${order.status.replace(/\s+/g, "-").toLowerCase()}`, textContent: order.status })]),
      el("td", {}, [editLink])
    );
    rowsEl.appendChild(row);
  });
}

renderFilters();
loadOrders();
