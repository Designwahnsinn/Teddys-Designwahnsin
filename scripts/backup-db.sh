#!/usr/bin/env bash
set -euo pipefail

# Läuft als Cronjob auf dem VPS-Host (nicht im Container). Zieht per
# backup.js (im laufenden Admin-Container, siehe docker-compose.yml) eine
# konsistente Kopie der Datenbank, komprimiert sie und überträgt sie per
# SCP/SSH auf die Synology NAS. Alte Backups auf der NAS werden im selben
# Lauf per SSH-Befehl aufgeräumt (Retention).
#
# Einmalige Einrichtung: siehe scripts/backup.env.example
cd "$(dirname "$0")/.."

CONFIG_FILE="scripts/backup.env"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Fehlt: $CONFIG_FILE (siehe scripts/backup.env.example zum Kopieren/Anpassen)" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${NAS_SSH_USER:?NAS_SSH_USER fehlt in $CONFIG_FILE}"
: "${NAS_SSH_HOST:?NAS_SSH_HOST fehlt in $CONFIG_FILE}"
: "${NAS_BACKUP_PATH:?NAS_BACKUP_PATH fehlt in $CONFIG_FILE}"
NAS_SSH_PORT="${NAS_SSH_PORT:-22}"
SSH_KEY="${BACKUP_SSH_KEY:-$HOME/.ssh/teddys_backup_ed25519}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
TMP_DB="data/backup-tmp-$TIMESTAMP.db"
GZ_NAME="teddys-backup-$TIMESTAMP.db.gz"
GZ_TMP="/tmp/$GZ_NAME"

echo "[$TIMESTAMP] Erstelle DB-Snapshot ..."
docker compose exec -T teddys-designwahnsinn-admin node backup.js "/app/$TMP_DB"

gzip "$TMP_DB"
mv "$TMP_DB.gz" "$GZ_TMP"

echo "[$TIMESTAMP] Übertrage nach NAS ($NAS_SSH_HOST) ..."
scp -P "$NAS_SSH_PORT" -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
  "$GZ_TMP" "$NAS_SSH_USER@$NAS_SSH_HOST:$NAS_BACKUP_PATH/$GZ_NAME"
rm -f "$GZ_TMP"

echo "[$TIMESTAMP] Räume Backups älter als $RETENTION_DAYS Tage auf der NAS auf ..."
ssh -p "$NAS_SSH_PORT" -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$NAS_SSH_USER@$NAS_SSH_HOST" \
  "find '$NAS_BACKUP_PATH' -maxdepth 1 -name 'teddys-backup-*.db.gz' -mtime +$RETENTION_DAYS -delete"

echo "[$TIMESTAMP] Fertig: $GZ_NAME"

# --- Wiederherstellung im Ernstfall ---
# 1. gzip -d teddys-backup-<Zeitstempel>.db.gz
# 2. Container stoppen: docker compose down
# 3. entpackte .db-Datei nach data/teddys.db kopieren (vorhandene
#    data/teddys.db* vorher zur Sicherheit umbenennen statt löschen)
# 4. evtl. vorhandene data/teddys.db-wal und data/teddys.db-shm löschen
#    (gehören zum alten Stand, das Backup ist eine vollständige Momentaufnahme)
# 5. Container wieder starten: docker compose up -d
