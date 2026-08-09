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
