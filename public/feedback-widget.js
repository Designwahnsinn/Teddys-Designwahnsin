// Testkonzept Test A: Schnellerfassung von jeder Seite des Mitarbeiterbereichs
// aus, ohne Kontextwechsel (kein zweites Browserfenster). Bewusst minimal -
// Art, ein Textfeld, Speichern - wer mitten in der Arbeit vier Felder
// ausfüllen soll, benutzt es nach dem zweiten Mal nicht mehr. Der eigentliche
// Gewinn ist der automatisch mitgeschickte Kontext (welche Seite, ggf. welche
// ID in der URL), nicht das Formular selbst.
(function () {
  const PAGE_LABELS = {
    "/mitarbeiter/upload": "Dashboard",
    "/mitarbeiter/neu": "Design hochladen",
    "/mitarbeiter/designs": "Designs verwalten",
    "/mitarbeiter/designs/bilder": "Bilder-Verwaltung",
    "/mitarbeiter/kategorien": "Kategorien verwalten",
    "/mitarbeiter/bestellungen": "Bestellungen",
    "/mitarbeiter/bestellungen/neu": "Bestellung anlegen",
    "/mitarbeiter/bestellungen/bearbeiten": "Bestellung bearbeiten",
    "/mitarbeiter/nas": "NAS-Ordner",
    "/mitarbeiter/kundenlinks": "Kunden-Links",
  };

  function currentKontext() {
    const label = PAGE_LABELS[location.pathname] || location.pathname;
    const id = new URLSearchParams(location.search).get("id");
    return id ? `${label} (${id})` : label;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  const toggleBtn = el("button", {
    type: "button",
    className: "feedback-widget-toggle",
    textContent: "📝",
    title: "Feedback / offenen Punkt notieren",
  });

  const artSelect = el("select", { className: "feedback-widget-art" }, [
    el("option", { value: "Umständlich", textContent: "Umständlich", selected: true }),
    el("option", { value: "Fehler", textContent: "Fehler" }),
    el("option", { value: "Fehlt", textContent: "Fehlt" }),
    el("option", { value: "Idee", textContent: "Idee" }),
  ]);
  const textField = el("textarea", { className: "feedback-widget-text", rows: 5, placeholder: "Kurz notieren …" });
  const statusEl = el("span", { className: "feedback-widget-status" });
  const saveBtn = el("button", { type: "button", className: "feedback-widget-save", textContent: "Speichern" });
  const panel = el("div", { className: "feedback-widget-panel", hidden: true }, [
    el("div", { className: "feedback-widget-kontext", textContent: `Kontext: ${currentKontext()}` }),
    artSelect,
    textField,
    el("div", { className: "feedback-widget-actions" }, [saveBtn, statusEl]),
  ]);

  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) textField.focus();
  });

  saveBtn.addEventListener("click", async () => {
    const text = textField.value.trim();
    if (!text) return;
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/admin/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, art: artSelect.value, kontext: currentKontext() }),
      });
      if (res.ok) {
        textField.value = "";
        statusEl.textContent = "Gespeichert ✓";
        setTimeout(() => {
          statusEl.textContent = "";
          panel.hidden = true;
        }, 900);
      } else {
        statusEl.textContent = "Fehler beim Speichern.";
      }
    } catch {
      statusEl.textContent = "Verbindungsfehler.";
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.body.append(toggleBtn, panel);
})();
