const titleEl = document.getElementById("wizard-title");
const progressEl = document.getElementById("wizard-progress");
const panelEl = document.getElementById("wizard-panel");

const STEP_ORDER = [
  "schritt_rechnung",
  "schritt_download",
  "schritt_email_vorbereitet",
  "schritt_verschickt",
  "schritt_datei_geloescht",
];

const PROGRESS_STEPS = [
  { key: "kunde", label: "Kunde" },
  { key: "designs", label: "Designs" },
  { key: "schritt_rechnung", label: "Rechnung" },
  { key: "schritt_download", label: "Download" },
  { key: "schritt_email_vorbereitet", label: "E-Mail" },
  { key: "schritt_verschickt", label: "Verschickt" },
  { key: "schritt_datei_geloescht", label: "Gelöscht" },
  { key: "complete", label: "Abschluss" },
];

let orderId = new URLSearchParams(window.location.search).get("id");
orderId = orderId ? Number(orderId) : null;

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

function isStepDone(order, key) {
  if (key === "kunde") return true;
  if (key === "designs") return order.designs.length > 0;
  if (key === "complete") return order.status === "Erledigt";
  return Boolean(order[key]);
}

function nextIncompleteStep(order) {
  return PROGRESS_STEPS.find((s) => !isStepDone(order, s.key));
}

function renderProgress(order) {
  progressEl.innerHTML = "";
  if (!order) {
    PROGRESS_STEPS.forEach((s, i) => {
      progressEl.appendChild(
        el("li", { className: i === 0 ? "wizard-step current" : "wizard-step pending", textContent: s.label })
      );
    });
    return;
  }
  const current = nextIncompleteStep(order);
  PROGRESS_STEPS.forEach((s) => {
    const done = isStepDone(order, s.key);
    const isCurrent = current && current.key === s.key;
    const className = done ? "wizard-step done" : isCurrent ? "wizard-step current" : "wizard-step pending";
    progressEl.appendChild(el("li", { className, textContent: s.label }));
  });
}

async function fetchOrder(id) {
  const res = await fetch(`/api/admin/orders/${id}`);
  if (!res.ok) throw new Error("Bestellung nicht gefunden");
  return res.json();
}

function renderStep1Form() {
  titleEl.textContent = "Neue Bestellung – Kunde anlegen";
  renderProgress(null);
  panelEl.innerHTML = "";

  const nameInput = el("input", { type: "text", placeholder: "Kundenname", required: true });
  const emailInput = el("input", { type: "email", placeholder: "kunde@example.com", required: true });
  const errorMsg = el("p", { className: "wizard-error" });
  const submitBtn = el("button", { type: "submit", textContent: "Weiter zu Schritt 2" });

  const form = el("form", { className: "wizard-form" }, [
    el("label", { textContent: "Kundenname" }), nameInput,
    el("label", { textContent: "E-Mail" }), emailInput,
    errorMsg,
    submitBtn,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/admin/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kunde_name: nameInput.value.trim(), kunde_email: emailInput.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.error || "Fehler beim Anlegen der Bestellung.";
      return;
    }
    orderId = data.id;
    window.history.replaceState({}, "", `/mitarbeiter/bestellungen/neu?id=${orderId}`);
    renderForOrder(data);
  });

  panelEl.appendChild(form);
}

