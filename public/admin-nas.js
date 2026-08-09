const breadcrumbEl = document.getElementById("nas-breadcrumb");
const listEl = document.getElementById("nas-list");

let currentPath = "";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".avif"];
function isImageFile(name) {
  return IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  (children || []).forEach((c) => node.appendChild(c));
  return node;
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = "";
  const parts = currentPath ? currentPath.split("/") : [];

  const rootLink = el("a", { href: "#", textContent: "📁 uploads-sorted" });
  rootLink.addEventListener("click", (e) => { e.preventDefault(); navigate(""); });
  breadcrumbEl.appendChild(rootLink);

  let accPath = "";
  parts.forEach((part) => {
    accPath = accPath ? `${accPath}/${part}` : part;
    const target = accPath;
    breadcrumbEl.appendChild(document.createTextNode(" / "));
    const link = el("a", { href: "#", textContent: part });
    link.addEventListener("click", (e) => { e.preventDefault(); navigate(target); });
    breadcrumbEl.appendChild(link);
  });
}

async function navigate(newPath) {
  currentPath = newPath;
  renderBreadcrumb();
  listEl.innerHTML = "Lädt …";

  const res = await fetch(`/api/admin/nas-browse?path=${encodeURIComponent(currentPath)}`);
  if (!res.ok) {
    listEl.textContent = "Ordner konnte nicht geladen werden.";
    return;
  }
  const data = await res.json();
  listEl.innerHTML = "";

  if (data.entries.length === 0) {
    listEl.appendChild(el("p", { className: "wizard-hint", textContent: "(leer)" }));
    return;
  }

  data.entries.forEach((entry) => {
    const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    if (entry.type === "dir") {
      const row = el("button", { type: "button", className: "nas-row nas-dir", textContent: `📁 ${entry.name}` });
      row.addEventListener("click", () => navigate(entryPath));
      listEl.appendChild(row);
    } else {
      const row = el("a", {
        className: "nas-row nas-file",
        href: `/api/admin/nas-browse/download?path=${encodeURIComponent(entryPath)}`,
      });
      if (isImageFile(entry.name)) {
        row.appendChild(el("img", {
          className: "nas-thumb",
          src: `/api/admin/nas-browse/view?path=${encodeURIComponent(entryPath)}`,
          alt: "",
        }));
      } else {
        row.appendChild(el("span", { textContent: "📄" }));
      }
      row.appendChild(document.createTextNode(` ${entry.name}`));
      listEl.appendChild(row);
    }
  });
}

navigate("");
