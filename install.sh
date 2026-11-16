#!/usr/bin/env bash
# MeshLink Chat – Installation und Update.
# Nutzt das vorhandene Node (>=18) und legt einen systemd-Dienst mit DynamicUser an (kein Benutzer, kein Paket).
# Alles liegt in /opt/meshlink-chat (plus Dienstdatei). Entfernen: /opt/meshlink-chat/uninstall.sh
#   ./install.sh            Neuinstallation (fragt URL, Token, Passwort, Port) oder Update mit Rückfrage
#   ./install.sh --update   Update ohne Rückfragen, .env bleibt
#   ./install.sh --check    nur Verbindungstest mit der installierten Konfiguration
# Sprache der Ausgaben: Deutsch, wenn das System auf Deutsch steht (LANG=de_…), sonst Englisch.
# Fest wählen: MESHLINK_LANG=de ./install.sh  bzw.  MESHLINK_LANG=en ./install.sh
set -euo pipefail

case "${MESHLINK_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in de*|DE*) ML=de ;; *) ML=en ;; esac
export MESHLINK_LANG="$ML"   # auch für den Verbindungstest (server.js --check)
t() { if [ "$ML" = de ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
YES="$(t j y)"

DEST="${MESHLINK_DIR:-/opt/meshlink-chat}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="/etc/systemd/system/meshlink-chat.service"

c_ok() { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ask() { local __v="$1" __q="$2" __d="${3:-}" __a; read -r -p "$__q${__d:+ [$__d]}: " __a || true; printf -v "$__v" '%s' "${__a:-$__d}"; }
# IFS= : Leerzeichen am Anfang/Ende eines Passworts bleiben erhalten
ask_secret() { local __v="$1" __q="$2" __a; IFS= read -r -s -p "$__q: " __a || { echo; c_err "$(t 'Eingabe abgebrochen.' 'Input cancelled.')"; exit 1; }; echo; printf -v "$__v" '%s' "$__a"; }
# Lauschende Ports einmal einlesen (kein "ss | grep -q": das kann mit pipefail fälschlich scheitern)
LISTEN="$(ss -tln 2>/dev/null || true)"
port_used() { grep -qE "[:.]$1[[:space:]]" <<<"$LISTEN"; }

# ------------------------------------------------------------------ Voraussetzungen & Modus
[ "$(id -u)" -eq 0 ] || { c_err "$(t 'Bitte als root ausführen' 'Please run as root')"; exit 1; }
for f in server/server.js server/push.js server/i18n.js public/index.html public/app.js public/i18n/en.json uninstall.sh; do
  [ -f "$SRC/$f" ] || { c_err "$(t 'Datei fehlt im Quellordner' 'File missing in the source folder'): $f"; exit 1; }
done

command -v systemctl >/dev/null || { c_err "$(t 'systemd nicht gefunden.' 'systemd not found.')"; exit 1; }
command -v node >/dev/null || { c_err "$(t 'Node.js nicht gefunden (mind. Version 18), z. B.: apt install nodejs' 'Node.js not found (version 18 or newer), e.g.: apt install nodejs')"; exit 1; }
NODE_BIN="$(command -v node)"
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { c_err "$(t "Node $NODE_MAJOR ist zu alt (mind. 18)." "Node $NODE_MAJOR is too old (18 or newer needed).")"; exit 1; }
case "$NODE_BIN" in /root/*|/home/*) c_err "$(t "Node liegt unter $NODE_BIN (Home-Verzeichnis) – für den Dienst ungeeignet." "Node is located at $NODE_BIN (home directory) – not usable for the service.")"; exit 1;; esac

# Nur Verbindungstest (Quelle, MeshMonitor-Version, Nachrichtenlängen) mit der installierten Konfiguration
if [ "${1:-}" = "--check" ]; then
  [ -f "$DEST/.env" ] || { c_err "$(t "Keine Installation in $DEST" "No installation in $DEST")"; exit 1; }
  ( set -a; . "$DEST/.env"; set +a; cd "$DEST" && "$NODE_BIN" server/server.js --check ); exit $?
fi

echo
echo "=== MeshLink Chat $(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$SRC/server/server.js") Installation → $DEST ==="
echo "    Node: $NODE_BIN (v$("$NODE_BIN" -v | tr -d v))"
echo

# ------------------------------------------------------------------ Umstieg vom früheren Namen „MeshChat“
# Läuft noch eine Installation unter dem alten Namen, kann ihre Konfiguration übernommen werden (Token, Passwort,
# Port, Sitzungsschlüssel); danach wird die alte Installation entfernt. Push muss auf den Geräten neu eingeschaltet werden.
OLD_DIR="/opt/meshchat"; OLD_UNIT="/etc/systemd/system/meshchat.service"
if [ "${1:-}" != "--update" ] && [ ! -f "$DEST/.env" ] && { [ -f "$OLD_UNIT" ] || [ -f "$OLD_DIR/.env" ]; }; then
  c_warn "$(t "Ältere Installation unter dem früheren Namen „MeshChat“ gefunden ($OLD_DIR)." "Older installation under the former name 'MeshChat' found ($OLD_DIR).")"
  ask MIGRATE "$(t 'Konfiguration übernehmen und die alte Installation entfernen? (j/n)' 'Take over the configuration and remove the old installation? (y/n)')" "$YES"
  if [[ "$MIGRATE" =~ ^[jJyY] ]]; then
    mkdir -p "$DEST"
    [ -f "$OLD_DIR/.env" ] && install -m 600 "$OLD_DIR/.env" "$DEST/.env"
    systemctl disable --now meshchat.service >/dev/null 2>&1 || true
    rm -f "$OLD_UNIT"; rm -rf /etc/systemd/system/meshchat.service.d
    systemctl daemon-reload; systemctl reset-failed meshchat.service >/dev/null 2>&1 || true
    rm -rf "$OLD_DIR" /var/lib/meshchat /var/lib/private/meshchat
    LISTEN="$(ss -tln 2>/dev/null || true)"
    c_ok "$(t 'Alte Installation entfernt, Konfiguration übernommen. Push auf den Geräten bitte einmal neu einschalten.' 'Old installation removed, configuration taken over. Please turn push on again once on each device.')"
    echo
  fi
fi

# ------------------------------------------------------------------ Konfiguration
KEEP_ENV=n
if [ "${1:-}" = "--update" ]; then
  [ -f "$DEST/.env" ] || { c_err "--update: $(t "keine bestehende Installation in $DEST" "no existing installation in $DEST")"; exit 1; }
  KEEP_ENV=j
elif [ -f "$DEST/.env" ]; then
  c_warn "$(t 'Bestehende Installation gefunden.' 'Existing installation found.')"
  ask KEEP_ENV "$(t 'Vorhandene Konfiguration behalten (Update)? (j/n)' 'Keep the existing configuration (update)? (y/n)')" "$YES"
fi

if [[ ! "$KEEP_ENV" =~ ^[jJyY] ]]; then
  # MeshMonitor-Port erkennen
  MM_PORT=""
  for p in 3001 8080; do if port_used "$p"; then MM_PORT=$p; break; fi; done
  DEFAULT_URL="http://127.0.0.1:${MM_PORT:-3001}"
  [ -n "${MM_PORT:-}" ] && c_ok "$(t "MeshMonitor gefunden auf Port $MM_PORT." "MeshMonitor found on port $MM_PORT.")"
  while :; do
    ask MM_URL "MeshMonitor URL" "$DEFAULT_URL"
    MM_URL="${MM_URL%/}"
    [[ "$MM_URL" =~ ^https?://[^[:space:]\']+$ ]] && break
    c_warn "$(t 'Bitte eine Adresse wie http://127.0.0.1:3001 eingeben.' 'Please enter an address like http://127.0.0.1:3001.')"
  done
  echo
  while :; do
    ask_secret MM_TOKEN "$(t 'API-Token aus MeshMonitor (Eingabe unsichtbar)' 'API token from MeshMonitor (input hidden)')"
    [ -n "$MM_TOKEN" ] || { c_warn "$(t 'Leer.' 'Empty.')"; continue; }
    [[ "$MM_TOKEN" == *"'"* ]] && { c_warn "$(t 'Ungültiges Zeichen' 'Invalid character') (')."; continue; }
    [[ "$MM_TOKEN" == mm_* ]] && break
    read -r -p "$(t 'Token beginnt nicht mit mm_. Trotzdem verwenden? (j/n) [n]: ' 'Token does not start with mm_. Use it anyway? (y/n) [n]: ')" yn || true
    [[ "${yn:-n}" =~ ^[jJyY] ]] && break
  done
  echo
  while :; do
    ask_secret APP_PASSWORD "$(t 'Neues App-Passwort für den Login (mind. 8 Zeichen)' 'New app password for the login (at least 8 characters)')"
    ask_secret APP_PASSWORD2 "$(t 'Passwort wiederholen' 'Repeat password')"
    if [ "$APP_PASSWORD" != "$APP_PASSWORD2" ]; then c_warn "$(t 'Passwörter stimmen nicht überein.' 'Passwords do not match.')"; continue; fi
    if [ "${#APP_PASSWORD}" -lt 8 ]; then c_warn "$(t 'Zu kurz.' 'Too short.')"; continue; fi
    if [[ "$APP_PASSWORD" == *"'"* ]]; then c_warn "$(t 'Bitte kein einfaches Anführungszeichen' 'Please no single quote') (')."; continue; fi
    break
  done
  echo
  t "Bind-Adresse: 0.0.0.0 = im LAN erreichbar (nötig, wenn der HTTPS-Proxy/Tunnel auf einem anderen Host läuft),
              127.0.0.1 = nur lokal (Proxy/Tunnel auf diesem Host).
" "Bind address: 0.0.0.0 = reachable in the LAN (needed if the HTTPS proxy/tunnel runs on another host),
              127.0.0.1 = local only (proxy/tunnel on this host).
"
  while :; do
    ask BIND_ADDR "$(t Bind-Adresse 'Bind address')" "0.0.0.0"
    [[ "$BIND_ADDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$BIND_ADDR" =~ ^[0-9a-fA-F:]*:[0-9a-fA-F:.]*$ ]] && break
    c_warn "$(t 'Bitte eine IP-Adresse eingeben (0.0.0.0 oder 127.0.0.1).' 'Please enter an IP address (0.0.0.0 or 127.0.0.1).')"
  done
  while :; do
    ask HOST_PORT "Port" "8090"
    if ! [[ "$HOST_PORT" =~ ^[0-9]{2,5}$ ]] || [ "$HOST_PORT" -gt 65535 ]; then c_warn "$(t 'Bitte eine Portnummer eingeben (z. B. 8090).' 'Please enter a port number (e.g. 8090).')"; continue; fi
    # Belegt? Der eigene, schon laufende Dienst zählt nicht (Neuinstallation über eine bestehende)
    if port_used "$HOST_PORT" && ! systemctl is-active --quiet meshlink-chat 2>/dev/null; then
      c_warn "$(t "Port $HOST_PORT ist schon belegt – bitte einen anderen wählen." "Port $HOST_PORT is already in use – please pick another one.")"; continue
    fi
    break
  done
  SESSION_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# ------------------------------------------------------------------ Dateien kopieren
mkdir -p "$DEST"
if [ "$(realpath "$SRC")" != "$(realpath "$DEST")" ]; then
  rm -rf "$DEST/server" "$DEST/public"
  cp -r "$SRC/server" "$SRC/public" "$DEST/"
  cp "$SRC/install.sh" "$SRC/uninstall.sh" "$DEST/"
  for f in .env.example README.md README.de.md LICENSE; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/"
  done
  rm -f "$DEST/Dockerfile" "$DEST/docker-compose.yml" "$DEST/.dockerignore"   # Altlast früherer Versionen
fi
chown -R root:root "$DEST"
chmod 755 "$DEST"
chmod -R u=rwX,go=rX "$DEST/server" "$DEST/public"
chmod 755 "$DEST/install.sh" "$DEST/uninstall.sh"
rm -f "$DEST/remote.sh"   # Altlast des früheren SSH-Deploy-Zugangs
rm -f "$DEST/.mode" "$DEST/.base-image"   # Altlast früherer Versionen

if [[ ! "$KEEP_ENV" =~ ^[jJyY] ]]; then
  ( umask 077
    cat > "$DEST/.env" <<EOF
# $(t 'Erzeugt von install.sh am' 'Created by install.sh on') $(date -Iseconds)
MM_URL='$MM_URL'
MM_TOKEN='$MM_TOKEN'
MM_SOURCE=''
MY_NODE_ID=''
APP_PASSWORD='$APP_PASSWORD'
SESSION_SECRET='$SESSION_SECRET'
SESSION_DAYS=30
POLL_MS=3000
IDLE_POLL_MS=15000
# $(t 'Repeater-Verwaltung (Admin-Login, Befehle, Neustart) über MeshMonitor: 1 = an. Token braucht remote_admin lesen + schreiben.' 'Repeater admin (admin login, commands, reboot) through MeshMonitor: 1 = on. Token needs remote_admin read + write.')
REMOTE_ADMIN=0
# $(t 'Adresse und Port, auf denen MeshLink Chat lauscht' 'Address and port MeshLink Chat listens on')
BIND_ADDR='$BIND_ADDR'
HOST_PORT=$HOST_PORT
EOF
  )
fi
chmod 600 "$DEST/.env"

envget() { { grep -E "^$1=" "$DEST/.env" || true; } | tail -n1 | cut -d= -f2- | tr -d "'\""; }

# ------------------------------------------------------------------ Verbindungstest
echo
echo "→ $(t 'Teste Verbindung zu MeshMonitor …' 'Testing connection to MeshMonitor …')"
CHECK_OK=1
( set -a; . "$DEST/.env"; set +a; cd "$DEST" && "$NODE_BIN" server/server.js --check ) || CHECK_OK=0

# ------------------------------------------------------------------ Starten
cat > "$UNIT" <<EOF
# Angelegt von MeshLink Chat install.sh – entfernen mit $DEST/uninstall.sh
[Unit]
Description=MeshLink Chat (PWA chat for MeshMonitor)
After=network-online.target meshmonitor.service
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=$DEST
EnvironmentFile=$DEST/.env
Environment=NODE_ENV=production
# Einziger Schreibort: Push-Abos (max. 10 Einträge) unter /var/lib/private/meshlink-chat
StateDirectory=meshlink-chat
StateDirectoryMode=0700
ExecStart=$NODE_BIN $DEST/server/server.js
Restart=on-failure
RestartSec=5
MemoryMax=192M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable meshlink-chat.service >/dev/null 2>&1
systemctl restart meshlink-chat.service
sleep 2
if systemctl is-active --quiet meshlink-chat; then c_ok "$(t 'Dienst meshlink-chat läuft.' 'Service meshlink-chat is running.')"; else
  c_err "$(t 'Dienst startet nicht. Log:' 'Service does not start. Log:')"; journalctl -u meshlink-chat -n 30 --no-pager; exit 1; fi

# PORT/HOST haben Vorrang (ältere .env), sonst HOST_PORT/BIND_ADDR
HP="$(envget HOST_PORT)"; BA="$(envget BIND_ADDR)"
P2="$(envget PORT)"; H2="$(envget HOST)"
HP="${P2:-$HP}"; BA="${H2:-$BA}"
HP="${HP:-8090}"; BA="${BA:-0.0.0.0}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
c_ok "=== $(t 'MeshLink Chat ist installiert' 'MeshLink Chat is installed') ==="
echo
if [[ "$BA" == 127.* || "$BA" == "::1" ]]; then echo "$(t 'Erreichbar (nur lokal):' 'Reachable (local only): ') http://127.0.0.1:$HP"
else echo "$(t 'Im LAN erreichbar:     ' 'Reachable in the LAN:  ') http://${IP:-<LXC-IP>}:$HP"; fi
echo "Status / Logs:          systemctl status meshlink-chat   |   journalctl -u meshlink-chat -f"
echo "$(t 'Konfiguration ändern:  ' 'Change configuration:  ') nano $DEST/.env   →   $DEST/install.sh --update"
echo "$(t 'Entfernen:             ' 'Remove:                ') $DEST/uninstall.sh"
if [ "$CHECK_OK" != 1 ]; then
  echo
  c_warn "$(t 'Verbindungstest fehlgeschlagen – App läuft, sieht aber noch keine Daten.' 'Connection test failed – the app is running but sees no data yet.')"
  c_warn "$(t 'Werte prüfen:' 'Check the values:') nano $DEST/.env  →  $(t danach then): $DEST/install.sh --update"
  exit 2
fi
