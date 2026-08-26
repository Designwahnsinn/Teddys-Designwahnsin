const titleEl = document.getElementById("edit-title");
const panelEl = document.getElementById("edit-panel");

const STATUS_VALUES = ["Offen", "In Bearbeitung", "Erledigt", "Storniert"];
const KONTAKT_PRAEFERENZ_VALUES = ["E-Mail", "WhatsApp"];
// Die meisten Schritt-Label funktionieren als Checkbox-Beschriftung in beiden
// Zuständen ("Rechnung erstellt" liest sich auch unmarkiert noch sinnvoll als
// Handlungsbeschreibung). "Auf Bezahlung warten"/"gewartet" nicht - deshalb
// dort ein {todo, done}-Paar statt eines starren Texts.
// "Kunde hat bestätigt" und "Für Download freigegeben" sind hier keine
// Checkboxen - sie leiten sich aus terms_confirmed_at/download_freigegeben ab
// und haben eigene, dedizierte Bedienelemente weiter unten (Order-Portal-Block).
const STEP_LABELS = {
  schritt_rechnung: "Angebot/Rechnung erstellt",
  schritt_bezahlung: { todo: "Auf Bezahlung warten", done: "Ist bezahlt" },
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

// Nummeriertes Label wie im öffentlichen Varianten-Dropdown (siehe
// public/script.js) - macht z.B. zwei "Hintergrund-Variante"-Bilder ohne
// eigene Bezeichnung eindeutig unterscheid- und auswählbar.
function variantLabel(img, index) {
  const typ = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
  const base = img.bezeichnung ? `${typ} – ${img.bezeichnung}` : typ;
  return `${index}. ${base}`;
}

// Labels wie "2. Hintergrund-Variante" nach der führenden Nummer sortieren -
// eine Set-Auswahl (Klick-Reihenfolge) darf nicht in genau dieser
// willkürlichen Reihenfolge bei der Kundin landen.
function sortVariantLabels(labels) {
  return [...labels].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
}

// Mehrfachauswahl-Dropdown für die Bild-Varianten eines Designs, analog zur
// öffentlichen Anfrage-Lightbox. Bilder werden erst beim ersten Öffnen
// nachgeladen, damit nicht für jedes zugeordnete Design sofort ein Request rausgeht.
function buildVariantPicker(design, selectedSet) {
  const wrap = el("div", { className: "variant-dropdown" });
  const btn = el("button", { type: "button", className: "variant-dropdown-btn" });
  const panel = el("div", { className: "variant-dropdown-panel", hidden: true });
  let loaded = false;

  function updateBtnLabel() {
    btn.textContent = selectedSet.size > 0
      ? `${selectedSet.size} Variante${selectedSet.size === 1 ? "" : "n"} ausgewählt ▾`
      : "Variante(n) auswählen (optional) ▾";
  }
  updateBtnLabel();

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    panel.textContent = "Lädt …";
    try {
      const res = await fetch(`/api/admin/designs/${design.id}/images`);
      const images = (res.ok ? await res.json() : []).filter((img) => img.wasserzeichen);
      panel.innerHTML = "";
      if (images.length === 0) {
        panel.appendChild(el("p", { className: "muted", textContent: "Keine Varianten hinterlegt." }));
        return;
      }
      images.forEach((img, i) => {
        const label = variantLabel(img, i + 1);
        const checkbox = el("input", { type: "checkbox", checked: selectedSet.has(label) });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedSet.add(label);
          else selectedSet.delete(label);
          updateBtnLabel();
        });
        panel.appendChild(
          el("label", { className: "variant-dropdown-option" }, [checkbox, document.createTextNode(` ${label}`)])
        );
      });
    } catch {
      panel.innerHTML = "";
      panel.appendChild(el("p", { className: "muted", textContent: "Fehler beim Laden der Varianten." }));
    }
  }

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel.hidden) await ensureLoaded();
    panel.hidden = !panel.hidden;
  });

  wrap.append(btn, panel);
  return wrap;
}
document.addEventListener("click", (e) => {
  if (e.target.closest(".variant-dropdown")) return;
  document.querySelectorAll(".variant-dropdown-panel:not([hidden])").forEach((p) => { p.hidden = true; });
});

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
  titleEl.textContent = order.ist_test ? `🧪 Bestellung #${order.id} bearbeiten (Test)` : `Bestellung #${order.id} bearbeiten`;
  panelEl.innerHTML = "";

  const assignedIds = new Set(order.designs.map((d) => d.id));
  const errorMsg = el("p", { className: "wizard-error" });
  const successMsg = el("p", { className: "wizard-hint" });

  // --- Test-/Design-ausstehend-Flags ---
  const istTestCheckbox = el("input", { type: "checkbox", checked: Boolean(order.ist_test) });
  const designAusstehendCheckbox = el("input", { type: "checkbox", checked: Boolean(order.design_ausstehend) });

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

  // --- Rabatt (gesamte Bestellung, nicht pro Design) ---
  const rabattTypSelect = el("select");
  [["", "Kein Rabatt"], ["prozent", "Prozent"], ["euro", "Euro"]].forEach(([value, label]) => {
    rabattTypSelect.appendChild(el("option", { value, textContent: label, selected: (order.rabatt_typ || "") === value }));
  });
  const rabattWertInput = el("input", {
    type: "number",
    step: "0.01",
    min: "0",
    value: order.rabatt_wert != null ? order.rabatt_wert : "",
    disabled: !order.rabatt_typ,
  });
  rabattTypSelect.addEventListener("change", () => {
    rabattWertInput.disabled = !rabattTypSelect.value;
    if (!rabattTypSelect.value) rabattWertInput.value = "";
  });
  const totalSummary = el("p", { className: "wizard-hint" }, [
    document.createTextNode(
      order.rabattBetrag > 0
        ? `Zwischensumme: ${formatPrice(order.subtotal)} · Rabatt: −${formatPrice(order.rabattBetrag)} · Gesamtsumme: ${formatPrice(order.gesamtBetrag)}`
        : `Gesamtsumme: ${formatPrice(order.gesamtBetrag)}`
    ),
  ]);

  // --- Notiz (v.a. für Designs, die es noch nicht im System gibt, z.B. nur auf Instagram) ---
  const notizInput = el("textarea", {
    rows: 3,
    value: order.notiz || "",
    placeholder: "z. B. weiteres Design von Instagram gewünscht, noch nicht hochgeladen …",
  });

  // --- Designs (alle, auch bereits verkaufte, damit historische Zuordnungen sichtbar bleiben) ---
  const designList = el("div", { className: "wizard-design-list" });
  const designCheckboxes = new Map();
  // designId -> Set<Varianten-Label>, vorbelegt aus den aktuell zugeordneten Designs.
  const variantenSelection = new Map();
  order.designs.forEach((d) => variantenSelection.set(d.id, new Set(d.varianten || [])));

  allDesigns.forEach((d) => {
    const checkbox = el("input", { type: "checkbox", checked: assignedIds.has(d.id) });
    designCheckboxes.set(d.id, checkbox);
    if (!variantenSelection.has(d.id)) variantenSelection.set(d.id, new Set());

    const row = el("label", { className: "wizard-design-row" }, [
      checkbox,
      el("img", { src: d.image, alt: d.name }),
      el("span", { textContent: `${d.id} · ${d.name}${d.price != null ? " · " + formatPrice(d.price) : ""}` }),
    ]);
    const variantRow = el("div", { className: "wizard-design-variant-row", hidden: !checkbox.checked }, [
      buildVariantPicker(d, variantenSelection.get(d.id)),
    ]);
    checkbox.addEventListener("change", () => { variantRow.hidden = !checkbox.checked; });

    designList.appendChild(el("div", { className: "wizard-design-item" }, [row, variantRow]));
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
      rabatt_typ: rabattTypSelect.value || null,
      ist_test: istTestCheckbox.checked,
      design_ausstehend: designAusstehendCheckbox.checked,
    };
    if (rabattTypSelect.value) patchBody.rabatt_wert = Number(rabattWertInput.value) || 0;
    stepCheckboxes.forEach((cb, key) => { patchBody[key] = cb.checked; });

    const varianten = Object.fromEntries(
      [...variantenSelection]
        .filter(([id, set]) => designIds.includes(id) && set.size > 0)
        .map(([id, set]) => [id, sortVariantLabels([...set])])
    );

    const [orderRes, designsRes] = await Promise.all([
      fetch(`/api/admin/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      }),
      fetch(`/api/admin/orders/${order.id}/designs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designIds, varianten }),
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
  // nennung_erlaubt: null solange nicht bestätigt/gefragt (z.B. manuelle
  // Bestätigung durchs Personal) - erst danach eine echte Ja/Nein-Antwort.
  const nennungStatus = el("p", {
    className: "wizard-hint",
    textContent:
      order.nennung_erlaubt === 1
        ? "📸 Darf auf Webseite/Instagram genannt werden."
        : order.nennung_erlaubt === 0
          ? "🚫 Möchte NICHT auf Webseite/Instagram genannt werden."
          : "❔ Keine Angabe zur Nennung auf Webseite/Instagram.",
  });
  // Fallback für telefonisch/per Instagram-DM zugesagte Bestellungen ohne
  // Portal-Klick - setzt denselben terms_confirmed_at-Status wie eine echte
  // Portal-Bestätigung.
  const confirmManuallyBtn = el("button", {
    type: "button",
    className: "cancel-btn",
    textContent: "Manuell bestätigen (Kunde hat anders zugesagt)",
    hidden: Boolean(order.terms_confirmed_at),
  });
  confirmManuallyBtn.addEventListener("click", async () => {
    const res = await fetch(`/api/admin/orders/${order.id}/confirm-manually`, { method: "POST" });
    if (res.ok) {
      const updated = await loadOrder(order.id);
      render(updated, allDesigns);
    } else {
      const data = await res.json().catch(() => ({}));
      errorMsg.textContent = data.error || "Fehler beim Bestätigen.";
    }
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
    el("label", { className: "wizard-design-row" }, [istTestCheckbox, document.createTextNode(" 🧪 Testbestellung (keine echten Verkaufszahlen/Exklusivrechte beim Abschließen)")]),
    el("label", { className: "wizard-design-row" }, [designAusstehendCheckbox, document.createTextNode(" ⏳ Design noch nicht im System (muss nachgetragen werden)")]),
    el("label", { textContent: "Kundenname" }), nameInput,
    el("label", { textContent: "E-Mail" }), emailInput,
    el("label", { textContent: "Instagram-Name" }), instagramInput,
    el("label", { textContent: "WhatsApp-Nummer" }), whatsappInput,
    el("label", { textContent: "Kontaktpräferenz" }), praeferenzSelect,
    el("label", { textContent: "Status" }), statusSelect,
    el("h2", { textContent: "Zugeordnete Designs" }),
    designList,
    el("div", { className: "rabatt-row" }, [
      el("label", { textContent: "Rabatt (gesamte Bestellung):" }),
      rabattTypSelect,
      rabattWertInput,
    ]),
    totalSummary,
    el("label", { textContent: "Notiz (auch für Designs, die es noch nicht im System gibt)" }), notizInput,
    el("h2", { textContent: "Schritte" }),
    el("p", { className: "wizard-hint", textContent: "\"Ist bezahlt\" neu aktivieren gibt Dateien + Rechnung automatisch für den Kunden-Download frei (siehe Order-Portal-Bereich unten)." }),
    stepsList,
    el("h2", { textContent: "Order-Portal (Kunden-Bestätigungsseite)" }),
    el("label", { textContent: "Bestätigungslink" }),
    el("div", { className: "card-actions" }, [linkInput, copyBtn]),
    confirmStatus,
    nennungStatus,
    confirmManuallyBtn,
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
