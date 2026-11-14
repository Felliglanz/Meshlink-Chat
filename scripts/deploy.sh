#!/usr/bin/env bash
# MeshLink Chat vom PC aus auf den Server/LXC bringen – per SSH mit deinem eigenen Schlüssel.
#   scripts/deploy.sh           → Update: Code übertragen und install.sh --update ausführen (.env bleibt)
#   scripts/deploy.sh install   → Neuinstallation: Code übertragen, install.sh fragt URL/Token/Passwort ab
#   scripts/deploy.sh check     → Verbindungstest MeshLink Chat → MeshMonitor auf dem LXC
#   scripts/deploy.sh uninstall → MeshLink Chat restlos vom LXC entfernen (fragt vorher nach)
#   scripts/deploy.sh logs      → letzte Log-Zeilen
#   scripts/deploy.sh status    → Dienststatus
# Fragt je SSH-Verbindung nach der Passphrase des Schlüssels (install: zweimal).
#
# Ziel und Schlüssel stehen in .deploy.env im Projektordner (wird nie eingecheckt), z. B.:
#   MESHLINK_HOST=root@192.168.1.50
#   MESHLINK_KEY=~/.ssh/id_ed25519
# oder einmalig: MESHLINK_HOST=root@1.2.3.4 scripts/deploy.sh
set -euo pipefail

case "${MESHLINK_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in de*|DE*) ML=de ;; *) ML=en ;; esac
export MESHLINK_LANG="$ML"
t() { if [ "$ML" = de ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f .deploy.env ] && { set -a; . ./.deploy.env; set +a; }
HOST="${MESHLINK_HOST:-}"
[ -n "$HOST" ] || { echo "$(t 'Kein Ziel: MESHLINK_HOST in .deploy.env setzen (z. B. MESHLINK_HOST=root@192.168.1.50).' 'No target: set MESHLINK_HOST in .deploy.env (e.g. MESHLINK_HOST=root@192.168.1.50).')" >&2; exit 1; }
KEY="${MESHLINK_KEY:-}"
KEY="${KEY/#\~/$HOME}"
DEST="${MESHLINK_DIR:-/opt/meshlink-chat}"
SSH=(ssh -o ConnectTimeout=10)
[ -n "$KEY" ] && SSH+=(-i "$KEY" -o IdentitiesOnly=yes)

# Vor jeder Übertragung: Syntax und Sprachdateien prüfen (bricht ab, bevor irgendetwas auf den LXC geht)
precheck() {
  for f in server/*.js public/app.js public/sw.js; do node --check "$f"; done
  node scripts/check-i18n.js >/dev/null || { node scripts/check-i18n.js; exit 1; }
  bash -n install.sh && bash -n uninstall.sh
}
# Quelltext als tar auf die Standardausgabe schreiben
pack() {
  local files=(server public install.sh uninstall.sh)
  for f in README.md README.de.md .env.example LICENSE; do [ -f "$f" ] && files+=("$f"); done
  tar czf - --exclude='.env' "${files[@]}"
}

case "${1:-deploy}" in
  deploy)
    precheck
    echo "→ $(t 'übertrage nach' 'uploading to') $HOST …"
    pack | "${SSH[@]}" "$HOST" \
      'set -e; T=$(mktemp -d /tmp/meshlink-src.XXXXXX); trap "rm -rf $T" EXIT; tar xzf - -C "$T"; MESHLINK_LANG="'"$ML"'" MESHLINK_DIR="'"$DEST"'" "$T/install.sh" --update'
    ;;
  install)
    precheck
    echo "→ $(t 'übertrage nach' 'uploading to') $HOST …"
    T="$(pack | "${SSH[@]}" "$HOST" 'set -e; T=$(mktemp -d /tmp/meshlink-src.XXXXXX); tar xzf - -C "$T"; echo "$T"')"
    [[ "$T" == /tmp/meshlink-src.* ]] || { echo "$(t 'Übertragung fehlgeschlagen.' 'Upload failed.')" >&2; exit 1; }
    # -t: eigenes Terminal, damit install.sh Fragen stellen kann; Quellordner danach wieder weg
    "${SSH[@]}" -t "$HOST" "MESHLINK_LANG='$ML' MESHLINK_DIR='$DEST' '$T/install.sh'; rc=\$?; rm -rf '$T'; exit \$rc"
    ;;
  check)
    "${SSH[@]}" "$HOST" "export MESHLINK_LANG='$ML'; N=\$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' /etc/systemd/system/meshlink-chat.service); cd '$DEST' && set -a && . ./.env && set +a && \"\${N:-node}\" server/server.js --check"
    ;;
  uninstall)
    # -t: uninstall.sh fragt "Fortfahren? (j/n)" – die Antwort gibst du hier im Terminal
    "${SSH[@]}" -t "$HOST" "if [ -x '$DEST/uninstall.sh' ]; then MESHLINK_LANG='$ML' '$DEST/uninstall.sh'; else echo '$(t "Keine Installation in $DEST gefunden." "No installation found in $DEST.")'; fi"
    ;;
  logs)   "${SSH[@]}" "$HOST" 'journalctl -u meshlink-chat -n 60 --no-pager' ;;
  status) "${SSH[@]}" "$HOST" 'systemctl status meshlink-chat --no-pager | head -n 15' ;;
  *) echo "$(t Unbekannt Unknown): $1 (deploy|install|uninstall|check|logs|status)" >&2; exit 1 ;;
esac
