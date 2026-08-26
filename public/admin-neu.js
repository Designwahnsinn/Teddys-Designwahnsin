const form = document.getElementById("upload-form");
const message = document.getElementById("form-message");
const categorySelect = document.getElementById("category");
const nextIdHint = document.getElementById("next-id-hint");
const imageInput = document.getElementById("image");
const filePreview = document.getElementById("image-file-preview");
const tagsField = document.getElementById("tags-field");

// Ausbau 1.6, Ebene 3: kleine aufklappbare Hinweise statt langem Fließtext,
// der ab dem dritten Design ohnehin überlesen wird.
document.querySelectorAll(".field-help-toggle").forEach((btn) => {
  const target = document.getElementById(btn.dataset.help);
  if (!target) return;
  btn.addEventListener("click", () => {
    target.hidden = !target.hidden;
  });
});

// Ebene 2: Zeichenanzeige mit Zielbereich, damit Beschreibungen nicht
// zwischen zwei Zeilen und zwei Absätzen schwanken.
const descriptionField = document.getElementById("description");
const descriptionCount = document.getElementById("description-count");
if (descriptionField && descriptionCount) {
  const updateCount = () => {
    const len = descriptionField.value.length;
    descriptionCount.textContent = `${len} Zeichen (Richtwert: 100–300)`;
  };
  descriptionField.addEventListener("input", updateCount);
  updateCount();
}

// Mindestauflösung live nachrechnen, wenn die Größe vom 20x20cm-Standard
// abweicht - dieselbe Formel wie minPrintDimensionPx() in server-admin.js.
const groesseField = document.getElementById("groesseCm");
const groesseHint = document.getElementById("groesse-hint");
if (groesseField && groesseHint) {
  const updateGroesseHint = () => {
    const cm = Number(groesseField.value) || 20;
    const minPx = Math.round((cm / 2.54) * 300);
    groesseHint.textContent = `Größe: ${cm} × ${cm} cm bei 300 dpi (≈ ${minPx} × ${minPx} Pixel)`;
  };
  groesseField.addEventListener("input", updateGroesseHint);
  updateGroesseHint();
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

// Freies Mehrfach-Tag-Eingabefeld mit Autovervollständigung aus bereits
// vorhandenen Tags. Die Auswahl landet in einem versteckten JSON-Feld
// (name="tags"), damit sie über das normale <form>/FormData (wegen
// Datei-Upload) mitgeschickt wird - server-admin.js parst es dort.
function buildTagInput(allTags) {
  const selected = [];
  const wrap = el("div", { className: "tag-input" });
  const chipsEl = el("div", { className: "tag-input-chips" });
  const textInput = el("input", { type: "text", placeholder: "Tag eingeben und Enter …", className: "tag-input-field" });
  const suggestionsEl = el("div", { className: "tag-input-suggestions", hidden: true });
  const hiddenInput = el("input", { type: "hidden", name: "tags" });

  function syncHidden() {
    hiddenInput.value = JSON.stringify(selected);
  }

  function renderChips() {
    chipsEl.innerHTML = "";
    selected.forEach((tag) => {
      const removeBtn = el("button", { type: "button", textContent: "×", "aria-label": `${tag} entfernen` });
      removeBtn.addEventListener("click", () => {
        selected.splice(selected.indexOf(tag), 1);
        renderChips();
        syncHidden();
      });
      chipsEl.appendChild(el("span", { className: "tag-chip" }, [document.createTextNode(tag), removeBtn]));
    });
  }

  function addTag(name) {
    // Kleinschreibung passend zur Schreibkonvention (Ausbau 1.6/1.8) - sonst
    // erscheinen "Blume" und "blume" clientseitig als zwei Chips, obwohl der
    // Server sie ohnehin auf denselben Tag zusammenführt.
    const trimmed = name.trim().toLowerCase();
    if (!trimmed || selected.includes(trimmed)) return;
    selected.push(trimmed);
    renderChips();
    syncHidden();
    textInput.value = "";
    suggestionsEl.hidden = true;
  }

  function updateSuggestions() {
    const query = textInput.value.trim().toLowerCase();
    suggestionsEl.innerHTML = "";
    if (!query) { suggestionsEl.hidden = true; return; }
    const matches = allTags.filter((t) => t.toLowerCase().includes(query) && !selected.includes(t)).slice(0, 8);
    if (matches.length === 0) { suggestionsEl.hidden = true; return; }
    matches.forEach((t) => {
      const item = el("button", { type: "button", className: "tag-input-suggestion", textContent: t });
      item.addEventListener("click", () => addTag(t));
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.hidden = false;
  }

  textInput.addEventListener("input", updateSuggestions);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(textInput.value);
    }
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) suggestionsEl.hidden = true;
  });

  renderChips();
  syncHidden();
  wrap.append(chipsEl, textInput, suggestionsEl, hiddenInput);
  return wrap;
}

