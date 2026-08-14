const titleEl = document.getElementById("wizard-title");
const progressEl = document.getElementById("wizard-progress");
const panelEl = document.getElementById("wizard-panel");

const STEP_ORDER = [
  "schritt_rechnung",
  "schritt_bezahlung",
  "schritt_download",
  "schritt_email_vorbereitet",
  "schritt_verschickt",
  "schritt_datei_geloescht",
];

const PROGRESS_STEPS = [
  { key: "kunde", label: "Kunde" },
  { key: "designs", label: "Designs" },
  { key: "schritt_rechnung", label: "Angebot/Rechnung" },
  { key: "schritt_bezahlung", label: "Bezahlung" },
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

// Designs-Schritt gilt auch als erledigt, wenn (noch) kein echtes Design im
// System zugeordnet ist, aber eine Notiz zu noch nicht hochgeladenen Designs
// hinterlegt wurde - sonst kommt man mit reinen Instagram-Anfragen nie weiter.
function isStepDone(order, key) {
  if (key === "kunde") return true;
  if (key === "designs") return order.designs.length > 0 || Boolean(order.notiz);
  if (key === "complete") return order.status === "Erledigt";
  return Boolean(order[key]);
}

function nextIncompleteStep(order) {
  return PROGRESS_STEPS.find((s) => !isStepDone(order, s.key));
}

// Klick auf einen Progress-Schritt springt direkt dorthin, unabhängig vom
// tatsächlichen Fortschritt - man kann sich jeden Schritt ansehen. Ein
// "erledigt"-Klick auf einen noch nicht erreichbaren Schritt scheitert
// weiterhin an der serverseitigen Reihenfolge-Prüfung in advanceOrderStep.
function jumpToStep(order, key) {
  if (key === "designs") {
    renderStep2DesignPicker(order);
  } else if (key === "complete") {
    renderCompleteStep(order);
  } else if (STEP_ORDER.includes(key)) {
    renderStepAction(order, key);
  }
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
    const clickable = s.key !== "kunde";
    const li = el("li", { className: clickable ? `${className} wizard-step-clickable` : className, textContent: s.label });
    if (clickable) {
      li.addEventListener("click", () => jumpToStep(order, s.key));
    }
    progressEl.appendChild(li);
  });
}

