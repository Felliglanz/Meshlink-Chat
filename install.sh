#!/usr/bin/env bash
# MeshLink Chat – Installation und Update.
# Nutzt das vorhandene Node (>=18) und legt einen systemd-Dienst mit DynamicUser an (kein Benutzer, kein Paket).
# Alles liegt in /opt/meshlink-chat (plus Dienstdatei). Entfernen: /opt/meshlink-chat/uninstall.sh
#   ./install.sh            Neuinstallation (fragt URL, Token, Passwort, Port) oder Update mit Rückfrage
#   ./install.sh --update   Update ohne Rückfragen, .env bleibt
#   ./install.sh --check    nur Verbindungstest mit der installierten Konfiguration
set -euo pipefail

DEST="${MESHLINK_DIR:-/opt/meshlink-chat}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="/etc/systemd/system/meshlink-chat.service"

c_ok() { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
ask() { local __v="$1" __q="$2" __d="${3:-}" __a; read -r -p "$__q${__d:+ [$__d]}: " __a || true; printf -v "$__v" '%s' "${__a:-$__d}"; }
# IFS= : Leerzeichen am Anfang/Ende eines Passworts bleiben erhalten
ask_secret() { local __v="$1" __q="$2" __a; IFS= read -r -s -p "$__q: " __a || { echo; c_err "Eingabe abgebrochen."; exit 1; }; echo; printf -v "$__v" '%s' "$__a"; }
# Lauschende Ports einmal einlesen (kein "ss | grep -q": das kann mit pipefail fälschlich scheitern)
LISTEN="$(ss -tln 2>/dev/null || true)"
port_used() { grep -qE "[:.]$1[[:space:]]" <<<"$LISTEN"; }

# ------------------------------------------------------------------ Voraussetzungen & Modus
[ "$(id -u)" -eq 0 ] || { c_err "Bitte als root ausführen"; exit 1; }
for f in server/server.js server/push.js public/index.html public/app.js uninstall.sh; do
  [ -f "$SRC/$f" ] || { c_err "Datei fehlt im Quellordner: $f"; exit 1; }
done

command -v systemctl >/dev/null || { c_err "systemd nicht gefunden."; exit 1; }
command -v node >/dev/null || { c_err "Node.js nicht gefunden (mind. Version 18), z. B.: apt install nodejs"; exit 1; }
NODE_BIN="$(command -v node)"
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { c_err "Node $NODE_MAJOR ist zu alt (mind. 18)."; exit 1; }
case "$NODE_BIN" in /root/*|/home/*) c_err "Node liegt unter $NODE_BIN (Home-Verzeichnis) – für den Dienst ungeeignet."; exit 1;; esac

# Nur Verbindungstest (Quelle, MeshMonitor-Version, Nachrichtenlängen) mit der installierten Konfiguration
if [ "${1:-}" = "--check" ]; then
  [ -f "$DEST/.env" ] || { c_err "Keine Installation in $DEST"; exit 1; }
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
  c_warn "Ältere Installation unter dem früheren Namen „MeshChat“ gefunden ($OLD_DIR)."
  ask MIGRATE "Konfiguration übernehmen und die alte Installation entfernen? (j/n)" "j"
  if [[ "$MIGRATE" =~ ^[jJyY] ]]; then
    mkdir -p "$DEST"
    [ -f "$OLD_DIR/.env" ] && install -m 600 "$OLD_DIR/.env" "$DEST/.env"
    systemctl disable --now meshchat.service >/dev/null 2>&1 || true
    rm -f "$OLD_UNIT"; rm -rf /etc/systemd/system/meshchat.service.d
    systemctl daemon-reload; systemctl reset-failed meshchat.service >/dev/null 2>&1 || true
    rm -rf "$OLD_DIR" /var/lib/meshchat /var/lib/private/meshchat
    LISTEN="$(ss -tln 2>/dev/null || true)"
    c_ok "Alte Installation entfernt, Konfiguration übernommen. Push auf den Geräten bitte einmal neu einschalten."
    echo
  fi
fi

# ------------------------------------------------------------------ Konfiguration
KEEP_ENV=n
if [ "${1:-}" = "--update" ]; then
  [ -f "$DEST/.env" ] || { c_err "--update: keine bestehende Installation in $DEST"; exit 1; }
  KEEP_ENV=j
elif [ -f "$DEST/.env" ]; then
  c_warn "Bestehende Installation gefunden."
  ask KEEP_ENV "Vorhandene Konfiguration behalten (Update)? (j/n)" "j"
fi

if [[ ! "$KEEP_ENV" =~ ^[jJyY] ]]; then
  # MeshMonitor-Port erkennen
  MM_PORT=""
  for p in 3001 8080; do if port_used "$p"; then MM_PORT=$p; break; fi; done
  DEFAULT_URL="http://127.0.0.1:${MM_PORT:-3001}"
  [ -n "${MM_PORT:-}" ] && c_ok "MeshMonitor gefunden auf Port $MM_PORT."
  while :; do
    ask MM_URL "MeshMonitor URL" "$DEFAULT_URL"
    MM_URL="${MM_URL%/}"
    [[ "$MM_URL" =~ ^https?://[^[:space:]\']+$ ]] && break
    c_warn "Bitte eine Adresse wie http://127.0.0.1:3001 eingeben."
  done
  echo
  while :; do
    ask_secret MM_TOKEN "API-Token aus MeshMonitor (Eingabe unsichtbar)"
    [ -n "$MM_TOKEN" ] || { c_warn "Leer."; continue; }
    [[ "$MM_TOKEN" == *"'"* ]] && { c_warn "Ungültiges Zeichen (')."; continue; }
    [[ "$MM_TOKEN" == mm_* ]] && break
    read -r -p "Token beginnt nicht mit mm_. Trotzdem verwenden? (j/n) [n]: " yn || true
    [[ "${yn:-n}" =~ ^[jJyY] ]] && break
  done
  echo
  while :; do
    ask_secret APP_PASSWORD "Neues App-Passwort für den Login (mind. 8 Zeichen)"
    ask_secret APP_PASSWORD2 "Passwort wiederholen"
    if [ "$APP_PASSWORD" != "$APP_PASSWORD2" ]; then c_warn "Passwörter stimmen nicht überein."; continue; fi
    if [ "${#APP_PASSWORD}" -lt 8 ]; then c_warn "Zu kurz."; continue; fi
    if [[ "$APP_PASSWORD" == *"'"* ]]; then c_warn "Bitte kein einfaches Anführungszeichen (')."; continue; fi
    break
  done
  echo
  echo "Bind-Adresse: 0.0.0.0 = im LAN erreichbar (nötig, wenn der HTTPS-Proxy/Tunnel auf einem anderen Host läuft),"
  echo "              127.0.0.1 = nur lokal (Proxy/Tunnel auf diesem Host)."
  while :; do
    ask BIND_ADDR "Bind-Adresse" "0.0.0.0"
    [[ "$BIND_ADDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$BIND_ADDR" =~ ^[0-9a-fA-F:]*:[0-9a-fA-F:.]*$ ]] && break
    c_warn "Bitte eine IP-Adresse eingeben (0.0.0.0 oder 127.0.0.1)."
  done
  while :; do
    ask HOST_PORT "Port" "8090"
    if ! [[ "$HOST_PORT" =~ ^[0-9]{2,5}$ ]] || [ "$HOST_PORT" -gt 65535 ]; then c_warn "Bitte eine Portnummer eingeben (z. B. 8090)."; continue; fi
    # Belegt? Der eigene, schon laufende Dienst zählt nicht (Neuinstallation über eine bestehende)
    if port_used "$HOST_PORT" && ! systemctl is-active --quiet meshlink-chat 2>/dev/null; then
      c_warn "Port $HOST_PORT ist schon belegt – bitte einen anderen wählen."; continue
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
  for f in .env.example README.md LICENSE; do
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
# Erzeugt von install.sh am $(date -Iseconds)
MM_URL='$MM_URL'
MM_TOKEN='$MM_TOKEN'
MM_SOURCE=''
MY_NODE_ID=''
APP_PASSWORD='$APP_PASSWORD'
SESSION_SECRET='$SESSION_SECRET'
SESSION_DAYS=30
POLL_MS=3000
IDLE_POLL_MS=15000
# Adresse und Port, auf denen MeshLink Chat lauscht
BIND_ADDR='$BIND_ADDR'
HOST_PORT=$HOST_PORT
EOF
  )
fi
chmod 600 "$DEST/.env"

envget() { { grep -E "^$1=" "$DEST/.env" || true; } | tail -n1 | cut -d= -f2- | tr -d "'\""; }

# ------------------------------------------------------------------ Verbindungstest
echo
echo "→ Teste Verbindung zu MeshMonitor …"
CHECK_OK=1
( set -a; . "$DEST/.env"; set +a; cd "$DEST" && "$NODE_BIN" server/server.js --check ) || CHECK_OK=0

# ------------------------------------------------------------------ Starten
cat > "$UNIT" <<EOF
# Angelegt von MeshLink Chat install.sh – entfernen mit $DEST/uninstall.sh
[Unit]
Description=MeshLink Chat (PWA-Chat für MeshMonitor)
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
if systemctl is-active --quiet meshlink-chat; then c_ok "Dienst meshlink-chat läuft."; else
  c_err "Dienst startet nicht. Log:"; journalctl -u meshlink-chat -n 30 --no-pager; exit 1; fi

# PORT/HOST haben Vorrang (ältere .env), sonst HOST_PORT/BIND_ADDR
HP="$(envget HOST_PORT)"; BA="$(envget BIND_ADDR)"
P2="$(envget PORT)"; H2="$(envget HOST)"
HP="${P2:-$HP}"; BA="${H2:-$BA}"
HP="${HP:-8090}"; BA="${BA:-0.0.0.0}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
c_ok "=== MeshLink Chat ist installiert ==="
echo
if [[ "$BA" == 127.* || "$BA" == "::1" ]]; then echo "Erreichbar (nur lokal): http://127.0.0.1:$HP"
else echo "Im LAN erreichbar:      http://${IP:-<LXC-IP>}:$HP"; fi
echo "Status / Logs:          systemctl status meshlink-chat   |   journalctl -u meshlink-chat -f"
echo "Konfiguration ändern:   nano $DEST/.env   →   $DEST/install.sh --update"
echo "Entfernen:              $DEST/uninstall.sh"
if [ "$CHECK_OK" != 1 ]; then
  echo
  c_warn "Verbindungstest fehlgeschlagen – App läuft, sieht aber noch keine Daten."
  c_warn "Werte prüfen: nano $DEST/.env  →  danach: $DEST/install.sh --update"
  exit 2
fi