// "Unsortiert" ist der bewusste Ausweg, wenn nichts passt (Ausbau 1.8/K5) -
// steht deshalb immer als letzter Eintrag der Liste, nie als Vorauswahl.
function sortCategoriesUnsortiertLast(categories) {
  return [...categories].sort((a, b) => (a === "Unsortiert") - (b === "Unsortiert"));
}

async function loadCategories() {
  const res = await fetch("/api/config");
  const config = await res.json();
  categorySelect.innerHTML = "";
  sortCategoriesUnsortiertLast(config.categories).forEach((c) => {
    categorySelect.appendChild(el("option", { value: c, textContent: c }));
  });
  tagsField.appendChild(buildTagInput(config.tags || []));
}

async function loadNextId() {
  const res = await fetch("/api/admin/designs/next-id");
  if (!res.ok) return;
  const data = await res.json();
  nextIdHint.textContent = `Nächste ID: ${data.id}`;
}

// Reine Canva-Arbeitszeit (optional): Start-Knopf wird VOR dem Wechsel zu
// Canva gedrückt, die Uhr stoppt automatisch beim ersten Datei-Auswählen
// danach - eigene Phase VOR uploadStartedAt (das misst nur Datei-auswählen
// bis Absenden, also das Ausfüllen des Formulars). localStorage statt einer
// reinen JS-Variable, weil der Wechsel zu Canva den Tab/die Seite u.U.
// verlässt oder neu lädt, während die Uhr weiterlaufen soll.
const CANVA_TIMER_KEY = "canvaTimerStartedAt";
const CANVA_TIMER_MAX_AGE_MS = 2 * 60 * 60 * 1000; // wie serverseitiges Limit - ein vergessener Timer verzerrt sonst die Auswertung
const canvaTimerBtn = document.getElementById("canva-timer-start");
const canvaTimerStatus = document.getElementById("canva-timer-status");
let canvaDurationMs = null;
let canvaTimerTickHandle = null;

function formatDauer(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")} Min.`;
}

function stopCanvaTimerTick() {
  if (canvaTimerTickHandle !== null) {
    clearInterval(canvaTimerTickHandle);
    canvaTimerTickHandle = null;
  }
}

function showCanvaTimerRunning(startedAt) {
  canvaTimerBtn.hidden = true;
  canvaTimerStatus.hidden = false;
  stopCanvaTimerTick();
  const tick = () => {
    canvaTimerStatus.textContent = `⏱️ Zeitmessung läuft seit ${formatDauer(Date.now() - startedAt)} - ab jetzt zu Canva wechseln, die Uhr stoppt beim Datei-Auswählen unten.`;
  };
  tick();
  canvaTimerTickHandle = setInterval(tick, 1000);
}

// Ein vergessener/liegen gelassener Timer (z.B. Tab seit Tagen offen) soll
// nicht stillschweigend als aktiv gelten und dann eine absurde Dauer liefern.
const storedStart = Number(localStorage.getItem(CANVA_TIMER_KEY));
if (storedStart && Date.now() - storedStart < CANVA_TIMER_MAX_AGE_MS) {
  showCanvaTimerRunning(storedStart);
} else if (storedStart) {
  localStorage.removeItem(CANVA_TIMER_KEY);
}

canvaTimerBtn.addEventListener("click", () => {
  const startedAt = Date.now();
  localStorage.setItem(CANVA_TIMER_KEY, String(startedAt));
  showCanvaTimerRunning(startedAt);
});

