const searchInput = document.getElementById("design-search");
const cardsEl = document.getElementById("design-cards");
const noResults = document.getElementById("no-results");
const emptyState = document.getElementById("empty-state");

let allDesigns = [];

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function renderCards(designs) {
  cardsEl.innerHTML = "";
  designs.forEach((d) => {
    const card = el("article", { className: "card" });
    card.dataset.name = `${d.name} ${d.description || ""}`.toLowerCase();
    card.appendChild(el("img", { src: d.image, alt: d.name, className: "card-thumb" }));
    card.appendChild(el("h3", { textContent: d.name }));
    card.appendChild(el("p", { textContent: d.description || "" }));
    cardsEl.appendChild(card);
  });
}

async function loadDesigns() {
  const res = await fetch("/api/designs");
  allDesigns = await res.json();
  renderCards(allDesigns);
  emptyState.hidden = allDesigns.length !== 0;
}

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = allDesigns.filter((d) =>
    `${d.name} ${d.description || ""}`.toLowerCase().includes(query)
  );
  renderCards(filtered);
  noResults.hidden = filtered.length !== 0 || allDesigns.length === 0;
  emptyState.hidden = allDesigns.length !== 0;
});

loadDesigns();
