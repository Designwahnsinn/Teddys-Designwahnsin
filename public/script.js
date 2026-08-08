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

let allDesigns = [];
let whatsappNumber = "";
let activeCategory = "Alle";

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

    const overlay = el("div", { className: "masonry-overlay" }, [
      el("h3", { textContent: d.name }),
      el("p", { textContent: formatPrice(d.price) }),
    ]);
    if (d.status === "exklusiv") {
      overlay.prepend(el("span", { className: "badge-exklusiv", textContent: "Exklusiv" }));
    }
    card.appendChild(overlay);

    card.addEventListener("click", () => openLightbox(d));
    cardsEl.appendChild(card);
  });
}

function openLightbox(design) {
  lightboxImage.src = design.image;
  lightboxImage.alt = design.name;
  lightboxId.textContent = design.id;
  lightboxName.textContent = design.name;
  lightboxDescription.textContent = design.description || "";
  lightboxPrice.textContent = formatPrice(design.price);

  lightboxBadge.hidden = design.status !== "exklusiv";
  lightboxBadge.textContent = "Exklusiv – nur einmal erhältlich";

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
}

searchInput.addEventListener("input", update);

init();
