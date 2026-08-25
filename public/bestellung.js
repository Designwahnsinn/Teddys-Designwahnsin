const ADMIN_ORIGIN = "https://mitarbeiter.designwahnsinn-teddy.de";
const contentEl = document.getElementById("order-content");

// Token steht im Pfad (/bestellung/<token>), nicht in der fortlaufenden
// Bestell-ID - der Token selbst ersetzt den Login für diese Seite.
const token = window.location.pathname.replace(/^\/bestellung\/?/, "").trim();

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderError(message) {
  contentEl.innerHTML = "";
  contentEl.appendChild(el("div", { className: "order-error" }, [
    el("p", { textContent: message }),
    el("p", { textContent: "Falls du denkst das ist ein Fehler, melde dich gerne bei uns." }),
  ]));
}

// Preis-Aufschlüsselung wie im öffentlichen Katalog (siehe
// renderLightboxPriceTable in script.js) - dieselben CSS-Klassen aus
// style.css, das bestellung.html ohnehin schon einbindet. Nur zeigen, wenn
// es wirklich mehr als einen Baustein gibt, sonst wäre eine Ein-Zeilen-
// Tabelle für nur "Design" reine Redundanz zum Gesamtpreis daneben.
// Labels wie "2. Hintergrund-Variante" nach der führenden Nummer sortieren -
// hier zusätzlich bei der Anzeige (nicht nur beim Speichern), damit auch
// bereits gespeicherte Bestellungen mit noch unsortierten Varianten korrekt
// erscheinen, ohne die Daten migrieren zu müssen.
function sortVariantLabels(labels) {
  return [...labels].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
}

function renderPriceBreakdown(rows) {
  if (rows.length <= 1) return null;
  return el("div", { className: "price-table" }, [
    el("p", { className: "price-table-hint", textContent: "Enthält:" }),
    ...rows.map((r) =>
      el("div", { className: "price-table-row" }, [
        el("span", { textContent: r.label }),
        el("span", { textContent: formatPrice(r.price) }),
      ])
    ),
  ]);
}

function renderDesignsList(order) {
  return el("ul", { className: "order-designs-list" },
    order.designs.map((d) =>
      el("li", { className: "order-design-row" }, [
        d.previewImage ? el("img", { src: d.previewImage, alt: d.name }) : null,
        el("div", { className: "order-design-info" }, [
          el("div", { className: "order-design-header" }, [
            el("span", { className: "order-design-name", textContent: d.name }),
            d.exklusiv ? el("span", { className: "badge-exklusiv", textContent: "Exklusiv" }) : null,
          ].filter(Boolean)),
          d.varianten && d.varianten.length > 0
            ? el("p", { className: "order-design-variant", textContent: `Variante: ${sortVariantLabels(d.varianten).join(", ")}` })
            : null,
          renderPriceBreakdown(d.priceBreakdown || []),
        ].filter(Boolean)),
        el("span", { className: "order-design-price", textContent: formatPrice(d.price) }),
      ].filter(Boolean))
    )
  );
}

function renderDownloadSection(order) {
  const wrap = el("div", { className: "order-download-section" }, [
    el("h2", { textContent: "🎉 Deine Dateien sind bereit" }),
  ]);
  if (order.rechnungDatei) {
    wrap.appendChild(el("a", {
      className: "btn",
      href: `${ADMIN_ORIGIN}/uploads/${order.rechnungDatei}`,
      target: "_blank",
      rel: "noopener",
      textContent: "📄 Rechnung ansehen",
    }));
  }
  order.designs.forEach((d) => {
    if (d.deliverables.length === 0) return;
    const row = el("div", { className: "order-download-row" }, [
      el("span", { className: "order-design-name", textContent: d.name }),
    ]);
    d.deliverables.forEach((file) => {
      row.appendChild(el("a", {
        className: "btn btn-buy",
        href: `${ADMIN_ORIGIN}/api/public/order/${token}/download/${file.id}`,
        textContent: `⬇️ ${file.bezeichnung || "Herunterladen"}`,
      }));
    });
    wrap.appendChild(row);
  });
  return wrap;
}