// Lädt für jedes Design der Bestellung die Verkaufsdatei ("Ohne Wasserzeichen")
// als direkten Download-Link, mit Fallback auf den Drive-Link, falls noch
// keine Verkaufsdatei hochgeladen wurde.
async function loadDownloadLinks(order, listEl) {
  for (const d of order.designs) {
    const li = el("li", {}, [el("span", { textContent: `${d.id} · ${d.name}: ` })]);
    listEl.appendChild(li);
    try {
      const res = await fetch(`/api/admin/designs/${d.id}/images`);
      const images = res.ok ? await res.json() : [];
      const sale = images.find((img) => img.kategorie === "Ohne Wasserzeichen");

      if (sale) {
        li.appendChild(el("a", {
          className: "download-link",
          href: `/api/admin/designs/${d.id}/images/${sale.id}/download`,
          textContent: "⬇️ Verkaufsdatei herunterladen (ohne Wasserzeichen)",
        }));
      } else {
        li.appendChild(el("span", { className: "muted", textContent: "⚠️ Keine Datei ohne Wasserzeichen hinterlegt" }));
      }
      if (d.driveLink) {
        li.appendChild(document.createTextNode(" · "));
        li.appendChild(el("a", { href: d.driveLink, target: "_blank", rel: "noopener", textContent: "📁 Drive öffnen" }));
      }
    } catch {
      li.appendChild(el("span", { className: "muted", textContent: "Fehler beim Laden der Bilder" }));
    }
  }
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
  const instagramInput = el("input", { type: "text", placeholder: "@dein_name" });
  const whatsappInput = el("input", { type: "tel", placeholder: "+49 151 …" });
  const praeferenzEmail = el("input", { type: "radio", name: "kontakt_praeferenz", value: "E-Mail", checked: true });
  const praeferenzWhatsapp = el("input", { type: "radio", name: "kontakt_praeferenz", value: "WhatsApp" });
  const errorMsg = el("p", { className: "wizard-error" });
  const submitBtn = el("button", { type: "submit", textContent: "Weiter zu Schritt 2" });

  const form = el("form", { className: "wizard-form" }, [
    el("label", { textContent: "Kundenname" }), nameInput,
    el("label", { textContent: "E-Mail" }), emailInput,
    el("label", { textContent: "Instagram-Name (optional)" }), instagramInput,
    el("label", { textContent: "WhatsApp-Nummer (optional)" }), whatsappInput,
    el("label", { textContent: "Kontaktpräferenz" }),
    el("div", { className: "contact-pref-row" }, [
      el("label", { className: "contact-pref-option" }, [praeferenzEmail, document.createTextNode(" E-Mail")]),
      el("label", { className: "contact-pref-option" }, [praeferenzWhatsapp, document.createTextNode(" WhatsApp")]),
    ]),
    errorMsg,
    submitBtn,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/admin/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kunde_name: nameInput.value.trim(),
        kunde_email: emailInput.value.trim(),
        kunde_instagram: instagramInput.value.trim(),
        kunde_whatsapp: whatsappInput.value.trim(),
        kontakt_praeferenz: praeferenzWhatsapp.checked ? "WhatsApp" : "E-Mail",
      }),
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

  const searchInput = el("input", {
    type: "search",
    className: "wizard-design-search",
    placeholder: "Design suchen (Name oder ID) …",
  });

  const listEl = el("div", { className: "wizard-design-list" });
  const checkboxes = new Map();
  const rows = designs.map((d) => {
    const checkbox = el("input", { type: "checkbox", value: d.id });
    checkboxes.set(d.id, checkbox);
    const row = el("label", { className: "wizard-design-row" }, [
      checkbox,
      el("img", { src: d.image, alt: d.name }),
      el("span", { textContent: `${d.id} · ${d.name}${d.price != null ? " · " + formatPrice(d.price) : ""}` }),
      d.qualityWarning
        ? el("span", { className: "wizard-quality-warning", textContent: "⚠️ Auflösung niedrig", title: d.qualityWarning })
        : el("span", { className: "wizard-quality-ok", textContent: "✓ Qualität ok" }),
    ]);
    row.dataset.search = `${d.id} ${d.name}`.toLowerCase();
    listEl.appendChild(row);
    return row;
  });

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    rows.forEach((row) => {
      row.hidden = query !== "" && !row.dataset.search.includes(query);
    });
  });

  const notizInput = el("textarea", {
    rows: 2,
    value: order.notiz || "",
    placeholder: "z. B. weiteres Design von Instagram gewünscht, noch nicht hochgeladen …",
  });

  const errorMsg = el("p", { className: "wizard-error" });
  const continueBtn = el("button", { type: "button", textContent: "Weiter" });
  continueBtn.addEventListener("click", async () => {
    const designIds = [...checkboxes.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
    const notiz = notizInput.value.trim();
    if (designIds.length === 0 && !notiz) {
      errorMsg.textContent = "Mindestens ein Design auswählen oder eine Notiz eintragen.";
      return;
    }

    let data = order;
    if (designIds.length > 0) {
      const res = await fetch(`/api/admin/orders/${order.id}/designs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designIds }),
      });
      data = await res.json();
      if (!res.ok) {
        errorMsg.textContent = data.error || "Fehler beim Zuordnen der Designs.";
        return;
      }
    }

    const notizRes = await fetch(`/api/admin/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notiz }),
    });
    data = await notizRes.json();
    if (!notizRes.ok) {
      errorMsg.textContent = data.error || "Fehler beim Speichern der Notiz.";
      return;
    }
    renderForOrder(data);
  });

  panelEl.append(
    el("p", { className: "wizard-hint", textContent: "Welche Designs gehören zu dieser Bestellung?" }),
    searchInput,
    listEl,
    el("label", { textContent: "Notiz (z. B. noch nicht hochgeladene Designs)" }),
    notizInput,
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

const PUBLIC_ORIGIN = "https://designwahnsinn-teddy.de";

function renderPortalLinkBanner(order) {
  const link = `${PUBLIC_ORIGIN}/bestellung/${order.access_token}`;
  const linkInput = el("input", { type: "text", value: link, readOnly: true });
  const copyBtn = el("button", { type: "button", textContent: "Link kopieren" });
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = "Kopiert ✓";
    setTimeout(() => { copyBtn.textContent = "Link kopieren"; }, 1500);
  });
  return el("div", { className: "wizard-panel-hint" }, [
    el("label", { textContent: "Bestätigungslink für den Kunden" }),
    el("div", { className: "card-actions" }, [linkInput, copyBtn]),
  ]);
}

