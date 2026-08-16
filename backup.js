// Zieht eine konsistente Online-Kopie der SQLite-Datenbank über SQLites
// eingebaute Backup-API (sqlite3_backup_*) - im Gegensatz zu einem simplen
// Datei-Kopieren funktioniert das sicher, während die App weiterläuft, und
// erfasst auch Daten, die noch nur im WAL-Journal stehen (siehe
// scripts/backup-db.sh, das dieses Skript aufruft).
//
// Aufruf: node backup.js <Zielpfad>
const path = require("path");
const Database = require("better-sqlite3");

const destPath = process.argv[2];
if (!destPath) {
  console.error("Zielpfad fehlt. Aufruf: node backup.js <Zielpfad>");
  process.exit(1);
}

const DB_PATH = path.join(__dirname, "data", "teddys.db");

const db = new Database(DB_PATH, { fileMustExist: true });
db.backup(destPath)
  .then(() => {
    db.close();
    console.log(`Backup geschrieben nach ${destPath}`);
  })
  .catch((err) => {
    console.error("Backup fehlgeschlagen:", err.message);
    process.exit(1);
  });
