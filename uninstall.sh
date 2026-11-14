#!/usr/bin/env bash
# MeshLink Chat restlos entfernen (Dienst, Programmordner, Push-Abos).
set -euo pipefail

main() {
  local DEST="${MESHLINK_DIR:-/opt/meshlink-chat}"
  local UNIT="/etc/systemd/system/meshlink-chat.service"
  [ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen" >&2; exit 1; }

  echo "Das entfernt MeshLink Chat vollständig (Dienst und Ordner $DEST)."
  read -r -p "Fortfahren? (j/n) [n]: " yn || true
  [[ "${yn:-n}" =~ ^[jJyY] ]] || { echo "Abgebrochen."; exit 0; }

  # ---- systemd
  if [ -f "$UNIT" ] || systemctl list-unit-files meshlink-chat.service 2>/dev/null | grep -q meshlink-chat; then
    systemctl disable --now meshlink-chat.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    rm -rf /etc/systemd/system/meshlink-chat.service.d
    systemctl daemon-reload
    systemctl reset-failed meshlink-chat.service >/dev/null 2>&1 || true
    echo "Dienst meshlink-chat entfernt."
  fi

  # ---- Dateien (inkl. Push-Abos im systemd-StateDirectory)
  rm -rf /var/lib/meshlink-chat /var/lib/private/meshlink-chat
  rm -rf "$DEST"

  # ---- Kontrolle
  echo
  local left=0
  [ ! -e "$UNIT" ] || { echo "✘ $UNIT existiert noch"; left=1; }
  ! systemctl is-active --quiet meshlink-chat 2>/dev/null || { echo "✘ Dienst läuft noch"; left=1; }
  [ ! -e "$DEST" ] || { echo "✘ $DEST existiert noch"; left=1; }
  [ ! -e /var/lib/private/meshlink-chat ] || { echo "✘ /var/lib/private/meshlink-chat existiert noch"; left=1; }
  [ "$left" = 0 ] && echo "✔ MeshLink Chat wurde restlos entfernt."
  echo
  echo "Außerhalb noch erledigen:"
  echo "  • HTTPS-Zugang (Tunnel/Reverse-Proxy): Eintrag für MeshLink Chat löschen"
  echo "  • MeshMonitor: API-Token widerrufen"
  echo "  • Handy: App-Symbol entfernen"
  echo "  (Alte Log-Einträge im Journal verschwinden mit der normalen Rotation.)"
}

main "$@"
exit 0
