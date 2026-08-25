const titleEl = document.getElementById("wizard-title");
const progressEl = document.getElementById("wizard-progress");
const panelEl = document.getElementById("wizard-panel");

// "bestaetigt" ist keine eigene DB-Spalte (siehe ORDER_STEPS-Kommentar in
// db.js) - isStepDone() leitet sie aus terms_confirmed_at ab. Reihenfolge:
// die Kundin muss dem Angebot zustimmen, BEVOR eine Zahlung dafür verbucht
// wird (advanceOrderStep erzwingt das serverseitig). "Freigabe" ist kein
// eigener Schritt mehr - Bezahlung erhalten gibt Dateien+Rechnung automatisch
// frei (siehe advanceOrderStep in db.js), kein separater Klick nötig.
const STEP_ORDER = ["schritt_rechnung", "bestaetigt", "schritt_bezahlung", "schritt_datei_geloescht"];

const PROGRESS_STEPS = [
  { key: "kunde", label: "Kunde" },
  { key: "designs", label: "Designs" },
  { key: "schritt_rechnung", label: "Angebot/Rechnung" },
  { key: "bestaetigt", label: "Bestätigt" },
  { key: "schritt_bezahlung", label: "Bezahlung" },
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

// Nummeriertes Label wie im öffentlichen Varianten-Dropdown (siehe
// public/script.js) - macht z.B. zwei "Hintergrund-Variante"-Bilder ohne
// eigene Bezeichnung eindeutig unterscheid- und auswählbar.
function variantLabel(img, index) {
  const typ = img.typ || (img.hintergrundVariante ? "Hintergrund-Variante" : "Design");
  const base = img.bezeichnung ? `${typ} – ${img.bezeichnung}` : typ;
  return `${index}. ${base}`;
}

// Mehrfachauswahl-Dropdown für die Bild-Varianten eines Designs, analog zur
// öffentlichen Anfrage-Lightbox - damit auch bei manuell angelegten
// Bestellungen (z.B. Instagram-DM) festgehalten werden kann, welche Variante
// gewünscht ist. Bilder werden erst beim ersten Öffnen nachgeladen, damit
// nicht für jedes der u.U. vielen Designs in der Liste sofort ein Request rausgeht.
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
        const thumb = el("img", {
          className: "variant-dropdown-thumb",
          src: img.previewImage || img.image,
          alt: "",
        });
        panel.appendChild(
          el("label", { className: "variant-dropdown-option" }, [checkbox, thumb, document.createTextNode(` ${label}`)])
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

// Designs-Schritt gilt auch als erledigt, wenn (noch) kein echtes Design im
// System zugeordnet ist, aber eine Notiz zu noch nicht hochgeladenen Designs
// hinterlegt wurde - sonst kommt man mit reinen Instagram-Anfragen nie weiter.
function isStepDone(order, key) {
  if (key === "kunde") return true;
  if (key === "designs") return order.designs.length > 0 || Boolean(order.notiz);
  if (key === "complete") return order.status === "Erledigt";
  if (key === "bestaetigt") return Boolean(order.terms_confirmed_at);
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
  // designId -> Set<Varianten-Label> - vorbelegt aus bereits zugeordneten
  // Designs, falls man auf diesen Schritt zurückspringt.
  const variantenSelection = new Map();
  order.designs.forEach((d) => variantenSelection.set(d.id, new Set(d.varianten || [])));

  const rows = designs.map((d) => {
    const checkbox = el("input", { type: "checkbox", value: d.id, checked: variantenSelection.has(d.id) });
    checkboxes.set(d.id, checkbox);
    if (!variantenSelection.has(d.id)) variantenSelection.set(d.id, new Set());

    const row = el("label", { className: "wizard-design-row" }, [
      checkbox,
      el("img", { src: d.image, alt: d.name }),
      el("span", { textContent: `${d.id} · ${d.name}${d.price != null ? " · " + formatPrice(d.price) : ""}` }),
      d.qualityWarning
        ? el("span", { className: "wizard-quality-warning", textContent: "⚠️ Auflösung niedrig", title: d.qualityWarning })
        : el("span", { className: "wizard-quality-ok", textContent: "✓ Qualität ok" }),
    ]);
    const variantRow = el("div", { className: "wizard-design-variant-row", hidden: !checkbox.checked }, [
      buildVariantPicker(d, variantenSelection.get(d.id)),
    ]);
    checkbox.addEventListener("change", () => { variantRow.hidden = !checkbox.checked; });

    const item = el("div", { className: "wizard-design-item" }, [row, variantRow]);
    item.dataset.search = `${d.id} ${d.name}`.toLowerCase();
    listEl.appendChild(item);
    return item;
  });

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    rows.forEach((item) => {
      item.hidden = query !== "" && !item.dataset.search.includes(query);
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
      const varianten = Object.fromEntries(
        [...variantenSelection]
          .filter(([id, set]) => designIds.includes(id) && set.size > 0)
          .map(([id, set]) => [id, [...set]])
      );
      const res = await fetch(`/api/admin/orders/${order.id}/designs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designIds, varianten }),
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
  return order.designs.reduce((sum, d) => sum + (d.berechneterPreis ?? d.price ?? 0), 0);
}

const PREISOPTIONEN = [
  { key: "design", label: (d) => `Design (${formatPrice(d.price)})` },
  { key: "png", label: (d) => `PNG-Dateien, alle Motive (${formatPrice(d.pricePng)})` },
  { key: "hintergrund", label: (d) => `Hintergrund (${formatPrice(d.priceHintergrund)})` },
];

// Pro zugeordnetem Design ankreuzbar, welche Preisbausteine ins Angebot
// einfließen (addierend) - Gesamtsumme rechts aktualisiert sich live bei
// jedem Klick, ohne die Seite neu zu laden. Zusätzlich pro Bestandteil
// "exklusiv" ankreuzbar (Farbexklusive Varianten) - reserviert noch nichts,
// das passiert erst beim Abschließen der Bestellung, prüft aber schon hier
// auf Konflikte mit bereits abgeschlossenen Bestellungen.
function renderPreisoptionenBlock(order, totalEl) {
  const listEl = el("div", { className: "wizard-design-list" });

  order.designs.forEach((d) => {
    const selected = new Set(d.preisoptionen && d.preisoptionen.length > 0 ? d.preisoptionen : ["design"]);
    const initialGruppe = (d.exklusiveGruppen && d.exklusiveGruppen[0] && d.exklusiveGruppen[0].gruppe) || "";
    const exklusivBestandteile = new Set((d.exklusiveGruppen || []).map((e) => e.bestandteil));

    // Welche Variante gemeint ist, wurde in Schritt 2 (Designs zuordnen)
    // bereits über die Varianten-Auswahl festgelegt - hier nicht nochmal
    // fragen, sondern aus den dort gewählten Varianten ableiten (über deren
    // gemeinsame Gruppe, sofern in der Bilder-Verwaltung gepflegt). Nur wenn
    // sich daraus keine eindeutige Gruppe ergibt (keine Varianten gewählt,
    // oder die Bilder haben noch keine Gruppe), bleibt ein Eingabefeld als Rückfalloption.
    const gruppeInfo = el("p", { className: "wizard-hint exklusiv-gruppe-info", hidden: true });
    const gruppeListId = `wizard-gruppe-list-${d.id}`;
    const gruppeDatalist = el("datalist", { id: gruppeListId });
    const gruppeInput = el("input", {
      type: "text",
      className: "exklusiv-gruppe-input",
      placeholder: "Welche Variante/Farbe? (z. B. Blau, Nr. 2 - leer = ganzes Design ohne Varianten)",
      value: initialGruppe,
      hidden: true,
    });
    gruppeInput.setAttribute("list", gruppeListId);
    let abgeleiteteGruppe = null; // gesetzt, sobald sich aus Schritt 2 eindeutig eine Gruppe ergibt
    const exklusivError = el("p", { className: "wizard-hint exklusiv-error", hidden: true });

    // Exklusivität gibt es geschäftlich nur für das Design selbst - PNG-Dateien
    // und Hintergrund sind nie exklusiv, deshalb nur bei "design" ein
    // exklusivCheckbox (siehe auch Validierung in server-admin.js).
    const bausteine = PREISOPTIONEN.map((opt) => ({
      opt,
      checkbox: el("input", { type: "checkbox", checked: selected.has(opt.key) }),
      exklusivCheckbox: opt.key === "design"
        ? el("input", { type: "checkbox", className: "exklusiv-checkbox", checked: exklusivBestandteile.has(opt.key), disabled: !selected.has(opt.key) })
        : null,
    }));

    async function saveExklusivitaet() {
      const gruppe = abgeleiteteGruppe !== null ? abgeleiteteGruppe : gruppeInput.value.trim() || null;
      const entries = bausteine
        .filter((b) => b.exklusivCheckbox && b.checkbox.checked && b.exklusivCheckbox.checked)
        .map((b) => ({ gruppe, bestandteil: b.opt.key }));
      const res = await fetch(`/api/admin/orders/${order.id}/designs/${d.id}/exklusivitaet`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exklusiveGruppen: entries }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        exklusivError.textContent = data.error || "Fehler beim Speichern der Exklusivität.";
        exklusivError.hidden = false;
        return false;
      }
      exklusivError.hidden = true;
      return true;
    }

    bausteine.forEach(({ opt, checkbox, exklusivCheckbox }) => {
      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) selected.add(opt.key);
        else selected.delete(opt.key);
        const res = await fetch(`/api/admin/orders/${order.id}/designs/${d.id}/preisoptionen`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preisoptionen: [...selected] }),
        });
        if (res.ok) {
          const updated = await res.json();
          order.designs = updated.designs;
          totalEl.textContent = `Gesamtsumme: ${formatPrice(totalPrice(order))}`;
        } else {
          checkbox.checked = !checkbox.checked;
        }
        if (exklusivCheckbox) exklusivCheckbox.disabled = !checkbox.checked;
        await saveExklusivitaet();
      });
      if (exklusivCheckbox) {
        exklusivCheckbox.addEventListener("change", async () => {
          const ok = await saveExklusivitaet();
          if (!ok) exklusivCheckbox.checked = !exklusivCheckbox.checked;
        });
      }
    });
    gruppeInput.addEventListener("change", () => saveExklusivitaet());

    const optionLabels = bausteine.map(({ opt, checkbox, exklusivCheckbox }) =>
      el("label", { className: "variant-dropdown-option" }, [
        checkbox,
        document.createTextNode(` ${opt.label(d)} `),
        exklusivCheckbox ? el("label", { className: "exklusiv-toggle" }, [exklusivCheckbox, document.createTextNode(" 🔒 exklusiv")]) : null,
      ].filter(Boolean))
    );

    listEl.appendChild(
      el("div", { className: "wizard-design-item" }, [
        el("span", { textContent: `${d.id} · ${d.name}` }),
        el("div", { className: "wizard-design-variant-row" }, optionLabels),
        gruppeInfo,
        gruppeInput,
        gruppeDatalist,
        exklusivError,
      ])
    );

    // Gruppe aus der in Schritt 2 getroffenen Varianten-Auswahl ableiten
    // (dieselbe variantLabel()-Logik wie beim Varianten-Picker dort), statt
    // hier nochmal separat zu fragen. Vorschlagsliste im Fallback-Feld kommt
    // aus denselben Bildern.
    fetch(`/api/admin/designs/${d.id}/images`)
      .then((r) => r.json())
      .then((images) => {
        const watermarked = images.filter((img) => img.wasserzeichen);
        const gruppenAllerVarianten = [...new Set(watermarked.map((i) => i.gruppe).filter(Boolean))];
        gruppenAllerVarianten.forEach((g) => gruppeDatalist.appendChild(el("option", { value: g })));

        const gewaehlteVarianten = d.varianten || [];
        const gruppenAusAuswahl = [
          ...new Set(
            watermarked
              .map((img, i) => ({ label: variantLabel(img, i + 1), gruppe: img.gruppe }))
              .filter((v) => gewaehlteVarianten.includes(v.label) && v.gruppe)
              .map((v) => v.gruppe)
          ),
        ];

        if (gewaehlteVarianten.length > 0 && gruppenAusAuswahl.length === 1) {
          abgeleiteteGruppe = gruppenAusAuswahl[0];
          gruppeInfo.textContent = `Variante: ${abgeleiteteGruppe} (aus der Design-Auswahl in Schritt 2 übernommen)`;
          gruppeInfo.hidden = false;
        } else {
          // Keine eindeutige Ableitung möglich (keine Varianten gewählt, die
          // gewählten Bilder haben noch keine Gruppe, oder sie gehören zu
          // unterschiedlichen Gruppen) - Eingabefeld als Rückfalloption zeigen.
          gruppeInput.hidden = false;
        }
      })
      .catch(() => {
        gruppeInput.hidden = false;
      });
  });

  return listEl;
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
  // Für "bestaetigt"/"freigegeben" gibt es keinen generischen Schritt-Endpunkt
  // (siehe STEP_ORDER-Kommentar) - hier wird stattdessen direkt der jeweils
  // zuständige Endpunkt aufgerufen und danach neu gerendert.
  const refreshOrder = async () => {
    errorMsg.textContent = "";
    try {
      renderForOrder(await fetchOrder(order.id));
    } catch (err) {
      errorMsg.textContent = err.message;
    }
  };
  const confirmManually = async () => {
    errorMsg.textContent = "";
    const res = await fetch(`/api/admin/orders/${order.id}/confirm-manually`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { errorMsg.textContent = data.error || "Fehler beim Bestätigen."; return; }
    renderForOrder(data);
  };
  if (stepKey === "schritt_rechnung") {
    const totalEl = el("p", { className: "wizard-total", textContent: `Gesamtsumme: ${formatPrice(totalPrice(order))}` });
    panelEl.append(
      el("h2", { textContent: "Schritt 3 · Angebot/Rechnung erstellen" }),
      el("p", { textContent: `Kunde: ${order.kunde_name} (${order.kunde_email})` }),
      el("p", { className: "wizard-hint", textContent: "Welche Preisbausteine soll die Kundin bekommen? Mehrfachauswahl möglich, addiert sich zur Gesamtsumme." }),
      renderPreisoptionenBlock(order, totalEl),
      totalEl,
      el("p", { className: "wizard-hint", textContent: "Rechnung mit diesen Eckdaten manuell in sevdesk anlegen." }),
      renderFileUploadBlock(order, { field: "angebot_datei", label: "Angebot (optional)", route: "angebot" }),
      renderFileUploadBlock(order, { field: "rechnung_datei", label: "Rechnung", route: "rechnung" }),
      errorMsg,
      el("button", { type: "button", textContent: "Rechnung erstellt – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "bestaetigt") {
    const confirmed = Boolean(order.terms_confirmed_at);
    panelEl.append(
      el("h2", { textContent: "Schritt 4 · Kunde bestätigt Bestellung" }),
      el("p", { className: "wizard-hint", textContent: "Die Kundin bestätigt selbst über den Bestätigungslink oben, dass sie das Angebot annimmt. Hat sie stattdessen telefonisch oder per Instagram-DM zugesagt, unten manuell bestätigen." }),
      el("p", {
        textContent: confirmed
          ? `✅ Bestätigt am ${new Date(order.terms_confirmed_at).toLocaleString("de-DE")}`
          : "⏳ Noch nicht bestätigt.",
      }),
      errorMsg
    );
    if (confirmed) {
      panelEl.appendChild(el("button", { type: "button", textContent: "Weiter", onclick: () => renderForOrder(order) }));
    } else {
      panelEl.appendChild(
        el("div", { className: "card-actions" }, [
          el("button", { type: "button", textContent: "Aktualisieren", onclick: refreshOrder }),
          el("button", { type: "button", className: "cancel-btn", textContent: "Kunde hat anders bestätigt (manuell)", onclick: confirmManually }),
        ])
      );
    }
  } else if (stepKey === "schritt_bezahlung") {
    panelEl.append(
      el("h2", { textContent: "Schritt 5 · Bezahlung erhalten" }),
      el("p", { textContent: `Gesamtsumme: ${formatPrice(totalPrice(order))}` }),
      el("p", { className: "wizard-hint", textContent: "Sobald der Zahlungseingang bestätigt ist, hier weiterklicken - Dateien und Rechnung werden dann automatisch für den Kunden-Download freigegeben, kein separater Schritt nötig." }),
      errorMsg,
      el("button", { type: "button", textContent: "Zahlung erhalten – weiter", onclick: () => runStep() })
    );
  } else if (stepKey === "schritt_datei_geloescht") {
    const listEl = el("ul", { className: "download-list" });
    panelEl.append(
      el("h2", { textContent: "Schritt 6 · Datei(en) lokal löschen" }),
      el("p", { className: "wizard-hint", textContent: "Falls du die Datei(en) zwischenzeitlich lokal heruntergeladen hattest (z.B. für die Rechnungsstellung), jetzt löschen." }),
      listEl,
      errorMsg,
      el("button", { type: "button", textContent: "Datei(en) gelöscht – weiter", onclick: () => runStep() })
    );
    loadDownloadLinks(order, listEl);
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
    el("h2", { textContent: "Schritt 7 · Abschließen" }),
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
  const nextStep = STEP_ORDER.find((s) => !isStepDone(order, s));
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
