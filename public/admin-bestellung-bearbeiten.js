const titleEl = document.getElementById("edit-title");
const panelEl = document.getElementById("edit-panel");

const STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt", "Storniert"];
const KONTAKT_PRAEFERENZ_VALUES = ["E-Mail", "WhatsApp"];
// Die meisten Schritt-Label funktionieren als Checkbox-Beschriftung in beiden
// Zuständen ("Rechnung erstellt" liest sich auch unmarkiert noch sinnvoll als
// Handlungsbeschreibung). "Auf Bezahlung warten"/"gewartet" nicht - deshalb
// dort ein {todo, done}-Paar statt eines starren Texts.
const STEP_LABELS = {
  schritt_rechnung: "Angebot/Rechnung erstellt",
  schritt_bezahlung: { todo: "Auf Bezahlung warten", done: "Ist bezahlt" },
  schritt_download: "Design(s) heruntergeladen",
  schritt_email_vorbereitet: "E-Mail vorbereitet",
  schritt_verschickt: "Als verschickt markiert",
  schritt_datei_geloescht: "Datei(en) lokal gelöscht",
};

function stepLabelFor(key, done) {
  const label = STEP_LABELS[key];
  if (typeof label === "string") return label;
  return done ? label.done : label.todo;
}

const orderId = new URLSearchParams(window.location.search).get("id");
const PUBLIC_ORIGIN = "https://designwahnsinn-teddy.de";

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
  const instagramInput = el("input", { type: "text", value: order.kunde_instagram || "", placeholder: "@name" });
  const whatsappInput = el("input", { type: "tel", value: order.kunde_whatsapp || "", placeholder: "+49 …" });
  const praeferenzSelect = el("select");
  KONTAKT_PRAEFERENZ_VALUES.forEach((v) => {
    praeferenzSelect.appendChild(el("option", { value: v, textContent: v, selected: v === order.kontakt_praeferenz }));
  });

  // --- Status ---
  const statusSelect = el("select");
  STATUS_VALUES.forEach((s) => {
    statusSelect.appendChild(el("option", { value: s, textContent: s, selected: s === order.status }));
  });

  // --- Notiz (v.a. für Designs, die es noch nicht im System gibt, z.B. nur auf Instagram) ---
  const notizInput = el("textarea", {
    rows: 3,
    value: order.notiz || "",
    placeholder: "z. B. weiteres Design von Instagram gewünscht, noch nicht hochgeladen …",
  });

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
  Object.keys(STEP_LABELS).forEach((key) => {
    const checkbox = el("input", { type: "checkbox", checked: Boolean(order[key]) });
    const labelSpan = el("span", { textContent: stepLabelFor(key, checkbox.checked) });
    checkbox.addEventListener("change", () => {
      labelSpan.textContent = stepLabelFor(key, checkbox.checked);
    });
    stepCheckboxes.set(key, checkbox);
    stepsList.appendChild(el("label", { className: "wizard-design-row" }, [checkbox, labelSpan]));
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
      kunde_instagram: instagramInput.value.trim(),
      kunde_whatsapp: whatsappInput.value.trim(),
      kontakt_praeferenz: praeferenzSelect.value,
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

  // --- Order-Portal ---
  const confirmationLink = `${PUBLIC_ORIGIN}/bestellung/${order.access_token}`;
  const linkInput = el("input", { type: "text", value: confirmationLink, readOnly: true });
  const copyBtn = el("button", { type: "button", textContent: "Link kopieren" });
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(confirmationLink);
    copyBtn.textContent = "Kopiert ✓";
    setTimeout(() => { copyBtn.textContent = "Link kopieren"; }, 1500);
  });

  const confirmStatus = el("p", {
    className: "wizard-hint",
    textContent: order.terms_confirmed_at
      ? `✅ Vom Kunden bestätigt am ${new Date(order.terms_confirmed_at).toLocaleString("de-DE")} (IP: ${order.terms_confirmed_ip})`
      : "⏳ Noch nicht vom Kunden bestätigt.",
  });

  const freigabeLabel = el("label", { className: "online-toggle-field" });
  const freigabeCheckbox = el("input", { type: "checkbox", checked: Boolean(order.download_freigegeben) });
  freigabeCheckbox.addEventListener("change", async () => {
    await fetch(`/api/admin/orders/${order.id}/freigabe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freigegeben: freigabeCheckbox.checked }),
    });
  });
  freigabeLabel.append(freigabeCheckbox, document.createTextNode(" Für Kunden-Download freigeben"));

  const regenerateBtn = el("button", { type: "button", className: "cancel-btn", textContent: "Neuen Link generieren" });
  regenerateBtn.addEventListener("click", async () => {
    if (!confirm("Neuen Link generieren? Der alte Link funktioniert danach nicht mehr, und eine vorhandene Bestätigung des Kunden wird gelöscht.")) return;
    const res = await fetch(`/api/admin/orders/${order.id}/regenerate-token`, { method: "POST" });
    if (res.ok) {
      const updated = await loadOrder(order.id);
      render(updated, allDesigns);
    }
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
    el("label", { textContent: "Instagram-Name" }), instagramInput,
    el("label", { textContent: "WhatsApp-Nummer" }), whatsappInput,
    el("label", { textContent: "Kontaktpräferenz" }), praeferenzSelect,
    el("label", { textContent: "Status" }), statusSelect,
    el("h2", { textContent: "Zugeordnete Designs" }),
    designList,
    el("label", { textContent: "Notiz (auch für Designs, die es noch nicht im System gibt)" }), notizInput,
    el("h2", { textContent: "Schritte" }),
    stepsList,
    el("h2", { textContent: "Order-Portal (Kunden-Bestätigungsseite)" }),
    el("label", { textContent: "Bestätigungslink" }),
    el("div", { className: "card-actions" }, [linkInput, copyBtn]),
    confirmStatus,
    freigabeLabel,
    el("div", { className: "card-actions" }, [regenerateBtn]),
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
