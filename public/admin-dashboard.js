fetch("/api/config")
  .then((res) => res.json())
  .then((config) => {
    if (config.siteLive || !config.previewUrl) return;
    const banner = document.getElementById("preview-banner");
    banner.innerHTML = `
      <div class="preview-banner">
        🚧 Die Seite ist noch <strong>nicht live</strong> (Baustellen-Modus aktiv).
        <a href="${config.previewUrl}" target="_blank" rel="noopener">Echte Seite trotzdem ansehen →</a>
      </div>`;
  });

// --- Feedback & offene Punkte ---
const feedbackForm = document.getElementById("feedback-form");
const feedbackText = document.getElementById("feedback-text");
const feedbackList = document.getElementById("feedback-list");

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderFeedbackItem(item) {
  const checkbox = el("input", { type: "checkbox", checked: item.status === "erledigt" });
  checkbox.addEventListener("change", async () => {
    await fetch(`/api/admin/feedback/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: checkbox.checked ? "erledigt" : "offen" }),
    });
    loadFeedback();
  });

  const deleteBtn = el("button", { type: "button", className: "feedback-delete", textContent: "×", title: "Löschen" });
  deleteBtn.addEventListener("click", async () => {
    await fetch(`/api/admin/feedback/${item.id}`, { method: "DELETE" });
    loadFeedback();
  });

  return el("div", { className: `feedback-item${item.status === "erledigt" ? " feedback-done" : ""}` }, [
    checkbox,
    el("span", { className: "feedback-item-text", textContent: item.text }),
    el("span", { className: "feedback-item-date", textContent: formatDate(item.createdAt) }),
    deleteBtn,
  ]);
}

async function loadFeedback() {
  const res = await fetch("/api/admin/feedback");
  const items = await res.json();
  feedbackList.innerHTML = "";
  if (items.length === 0) {
    feedbackList.appendChild(el("p", { className: "wizard-hint", textContent: "Keine offenen Punkte notiert." }));
    return;
  }
  items.forEach((item) => feedbackList.appendChild(renderFeedbackItem(item)));
}

feedbackForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = feedbackText.value.trim();
  if (!text) return;
  await fetch("/api/admin/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  feedbackText.value = "";
  loadFeedback();
});

loadFeedback();