// Datei-Upload-Block für Rechnung/Angebot im Rechnung-Schritt - beide Felder
// nutzen dieselbe Logik, nur Zielfeld/Route unterscheiden sich.
function renderFileUploadBlock(order, { field, label, route }) {
  const currentFile = order[field];
  const fileInput = el("input", { type: "file", accept: "application/pdf,image/png,image/jpeg,image/webp,image/avif" });
  const status = el("span", { className: "muted" });
  const uploadBtn = el("button", { type: "button", textContent: currentFile ? "Ersetzen" : "Hochladen" });
  uploadBtn.addEventListener("click", async () => {
    if (!fileInput.files[0]) {
      status.textContent = "Bitte zuerst eine Datei auswählen.";
      return;
    }
    status.textContent = "Lädt hoch …";
    const formData = new FormData();
    formData.append("datei", fileInput.files[0]);
    const res = await fetch(`/api/admin/orders/${order.id}/${route}`, { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.error || "Fehler beim Hochladen.";
      return;
    }
    renderStepAction(data, "schritt_rechnung");
  });

  const rows = [el("label", { textContent: label })];
  if (currentFile) {
    rows.push(el("p", {}, [
      el("a", { href: `/uploads/${currentFile}`, target: "_blank", rel: "noopener", textContent: "📄 Aktuelle Datei ansehen" }),
    ]));
  }
  rows.push(el("div", { className: "card-actions" }, [fileInput, uploadBtn, status]));
  return el("div", { className: "wizard-panel-hint" }, rows);
}

function renderStepAction(order, stepKey) {
  titleEl.textContent = `Bestellung #${order.id} – ${order.kunde_name}`;
  renderProgress(order);
  panelEl.innerHTML = "";
  panelEl.appendChild(renderPortalLinkBanner(order));

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
      el("h2", { textContent: "Schritt 3 · Angebot/Rechnung erstellen" }),
      el("p", { textContent: `Kunde: ${order.kunde_name} (${order.kunde_email})` }),
      el("ul", {}, order.designs.map((d) => el("li", { textContent: `${d.id} · ${d.name} · ${formatPrice(d.price)}` }))),
      el("p", { textContent: `Gesamtsumme: ${formatPrice(totalPrice(order))}` }),
      el("p", { className: "wizard-hint", textContent: "Rechnung mit diesen Eckdaten manuell in sevdesk anlegen." }),
      renderFileUploadBlock(order, { field: "angebot_datei", label: "Angebot (optional)", route: "angebot" }),
      renderFileUploadBlock(order, { field: "rechnung_datei", label: "Rechnung", route: "rechnung" }),
      errorMsg,
      el("button", { type: "button", textContent: "Rechnung erstellt – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_bezahlung") {
    panelEl.append(
      el("h2", { textContent: "Schritt 4 · Auf Bezahlung warten" }),
      el("p", { textContent: `Gesamtsumme: ${formatPrice(totalPrice(order))}` }),
      el("p", { className: "wizard-hint", textContent: "Sobald der Zahlungseingang bestätigt ist, hier weiterklicken." }),
      errorMsg,
      el("button", { type: "button", textContent: "Zahlung erhalten – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_download") {
    const listEl = el("ul", { className: "download-list" });
    panelEl.append(
      el("h2", { textContent: "Schritt 5 · Design(s) herunterladen" }),
      el("p", { className: "wizard-hint", textContent: "Lädt die Datei direkt herunter, um sie an die E-Mail/WhatsApp-Nachricht anzuhängen." }),
      listEl,
      errorMsg,
      el("button", { type: "button", textContent: "Heruntergeladen – weiter", onclick: () => runStep() })
    );
    loadDownloadLinks(order, listEl);
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
        el("h2", { textContent: "Schritt 6 · Kontakt vorbereiten (WhatsApp gewünscht)" }),
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
        el("h2", { textContent: "Schritt 6 · E-Mail vorbereiten" }),
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
      el("h2", { textContent: "Schritt 7 · Als verschickt markieren" }),
      errorMsg,
      el("button", { type: "button", textContent: "E-Mail wurde verschickt", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_datei_geloescht") {
    panelEl.append(
      el("h2", { textContent: "Schritt 8 · Datei(en) lokal löschen" }),
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
    el("h2", { textContent: "Schritt 9 · Abschließen" }),
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
  // Mit Notiz zu noch nicht hochgeladenen Designs darf man auch ohne
  // zugeordnetes Design weiter zu Schritt 3 - sonst Sackgasse bei reinen
  // Instagram-Anfragen ohne bestehendes Design im System.
  if (order.designs.length === 0 && !order.notiz) {
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
