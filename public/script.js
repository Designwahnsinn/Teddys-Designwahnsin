const searchInput = document.getElementById("design-search");
const cardsEl = document.getElementById("design-cards");
const filtersEl = document.getElementById("category-filters");
const noResults = document.getElementById("no-results");
const emptyState = document.getElementById("empty-state");

const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxBadge = document.getElementById("lightbox-badge");
const lightboxId = document.getElementById("lightbox-id");
const lightboxName = document.getElementById("lightbox-name");
const lightboxDescription = document.getElementById("lightbox-description");
const lightboxPrice = document.getElementById("lightbox-price");
const lightboxWhatsapp = document.getElementById("lightbox-whatsapp");
const lightboxBuy = document.getElementById("lightbox-buy");
const lightboxInstagram = document.getElementById("lightbox-instagram");
const lightboxInquiryToggle = document.getElementById("lightbox-inquiry-toggle");

const inquiryBar = document.getElementById("inquiry-bar");
const inquiryOpenBtn = document.getElementById("inquiry-open-btn");
const inquiryCount = document.getElementById("inquiry-count");
const inquiryModal = document.getElementById("inquiry-modal");
const inquirySelectedList = document.getElementById("inquiry-selected-list");
const inquiryForm = document.getElementById("inquiry-form");
const inquiryMessageStatus = document.getElementById("inquiry-message-status");

const ADMIN_ORIGIN = "https://mitarbeiter.designwahnsinn-teddy.de";
const SELECTION_KEY = "teddys_anfrage_designs";

let allDesigns = [];
let whatsappNumber = "";
let activeCategory = "Alle";
let currentLightboxDesign = null;

function loadSelection() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SELECTION_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSelection() {
  localStorage.setItem(SELECTION_KEY, JSON.stringify([...selection]));
}

let selection = loadSelection();

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function formatPrice(price) {
  return price != null ? `${Number(price).toFixed(2)} €` : "";
}

function visibleDesigns() {
  const query = searchInput.value.trim().toLowerCase();
  return allDesigns.filter((d) => {
    const matchesCategory = activeCategory === "Alle" || d.category === activeCategory;
    const matchesQuery = `${d.name} ${d.description || ""} ${d.category || ""}`
      .toLowerCase()
      .includes(query);
    return matchesCategory && matchesQuery;
  });
}

function renderFilters(categories) {
  filtersEl.innerHTML = "";
  ["Alle", ...categories].forEach((c) => {
    const btn = el("button", {
      type: "button",
      className: `filter-btn${c === activeCategory ? " active" : ""}`,
      textContent: c,
    });
    btn.addEventListener("click", () => {
      activeCategory = c;
      [...filtersEl.children].forEach((b) => b.classList.toggle("active", b === btn));
      update();
    });
    filtersEl.appendChild(btn);
  });
}

function renderCards(designs) {
  cardsEl.innerHTML = "";
  designs.forEach((d) => {
    const card = el("article", { className: "masonry-card" });
    card.appendChild(el("img", { src: d.image, alt: d.name, loading: "lazy" }));

    const selectBtn = el("button", {
      type: "button",
      className: `select-toggle${selection.has(d.id) ? " selected" : ""}`,
      textContent: selection.has(d.id) ? "✓ Ausgewählt" : "+ Anfrage",
    });
    selectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelection(d.id);
    });

    const overlay = el("div", { className: "masonry-overlay" }, [
      el("h3", { textContent: d.name }),
      el("p", { textContent: formatPrice(d.price) }),
      selectBtn,
    ]);
    if (d.status === "exklusiv") {
      overlay.prepend(el("span", { className: "badge-exklusiv", textContent: "Exklusiv" }));
    }
    card.appendChild(overlay);

    card.addEventListener("click", () => openLightbox(d));
    cardsEl.appendChild(card);
  });
}

function toggleSelection(id) {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  saveSelection();
  updateInquiryBar();
  renderCards(visibleDesigns());
  if (currentLightboxDesign && currentLightboxDesign.id === id) {
    updateLightboxInquiryToggle();
  }
}

function updateInquiryBar() {
  inquiryCount.textContent = selection.size;
  inquiryBar.hidden = selection.size === 0;
}

function updateLightboxInquiryToggle() {
  const isSelected = selection.has(currentLightboxDesign.id);
  lightboxInquiryToggle.textContent = isSelected ? "✓ Zur Anfrage hinzugefügt" : "+ Zur Anfrage hinzufügen";
  lightboxInquiryToggle.classList.toggle("selected", isSelected);
}

