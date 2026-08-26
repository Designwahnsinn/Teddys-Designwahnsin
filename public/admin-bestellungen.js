const searchInput = document.getElementById("order-search");
const filtersEl = document.getElementById("order-filters");
const testFiltersEl = document.getElementById("test-filters");
const rowsEl = document.getElementById("order-rows");
const emptyEl = document.getElementById("order-empty");

const STATUS_FILTERS = ["Alle", "Offen", "In Bearbeitung", "Erledigt", "Storniert"];
const STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt", "Storniert"];
// Orthogonal zum Status-Filter (eine Testbestellung kann in jedem Status
// sein) - deshalb ein zweiter, unabhängiger Filter statt eine Kombination
// aus beidem in einer Liste.
const TEST_FILTERS = ["Alle", "Ohne Tests", "Nur Tests"];
let testFilter = "Alle";
// "bestaetigt" ist keine eigene DB-Spalte, sondern leitet sich aus
// terms_confirmed_at ab - gleiches Modell wie in admin-bestellung-neu.js.
const STEP_LABELS = {
  schritt_rechnung: "Angebot/Rechnung erstellen",
  bestaetigt: "Auf Kunden-Bestätigung warten",
  schritt_bezahlung: "Auf Bezahlung warten",
  schritt_datei_geloescht: "Datei(en) lokal löschen",
};
const STEP_ORDER = Object.keys(STEP_LABELS);

function isStepDone(order, key) {
  if (key === "bestaetigt") return Boolean(order.terms_confirmed_at);
  return Boolean(order[key]);
}

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
    if (!isStepDone(order, step)) return STEP_LABELS[step];
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

function renderTestFilters() {
  testFiltersEl.innerHTML = "";
  TEST_FILTERS.forEach((label) => {
    const btn = el("button", {
      type: "button",
      className: `filter-btn${label === testFilter ? " active" : ""}`,
      textContent: label,
    });
    btn.addEventListener("click", () => {
      testFilter = label;
      renderTestFilters();
      loadOrders();
    });
    testFiltersEl.appendChild(btn);
  });
}

async function loadOrders() {
  const query = activeFilter === "Alle" ? "" : `?status=${encodeURIComponent(activeFilter)}`;
  const res = await fetch(`/api/admin/orders${query}`);
  let orders = await res.json();
  if (testFilter === "Ohne Tests") orders = orders.filter((o) => !o.ist_test);
  else if (testFilter === "Nur Tests") orders = orders.filter((o) => o.ist_test);

  const searchQuery = searchInput.value.trim().toLowerCase();
  if (searchQuery) {
    orders = orders.filter((o) =>
      o.kunde_name.toLowerCase().includes(searchQuery) ||
      o.kunde_email.toLowerCase().includes(searchQuery) ||
      (o.sevdesk_kundennummer || "").toLowerCase().includes(searchQuery)
    );
  }

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

    const confirmBadge = el("span", {
      className: order.terms_confirmed_at ? "confirm-badge confirm-yes" : "confirm-badge confirm-no",
      textContent: order.terms_confirmed_at ? "✅ Bestätigt" : "⏳ Ausstehend",
      title: order.terms_confirmed_at ? `Bestätigt am ${formatDate(order.terms_confirmed_at)}` : "Kunde hat noch nicht bestätigt",
    });

    const statusSelect = el("select", { className: "status-select" });
    STATUS_VALUES.forEach((s) => {
      statusSelect.appendChild(el("option", { value: s, textContent: s, selected: s === order.status }));
    });
    statusSelect.addEventListener("click", (e) => e.stopPropagation());
    statusSelect.addEventListener("change", async () => {
      await fetch(`/api/admin/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusSelect.value }),
      });
    });

    const badges = [];
    if (order.ist_test) badges.push(el("span", { className: "order-flag-badge order-flag-test", textContent: "🧪 Test" }));
    if (order.design_ausstehend) badges.push(el("span", { className: "order-flag-badge order-flag-pending", textContent: "⏳ Design ausstehend" }));

    row.append(
      el("td", {}, [
        el("strong", { textContent: order.kunde_name }),
        el("div", { className: "muted", textContent: order.kunde_email }),
        el("div", { className: "muted", textContent: contactIcon }),
        badges.length > 0 ? el("div", { className: "order-flag-row" }, badges) : null,
      ].filter(Boolean)),
      el("td", { textContent: order.designs.map((d) => d.name).join(", ") || "–" }),
      el("td", { textContent: currentStepLabel(order) }),
      el("td", { textContent: formatDate(order.bestelldatum) }),
      el("td", {}, [confirmBadge]),
      el("td", {}, [statusSelect]),
      el("td", {}, [editLink])
    );
    rowsEl.appendChild(row);
  });
}

searchInput.addEventListener("input", loadOrders);
renderFilters();
renderTestFilters();
loadOrders();
