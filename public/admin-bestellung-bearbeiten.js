const titleEl = document.getElementById("edit-title");
const panelEl = document.getElementById("edit-panel");

const STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt"];
const STEP_LABELS = {
  schritt_rechnung: "Rechnung erstellt",
  schritt_download: "Design(s) heruntergeladen",
  schritt_email_vorbereitet: "E-Mail vorbereitet",
  schritt_verschickt: "Als verschickt markiert",
  schritt_datei_geloescht: "Datei(en) lokal gelöscht",
};

const orderId = new URLSearchParams(window.location.search).get("id");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

async function loadOrder(id) {
  const res = await fetch(`/api/admin/orders/${id}`);
  if (!res.ok) throw new Error("Bestellung nicht gefunden");
  return res.json();
}

async function loadAllDesigns() {
  const res = await fetch("/api/admin/designs");
  return res.json();
}

function render(order, allDesigns) {
  titleEl.textContent = `Bestellung #${order.id} bearbeiten`;
  panelEl.innerHTML = "";

  const assignedIds = new Set(order.designs.map((d) => d.id));
  const errorMsg = el("p", { className: "wizard-error" });
  const successMsg = el("p", { className: "wizard-hint" });

  // --- Kunde ---
  const nameInput = el("input", { type: "text", value: order.kunde_name, required: true });
  const emailInput = el("input", { type: "email", value: order.kunde_email, required: true });

  // --- Status ---
  const statusSelect = el("select");
  STATUS_VALUES.forEach((s) => {
    statusSelect.appendChild(el("option", { value: s, textContent: s, selected: s === order.status }));
  });

  // --- Notiz ---
  const notizInput = el("textarea", { rows: 3, value: order.notiz || "" });

  // --- Designs (alle, auch bereits verkaufte, damit historische Zuordnungen sichtbar bleiben) ---
  const designList = el("div", { className: "wizard-design-list" });
  const designCheckboxes = new Map();
  allDesigns.forEach((d) => {
    const checkbox = el("input", { type: "checkbox", checked: assignedIds.has(d.id) });
    designCheckboxes.set(d.id, checkbox);
    designList.appendChild(
      el("label", { className: "wizard-design-row" }, [
        checkbox,
        el("img", { src: d.image, alt: d.name }),
        el("span", { textContent: `${d.id} · ${d.name}${d.price != null ? " · " + formatPrice(d.price) : ""}` }),
      ])
    );
  });

  // --- Schritte, frei an-/abhakbar ---
  const stepCheckboxes = new Map();
  const stepsList = el("div", { className: "wizard-design-list" });
  Object.entries(STEP_LABELS).forEach(([key, label]) => {
    const checkbox = el("input", { type: "checkbox", checked: Boolean(order[key]) });
    stepCheckboxes.set(key, checkbox);
    stepsList.appendChild(el("label", { className: "wizard-design-row" }, [checkbox, el("span", { textContent: label })]));
  });

  const saveBtn = el("button", { type: "button", textContent: "Speichern" });
  saveBtn.addEventListener("click", async () => {
    errorMsg.textContent = "";
    successMsg.textContent = "";

    const designIds = [...designCheckboxes.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    if (designIds.length === 0) {
      errorMsg.textContent = "Mindestens ein Design muss zugeordnet sein.";
      return;
    }

    const patchBody = {
      kunde_name: nameInput.value.trim(),
      kunde_email: emailInput.value.trim(),
      status: statusSelect.value,
      notiz: notizInput.value,
    };
    stepCheckboxes.forEach((cb, key) => { patchBody[key] = cb.checked; });

    const [orderRes, designsRes] = await Promise.all([
      fetch(`/api/admin/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      }),
      fetch(`/api/admin/orders/${order.id}/designs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designIds }),
      }),
    ]);

    if (!orderRes.ok || !designsRes.ok) {
      const data = await (orderRes.ok ? designsRes : orderRes).json().catch(() => ({}));
      errorMsg.textContent = data.error || "Fehler beim Speichern.";
      return;
    }

    const updated = await orderRes.json();
    successMsg.textContent = "Gespeichert.";
    render(updated, allDesigns);
  });

  const deleteBtn = el("button", { type: "button", className: "delete-btn", textContent: "Bestellung löschen" });
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Bestellung #${order.id} von ${order.kunde_name} wirklich unwiderruflich löschen?`)) return;
    const res = await fetch(`/api/admin/orders/${order.id}`, { method: "DELETE" });
    if (res.ok) {
      window.location.href = "/mitarbeiter/bestellungen";
    } else {
      const data = await res.json().catch(() => ({}));
      errorMsg.textContent = data.error || "Fehler beim Löschen.";
    }
  });

  panelEl.append(
    el("label", { textContent: "Kundenname" }), nameInput,
    el("label", { textContent: "E-Mail" }), emailInput,
    el("label", { textContent: "Status" }), statusSelect,
    el("label", { textContent: "Notiz" }), notizInput,
    el("h2", { textContent: "Zugeordnete Designs" }),
    designList,
    el("h2", { textContent: "Schritte" }),
    stepsList,
    errorMsg,
    successMsg,
    el("div", { className: "card-actions" }, [saveBtn, deleteBtn])
  );
}

async function init() {
  if (!orderId) {
    panelEl.textContent = "Keine Bestellung ausgewählt.";
    return;
  }
  try {
    const [order, allDesigns] = await Promise.all([loadOrder(orderId), loadAllDesigns()]);
    render(order, allDesigns);
  } catch (err) {
    panelEl.textContent = err.message;
  }
}

init();