function stopCanvaTimerOnFileSelect() {
  const stored = Number(localStorage.getItem(CANVA_TIMER_KEY));
  if (!stored) return;
  localStorage.removeItem(CANVA_TIMER_KEY);
  stopCanvaTimerTick();
  if (Date.now() - stored >= CANVA_TIMER_MAX_AGE_MS) {
    // Zu alt/unplausibel (siehe storedStart-Check oben) - nicht mitsenden,
    // aber Hinweis zurücksetzen, damit kein falscher Eindruck bleibt.
    canvaTimerStatus.hidden = true;
    canvaTimerBtn.hidden = false;
    return;
  }
  canvaDurationMs = Date.now() - stored;
  canvaTimerStatus.hidden = false;
  canvaTimerStatus.textContent = `✅ Canva-Zeit gestoppt: ${formatDauer(canvaDurationMs)}`;
}

// Testkonzept-Auswertung: Startzeitpunkt der Aufgabe "Design hochladen" - das
// erste Datei-Auswählen ist der konkreteste, unzweideutige Startpunkt.
let uploadStartedAt = null;

imageInput.addEventListener("change", () => {
  if (uploadStartedAt === null) {
    uploadStartedAt = Date.now();
    stopCanvaTimerOnFileSelect();
  }
  filePreview.innerHTML = "";
  [...imageInput.files].forEach((file) => {
    filePreview.appendChild(el("img", { src: URL.createObjectURL(file), alt: "Vorschau" }));
  });
});

// Warnt vor versehentlichem Verlassen der Seite, solange Angaben gemacht
// wurden (Name eingetragen oder Dateien ausgewählt), aber noch nicht
// abgeschickt - submitted unterdrückt die Warnung bei der eigenen
// Weiterleitung nach erfolgreichem Absenden.
let submitted = false;
window.addEventListener("beforeunload", (e) => {
  if (!submitted && (document.getElementById("name").value.trim() || imageInput.files.length > 0)) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const submitBtn = form.querySelector('button[type="submit"]');

function formatFehlgeschlagen(list) {
  return list.map((f) => `${f.dateiname}: ${f.grund}`).join(" | ");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";
  message.className = "";

  // Ohne diese Sperre konnte ein zweiter Klick (z.B. weil der Upload durch
  // die automatische Wasserzeichen-Erzeugung spürbar länger dauert und man
  // denkt, der erste Klick hätte nicht funktioniert) dasselbe Design doppelt
  // anlegen - jeder Klick landet als eigener POST-Request mit eigener ID.
  if (submitBtn.disabled) return;
  submitBtn.disabled = true;
  submitBtn.textContent = "Lädt hoch … Bitte Fenster nicht schließen.";

  try {
    const formData = new FormData(form);
    if (uploadStartedAt !== null) formData.append("uploadDurationMs", String(Date.now() - uploadStartedAt));
    if (canvaDurationMs !== null) formData.append("canvaDurationMs", String(canvaDurationMs));
    const res = await fetch("/api/admin/designs", { method: "POST", body: formData });

    if (res.ok) {
      const data = await res.json();
      const parts = [];
      let className = "success";
      if (data.qualityWarnings && data.qualityWarnings.length > 0) {
        parts.push(`⚠️ ${data.qualityWarnings.join(" | ")}`);
        className = "warning";
      }
      if (data.fehlgeschlagen && data.fehlgeschlagen.length > 0) {
        parts.push(`❌ Nicht mit hochgeladen: ${formatFehlgeschlagen(data.fehlgeschlagen)} - lässt sich auf der nächsten Seite nachholen.`);
        className = "warning";
      }
      message.textContent = `Design hochgeladen. ${parts.join(" ")} Weiter zur Bilder-Zuordnung …`.trim();
      message.className = className;
      submitted = true;
      window.location.href = `/mitarbeiter/designs/bilder?id=${data.id}`;
    } else {
      const data = await res.json().catch(() => ({}));
      message.textContent = data.error || "Fehler beim Hochladen.";
      message.className = "error";
      submitBtn.disabled = false;
      submitBtn.textContent = "Design hochladen";
    }
  } catch {
    message.textContent = "Verbindungsfehler. Bitte später erneut versuchen.";
    message.className = "error";
    submitBtn.disabled = false;
    submitBtn.textContent = "Design hochladen";
  }
});

loadCategories();
loadNextId();