function renderConfirmForm(order) {
  const checkbox = el("input", { type: "checkbox", id: "confirm-checkbox" });
  // Rein optional (Marketing-Einwilligung, nicht Teil der AGB) - deshalb
  // eigene Checkbox, unbeteiligt an der Pflicht-Bestätigung darüber.
  const nennungCheckbox = el("input", { type: "checkbox", id: "nennung-checkbox" });
  const errorMsg = el("p", { className: "order-error-inline" });
  const submitBtn = el("button", { className: "btn btn-buy", type: "submit", textContent: "Verbindlich bestätigen" });

  const form = el("form", { className: "order-confirm-form" }, [
    el("h2", { textContent: "AGB, Widerrufsbelehrung & Nutzungsvereinbarung" }),
    el("pre", { className: "order-terms-text", textContent: order.termsText }),
    el("label", { className: "order-confirm-label" }, [
      checkbox,
      document.createTextNode(" Ich habe AGB, Widerrufsbelehrung und Nutzungsvereinbarung gelesen und bestätige verbindlich."),
    ]),
    el("label", { className: "order-confirm-label order-confirm-label-optional" }, [
      nennungCheckbox,
      document.createTextNode(" Optional: Ich bin einverstanden, dass Teddys Designwahnsinn mich (z. B. Name/Instagram-Name) auf der Webseite oder auf Instagram nennen darf."),
    ]),
    errorMsg,
    submitBtn,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!checkbox.checked) {
      errorMsg.textContent = "Bitte die Bestätigung ankreuzen.";
      return;
    }
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${ADMIN_ORIGIN}/api/public/order/${token}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, nennungErlaubt: nennungCheckbox.checked }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorMsg.textContent = data.error || "Fehler beim Bestätigen.";
        submitBtn.disabled = false;
        return;
      }
      load();
    } catch {
      errorMsg.textContent = "Verbindungsfehler. Bitte später erneut versuchen.";
      submitBtn.disabled = false;
    }
  });

  return form;
}

// Das Angebot muss die Kundin schon sehen können, BEVOR sie bestätigt - sie
// soll ja genau anhand des Angebots entscheiden. Die Rechnung gehört
// inhaltlich zu den Design-Dateien und wird daher in renderDownloadSection
// zusammen mit ihnen gezeigt, nicht hier.
function renderAngebotSection(order) {
  if (!order.angebotDatei) return null;
  return el("div", { className: "order-documents-section" }, [
    el("a", { className: "btn", href: `${ADMIN_ORIGIN}/uploads/${order.angebotDatei}`, target: "_blank", rel: "noopener", textContent: "📄 Angebot ansehen" }),
  ]);
}

function render(order) {
  contentEl.innerHTML = "";

  const summary = el("section", { className: "order-summary" }, [
    el("p", { textContent: `Hallo ${order.kunde_name}, hier ist eine Übersicht deiner Bestellung:` }),
    renderDesignsList(order),
    el("p", { className: "order-total", textContent: `Gesamtsumme: ${formatPrice(order.total)}` }),
  ]);
  contentEl.appendChild(summary);

  const angebot = renderAngebotSection(order);
  if (angebot) contentEl.appendChild(angebot);

  if (order.downloadFreigegeben) {
    contentEl.appendChild(renderDownloadSection(order));
  } else if (order.confirmed) {
    contentEl.appendChild(el("div", { className: "order-waiting" }, [
      el("p", { textContent: `✅ Bestätigt am ${formatDate(order.confirmedAt)}.` }),
      el("p", { textContent: "Sobald deine Zahlung bei uns eingegangen ist, kannst du über diesen selben Link deine Dateien herunterladen. Du musst nichts weiter tun." }),
    ]));
  } else {
    contentEl.appendChild(renderConfirmForm(order));
  }
}

// WhatsApp-Kontakt im Footer ist optional (nur wenn eine Nummer hinterlegt
// ist) - lädt unabhängig von der Bestellung selbst, damit die Kontaktzeile
// auch bei einem Fehler beim Laden der Bestellung nutzbar bleibt. Bewusst
// relativ (gleiche Origin wie bestellung.html, server-public.js) statt
// ADMIN_ORIGIN - das dortige /api/config verlangt Mitarbeiter-Login und wäre
// für Kundinnen immer ein 401.
async function loadWhatsappContact() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    if (!config.whatsappNumber) return;
    const link = document.getElementById("order-whatsapp-link");
    const text = encodeURIComponent(`Hallo! Ich habe eine Frage zu meiner Bestellung: ${window.location.href}`);
    link.href = `https://wa.me/${config.whatsappNumber}?text=${text}`;
    link.hidden = false;
  } catch {
    // Kontaktzeile bleibt einfach ohne WhatsApp-Link, E-Mail/Instagram reichen als Fallback
  }
}

async function load() {
  if (!token) {
    renderError("Kein gültiger Link.");
    return;
  }
  try {
    const res = await fetch(`${ADMIN_ORIGIN}/api/public/order/${token}`);
    const data = await res.json();
    if (!res.ok) {
      renderError(data.error || "Bestellung nicht gefunden.");
      return;
    }
    render(data);
  } catch {
    renderError("Verbindungsfehler. Bitte später erneut versuchen.");
  }
}

load();
loadWhatsappContact();
