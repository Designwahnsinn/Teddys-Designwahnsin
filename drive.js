const fs = require("fs");
const { google } = require("googleapis");

const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || "";
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

// Ohne beide Angaben bleibt der Sync einfach deaktiviert, statt den Server
// zum Absturz zu bringen - Drive-Anbindung ist ein optionales Zusatzfeature.
const enabled = Boolean(KEY_FILE && FOLDER_ID && fs.existsSync(KEY_FILE));
if (KEY_FILE || FOLDER_ID) {
  console.log(enabled ? "Google-Drive-Sync aktiviert." : "Google-Drive-Sync NICHT aktiv (Key-Datei oder Ordner-ID fehlt/ungültig).");
}

let driveClient = null;
function getDrive() {
  if (!driveClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    driveClient = google.drive({ version: "v3", auth });
  }
  return driveClient;
}

// Lädt eine bereits lokal gespeicherte Datei zusätzlich zu Google Drive hoch.
// Bewusst fire-and-forget: ein Drive-Fehler darf den normalen Upload-Flow
// (lokale Datei + Datenbankeintrag) nie blockieren oder scheitern lassen.
async function syncToDrive(localFilePath, driveFileName, mimeType) {
  if (!enabled) return;
  try {
    await getDrive().files.create({
      requestBody: { name: driveFileName, parents: [FOLDER_ID] },
      media: { mimeType, body: fs.createReadStream(localFilePath) },
      fields: "id",
    });
  } catch (err) {
    console.error(`Google-Drive-Sync fehlgeschlagen für "${driveFileName}":`, err.message);
  }
}

module.exports = { syncToDrive, enabled };