function openLightbox(design) {
  currentLightboxDesign = design;
  lightboxImage.src = design.image;
  lightboxImage.alt = design.name;
  lightboxId.textContent = design.id;
  lightboxName.textContent = design.name;
  lightboxDescription.textContent = design.description || "";
  lightboxPrice.textContent = formatPrice(design.price);

  lightboxBadge.hidden = design.status !== "exklusiv";
  lightboxBadge.textContent = "Exklusiv – nur einmal erhältlich";

  updateLightboxInquiryToggle();

  if (whatsappNumber) {
    const text = encodeURIComponent(`Hallo! Ich interessiere mich für das Design ${design.id} – ${design.name}.`);
    lightboxWhatsapp.href = `https://wa.me/${whatsappNumber}?text=${text}`;
    lightboxWhatsapp.hidden = false;
  } else {
    lightboxWhatsapp.hidden = true;
  }

  if (design.kaufLink) {
    lightboxBuy.href = design.kaufLink;
    lightboxBuy.hidden = false;
  } else {
    lightboxBuy.hidden = true;
  }

  if (design.instagramLink) {
    lightboxInstagram.href = design.instagramLink;
    lightboxInstagram.hidden = false;
  } else {
    lightboxInstagram.hidden = true;
  }

  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.style.overflow = "";
}

document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
document.getElementById("lightbox-backdrop").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
});

lightboxInquiryToggle.addEventListener("click", () => {
  toggleSelection(currentLightboxDesign.id);
});

// --- Anfrage-Modal ---
function renderInquirySelectedList() {
  inquirySelectedList.innerHTML = "";
  [...selection].forEach((id) => {
    const design = allDesigns.find((d) => d.id === id);
    if (!design) return;
    const removeBtn = el("button", { type: "button", textContent: "×", "aria-label": `${design.name} entfernen` });
    removeBtn.addEventListener("click", () => {
      toggleSelection(id);
      renderInquirySelectedList();
      if (selection.size === 0) closeInquiryModal();
    });
    inquirySelectedList.appendChild(
      el("div", { className: "inquiry-selected-item" }, [
        el("img", { src: design.image, alt: design.name }),
        el("span", { textContent: design.name }),
        removeBtn,
      ])
    );
  });
}

function openInquiryModal() {
  renderInquirySelectedList();
  inquiryMessageStatus.textContent = "";
  inquiryMessageStatus.className = "";
  inquiryModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeInquiryModal() {
  inquiryModal.hidden = true;
  document.body.style.overflow = "";
}

inquiryOpenBtn.addEventListener("click", openInquiryModal);
document.getElementById("inquiry-close").addEventListener("click", closeInquiryModal);
document.getElementById("inquiry-backdrop").addEventListener("click", closeInquiryModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !inquiryModal.hidden) closeInquiryModal();
});

inquiryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  inquiryMessageStatus.textContent = "";
  inquiryMessageStatus.className = "";

  const submitBtn = inquiryForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${ADMIN_ORIGIN}/api/public/inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kunde_name: document.getElementById("inquiry-name").value.trim(),
        kunde_email: document.getElementById("inquiry-email").value.trim(),
        message: document.getElementById("inquiry-message").value.trim(),
        designIds: [...selection],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      inquiryMessageStatus.textContent = data.error || "Fehler beim Senden der Anfrage.";
      inquiryMessageStatus.className = "error";
      return;
    }
    inquiryMessageStatus.textContent = "Danke! Deine Anfrage ist eingegangen, wir melden uns per E-Mail.";
    inquiryMessageStatus.className = "success";
    inquiryForm.reset();
    selection.clear();
    saveSelection();
    updateInquiryBar();
    renderCards(visibleDesigns());
    if (currentLightboxDesign) updateLightboxInquiryToggle();
    setTimeout(closeInquiryModal, 2000);
  } catch {
    inquiryMessageStatus.textContent = "Verbindungsfehler. Bitte später erneut versuchen.";
    inquiryMessageStatus.className = "error";
  } finally {
    submitBtn.disabled = false;
  }
});

function update() {
  const designs = visibleDesigns();
  renderCards(designs);
  noResults.hidden = designs.length !== 0 || allDesigns.length === 0;
  emptyState.hidden = allDesigns.length !== 0;
}

async function init() {
  const [configRes, designsRes] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/designs"),
  ]);
  const config = await configRes.json();
  allDesigns = await designsRes.json();
  whatsappNumber = config.whatsappNumber;

  renderFilters(config.categories);
  update();
  updateInquiryBar();
}

searchInput.addEventListener("input", update);

init();
