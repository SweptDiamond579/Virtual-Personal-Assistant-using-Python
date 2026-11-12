#!/usr/bin/env bash
# Nightly logical backup of the JARVIS database (memories, history, audit log).
# Usage: DATABASE_DSN=postgresql://jarvis:...@127.0.0.1/jarvis ./backup.sh /var/backups/jarvis
set -euo pipefail
dest="${1:?backup directory required}"
mkdir -p "$dest"
umask 077
pg_dump --format=custom --no-owner "${DATABASE_DSN:?set DATABASE_DSN}" > "$dest/jarvis-$(date -u +%Y%m%dT%H%M%SZ).dump"
find "$dest" -name 'jarvis-*.dump' -mtime +14 -delete
