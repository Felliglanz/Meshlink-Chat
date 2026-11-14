#!/usr/bin/env bash
# MeshLink Chat restlos entfernen (Dienst, Programmordner, Push-Abos).
# Sprache der Ausgaben wie bei install.sh: Deutsch bei deutscher Systemsprache, sonst Englisch (MESHLINK_LANG=de|en).
set -euo pipefail

case "${MESHLINK_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in de*|DE*) ML=de ;; *) ML=en ;; esac
t() { if [ "$ML" = de ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

main() {
  local DEST="${MESHLINK_DIR:-/opt/meshlink-chat}"
  local UNIT="/etc/systemd/system/meshlink-chat.service"
  [ "$(id -u)" -eq 0 ] || { t 'Bitte als root ausführen' 'Please run as root' >&2; echo >&2; exit 1; }

  t "Das entfernt MeshLink Chat vollständig (Dienst und Ordner $DEST)." "This removes MeshLink Chat completely (service and folder $DEST)."; echo
  read -r -p "$(t 'Fortfahren? (j/n) [n]: ' 'Continue? (y/n) [n]: ')" yn || true
  [[ "${yn:-n}" =~ ^[jJyY] ]] || { t 'Abgebrochen.' 'Cancelled.'; echo; exit 0; }

  # ---- systemd
  if [ -f "$UNIT" ] || systemctl list-unit-files meshlink-chat.service 2>/dev/null | grep -q meshlink-chat; then
    systemctl disable --now meshlink-chat.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    rm -rf /etc/systemd/system/meshlink-chat.service.d
    systemctl daemon-reload
    systemctl reset-failed meshlink-chat.service >/dev/null 2>&1 || true
    t 'Dienst meshlink-chat entfernt.' 'Service meshlink-chat removed.'; echo
  fi

  # ---- Dateien (inkl. Push-Abos im systemd-StateDirectory)
  rm -rf /var/lib/meshlink-chat /var/lib/private/meshlink-chat
  rm -rf "$DEST"

  # ---- Kontrolle
  echo
  local left=0 still
  still="$(t 'existiert noch' 'still exists')"
  [ ! -e "$UNIT" ] || { echo "✘ $UNIT $still"; left=1; }
  ! systemctl is-active --quiet meshlink-chat 2>/dev/null || { echo "✘ $(t 'Dienst läuft noch' 'Service is still running')"; left=1; }
  [ ! -e "$DEST" ] || { echo "✘ $DEST $still"; left=1; }
  [ ! -e /var/lib/private/meshlink-chat ] || { echo "✘ /var/lib/private/meshlink-chat $still"; left=1; }
  [ "$left" = 0 ] && echo "✔ $(t 'MeshLink Chat wurde restlos entfernt.' 'MeshLink Chat has been removed completely.')"
  echo
  if [ "$ML" = de ]; then
    echo "Außerhalb noch erledigen:"
    echo "  • HTTPS-Zugang (Tunnel/Reverse-Proxy): Eintrag für MeshLink Chat löschen"
    echo "  • MeshMonitor: API-Token widerrufen"
    echo "  • Handy: App-Symbol entfernen"
    echo "  (Alte Log-Einträge im Journal verschwinden mit der normalen Rotation.)"
  else
    echo "Still to do elsewhere:"
    echo "  • HTTPS access (tunnel/reverse proxy): delete the entry for MeshLink Chat"
    echo "  • MeshMonitor: revoke the API token"
    echo "  • Phone: remove the app icon"
    echo "  (Old journal log entries disappear with the normal rotation.)"
  fi
}

main "$@"
exit 0
