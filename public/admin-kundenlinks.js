const filtersEl = document.getElementById("kundenlinks-filters");
const rowsEl = document.getElementById("kundenlinks-rows");
const emptyEl = document.getElementById("kundenlinks-empty");

const PUBLIC_ORIGIN = "https://designwahnsinn-teddy.de";
const FILTERS = ["Alle", "Aktive"];
// Auch bei "Erledigt"/"Storniert" kann der Link noch gebraucht werden (z.B.
// falls eine Kundin nachträglich nochmal nachfragt) - "Alle" ist deshalb die
// Standardansicht, "Aktive" bleibt als Filter für den schnellen Überblick
// über die noch offenen Fälle erhalten.
const INACTIVE_STATUS = ["Erledigt", "Storniert"];

let activeFilter = "Alle";
let allOrders = [];
let validityDays = 90;

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Gültigkeit hängt am zuletzt vergebenen Token, nicht am Bestelldatum - ein
// neu generierter Link (z.B. nach Ablauf) startet die 90 Tage neu.
function linkInfo(order) {
  const createdAt = new Date(order.token_created_at);
  const validUntil = new Date(createdAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const remainingDays = Math.ceil((validUntil - Date.now()) / (24 * 60 * 60 * 1000));
  let status, label;
  if (remainingDays < 0) {
    status = "abgelaufen";
    label = `⛔ Abgelaufen seit ${Math.abs(remainingDays)} Tag${Math.abs(remainingDays) === 1 ? "" : "en"}`;
  } else if (remainingDays <= 7) {
    status = "laeuft-ab";
    label = `⚠️ Läuft in ${remainingDays} Tag${remainingDays === 1 ? "" : "en"} ab`;
  } else {
    status = "gueltig";
    label = `✅ Noch ${remainingDays} Tage gültig`;
  }
  return { validUntil, status, label };
}

function renderFilters() {
  filtersEl.innerHTML = "";
  FILTERS.forEach((label) => {
    const btn = el("button", {
      type: "button",
      className: `filter-btn${label === activeFilter ? " active" : ""}`,
      textContent: label,
    });
    btn.addEventListener("click", () => {
      activeFilter = label;
      renderFilters();
      render();
    });
    filtersEl.appendChild(btn);
  });
}

function visibleOrders() {
  const list = activeFilter === "Aktive" ? allOrders.filter((o) => !INACTIVE_STATUS.includes(o.status)) : allOrders;
  // Bald ablaufende/abgelaufene zuerst, damit die dringenden Fälle oben stehen.
  return [...list].sort((a, b) => new Date(a.token_created_at) - new Date(b.token_created_at));
}

async function regenerateLink(order, btn) {
  if (!confirm(`Neuen Link für ${order.kunde_name} generieren? Der alte Link funktioniert danach nicht mehr, eine vorhandene Bestätigung wird gelöscht.`)) return;
  btn.disabled = true;
  const res = await fetch(`/api/admin/orders/${order.id}/regenerate-token`, { method: "POST" });
  if (res.ok) {
    await loadOrders();
  } else {
    btn.disabled = false;
    alert("Fehler beim Generieren des neuen Links.");
  }
}

function render() {
  const orders = visibleOrders();
  rowsEl.innerHTML = "";
  emptyEl.hidden = orders.length > 0;

  orders.forEach((order) => {
    const { validUntil, status, label } = linkInfo(order);
    const link = `${PUBLIC_ORIGIN}/bestellung/${order.access_token}`;

    const confirmBadge = el("span", {
      className: order.terms_confirmed_at ? "confirm-badge confirm-yes" : "confirm-badge confirm-no",
      textContent: order.terms_confirmed_at ? "✅ Bestätigt" : "⏳ Ausstehend",
      title: order.terms_confirmed_at ? `Bestätigt am ${formatDate(order.terms_confirmed_at)}` : "Kunde hat noch nicht bestätigt",
    });

    const statusBadge = el("span", {
      className: `status-badge status-${order.status.toLowerCase().replace(/\s+/g, "-")}`,
      textContent: order.status,
    });

    const linkBadge = el("span", { className: `link-status-badge link-status-${status}`, textContent: label });

    const linkInput = el("input", { type: "text", value: link, readOnly: true });
    const copyBtn = el("button", { type: "button", className: "kundenlinks-copy-btn", textContent: "Kopieren" });
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(link);
      copyBtn.textContent = "Kopiert ✓";
      setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
    });

    const regenerateBtn = el("button", { type: "button", className: "cancel-btn", textContent: "Neu generieren" });
    regenerateBtn.addEventListener("click", () => regenerateLink(order, regenerateBtn));

    const editLink = el("a", { className: "admin-nav-link", textContent: "✏️", href: `/mitarbeiter/bestellungen/bearbeiten?id=${order.id}`, title: "Bestellung bearbeiten" });

    const row = el("tr", {}, [
      el("td", {}, [
        el("strong", { textContent: order.kunde_name }),
        el("div", { className: "muted", textContent: order.kunde_email }),
      ]),
      el("td", {}, [statusBadge]),
      el("td", {}, [confirmBadge]),
      el("td", { textContent: formatDate(validUntil) }),
      el("td", {}, [linkBadge]),
      el("td", {}, [el("div", { className: "card-actions" }, [linkInput, copyBtn])]),
      el("td", {}, [el("div", { className: "card-actions" }, [regenerateBtn, editLink])]),
    ]);
    rowsEl.appendChild(row);
  });
}

async function loadOrders() {
  const res = await fetch("/api/admin/orders");
  allOrders = await res.json();
  render();
}

async function init() {
  const configRes = await fetch("/api/config");
  const config = await configRes.json();
  validityDays = config.orderTokenValidityDays || 90;

  renderFilters();
  await loadOrders();
}

init();