async function renderStep2DesignPicker(order) {
  titleEl.textContent = `Bestellung #${order.id} – ${order.kunde_name}`;
  renderProgress(order);
  panelEl.innerHTML = "";

  const res = await fetch("/api/admin/designs");
  const designs = (await res.json()).filter((d) => d.status !== "verkauft");

  const listEl = el("div", { className: "wizard-design-list" });
  const checkboxes = new Map();
  designs.forEach((d) => {
    const checkbox = el("input", { type: "checkbox", value: d.id });
    checkboxes.set(d.id, checkbox);
    const row = el("label", { className: "wizard-design-row" }, [
      checkbox,
      el("img", { src: d.image, alt: d.name }),
      el("span", { textContent: `${d.id} · ${d.name}${d.price != null ? " · " + formatPrice(d.price) : ""}` }),
    ]);
    listEl.appendChild(row);
  });

  const errorMsg = el("p", { className: "wizard-error" });
  const continueBtn = el("button", { type: "button", textContent: "Weiter" });
  continueBtn.addEventListener("click", async () => {
    const designIds = [...checkboxes.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    const res = await fetch(`/api/admin/orders/${order.id}/designs`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.error || "Fehler beim Zuordnen der Designs.";
      return;
    }
    renderForOrder(data);
  });

  panelEl.append(
    el("p", { className: "wizard-hint", textContent: "Welche Designs gehören zu dieser Bestellung?" }),
    listEl,
    errorMsg,
    continueBtn
  );
}

async function callStep(order, stepKey) {
  const res = await fetch(`/api/admin/orders/${order.id}/step/${stepKey}`, { method: "PATCH" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Fehler beim Speichern des Schritts.");
  return data;
}

function totalPrice(order) {
  return order.designs.reduce((sum, d) => sum + (d.price || 0), 0);
}

function renderStepAction(order, stepKey) {
  titleEl.textContent = `Bestellung #${order.id} – ${order.kunde_name}`;
  renderProgress(order);
  panelEl.innerHTML = "";

  const errorMsg = el("p", { className: "wizard-error" });
  const runStep = async (extra) => {
    try {
      if (extra) await extra();
      const updated = await callStep(order, stepKey);
      renderForOrder(updated);
    } catch (err) {
      errorMsg.textContent = err.message;
    }
  };

  if (stepKey === "schritt_rechnung") {
    panelEl.append(
      el("h2", { textContent: "Schritt 3 · Rechnung erstellen" }),
      el("p", { textContent: `Kunde: ${order.kunde_name} (${order.kunde_email})` }),
      el("ul", {}, order.designs.map((d) => el("li", { textContent: `${d.id} · ${d.name} · ${formatPrice(d.price)}` }))),
      el("p", { textContent: `Gesamtsumme: ${formatPrice(totalPrice(order))}` }),
      el("p", { className: "wizard-hint", textContent: "Rechnung mit diesen Eckdaten manuell in sevdesk anlegen." }),
      errorMsg,
      el("button", { type: "button", textContent: "Rechnung erstellt – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_download") {
    panelEl.append(
      el("h2", { textContent: "Schritt 4 · Design(s) herunterladen" }),
      el("ul", {}, order.designs.map((d) =>
        el("li", {}, [
          el("span", { textContent: `${d.id} · ${d.name}: ` }),
          d.driveLink
            ? el("a", { href: d.driveLink, target: "_blank", rel: "noopener", textContent: "📁 Originaldatei öffnen" })
            : el("span", { className: "muted", textContent: "kein Drive-Link hinterlegt" }),
        ])
      )),
      errorMsg,
      el("button", { type: "button", textContent: "Heruntergeladen – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_email_vorbereitet") {
    const designNames = order.designs.map((d) => d.name).join(", ");
    const wantsWhatsapp = order.kontakt_praeferenz === "WhatsApp" && order.kunde_whatsapp;

    if (wantsWhatsapp) {
      const waNumber = order.kunde_whatsapp.replace(/[^\d+]/g, "").replace(/^\+/, "");
      const text = encodeURIComponent(
        `Hallo ${order.kunde_name}, vielen Dank für deine Bestellung (${designNames}). Die Datei(en) und deine Rechnung schicken wir dir gleich hier rüber!`
      );
      const waLink = `https://wa.me/${waNumber}?text=${text}`;
      panelEl.append(
        el("h2", { textContent: "Schritt 5 · Kontakt vorbereiten (WhatsApp gewünscht)" }),
        el("p", { className: "wizard-hint", textContent: "Kunde möchte per WhatsApp kontaktiert werden. Öffnet WhatsApp mit vorausgefülltem Text – Datei(en) + Rechnung dort anhängen." }),
        errorMsg,
        el("button", {
          type: "button",
          textContent: "WhatsApp öffnen & Schritt abschließen",
          onclick: () => runStep(() => { window.open(waLink, "_blank"); }),
        })
      );
    } else {
      const subject = encodeURIComponent(`Deine Bestellung bei Teddys Designwahnsinn`);
      const body = encodeURIComponent(
        `Hallo ${order.kunde_name},\n\nvielen Dank für deine Bestellung (${designNames}).\nDie Datei(en) und deine Rechnung findest du im Anhang.\n\nHINWEIS: Datei(en) + Rechnung manuell anhängen, bevor die Mail verschickt wird!\n\nViele Grüße`
      );
      const mailto = `mailto:${encodeURIComponent(order.kunde_email)}?subject=${subject}&body=${body}`;
      panelEl.append(
        el("h2", { textContent: "Schritt 5 · E-Mail vorbereiten" }),
        el("p", { className: "wizard-hint", textContent: "Öffnet dein E-Mail-Programm mit vorausgefülltem Text. Datei(en) + Rechnung nicht vergessen anzuhängen!" }),
        errorMsg,
        el("button", {
          type: "button",
          textContent: "E-Mail öffnen & Schritt abschließen",
          onclick: () => runStep(() => { window.location.href = mailto; }),
        })
      );
    }
  } else if (stepKey === "schritt_verschickt") {
    panelEl.append(
      el("h2", { textContent: "Schritt 6 · Als verschickt markieren" }),
      errorMsg,
      el("button", { type: "button", textContent: "E-Mail wurde verschickt", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_datei_geloescht") {
    panelEl.append(
      el("h2", { textContent: "Schritt 7 · Datei(en) lokal löschen" }),
      el("p", { className: "wizard-hint", textContent: "Bitte die heruntergeladene(n) Datei(en) jetzt vom eigenen Rechner löschen." }),
      errorMsg,
      el("button", { type: "button", textContent: "Datei(en) gelöscht – weiter", onclick: () => runStep() })
    );
  }
}

function renderCompleteStep(order) {
  titleEl.textContent = `Bestellung #${order.id} – ${order.kunde_name}`;
  renderProgress(order);
  panelEl.innerHTML = "";

  const errorMsg = el("p", { className: "wizard-error" });
  const completeBtn = el("button", { type: "button", textContent: "Bestellung abschließen" });
  completeBtn.addEventListener("click", async () => {
    const res = await fetch(`/api/admin/orders/${order.id}/complete`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.error || "Fehler beim Abschließen.";
      return;
    }
    renderForOrder(data);
  });

  panelEl.append(
    el("h2", { textContent: "Schritt 8 · Abschließen" }),
    el("p", { textContent: "Alle Schritte erledigt. Verkaufszähler der Designs wird beim Abschließen um 1 erhöht." }),
    errorMsg,
    completeBtn
  );
}

function renderDoneSummary(order) {
  titleEl.textContent = `Bestellung #${order.id} – erledigt ✅`;
  renderProgress(order);
  panelEl.innerHTML = "";
  panelEl.append(
    el("p", { textContent: `Bestellung für ${order.kunde_name} ist abgeschlossen.` }),
    el("a", { href: "/mitarbeiter/bestellungen", className: "admin-nav-link", textContent: "← Zurück zur Übersicht" })
  );
}

function renderForOrder(order) {
  if (order.designs.length === 0) {
    renderStep2DesignPicker(order);
    return;
  }
  const nextStep = STEP_ORDER.find((s) => !order[s]);
  if (nextStep) {
    renderStepAction(order, nextStep);
  } else if (order.status !== "Erledigt") {
    renderCompleteStep(order);
  } else {
    renderDoneSummary(order);
  }
}

async function init() {
  if (!orderId) {
    renderStep1Form();
    return;
  }
  try {
    const order = await fetchOrder(orderId);
    renderForOrder(order);
  } catch (err) {
    panelEl.textContent = err.message;
  }
}

init();
