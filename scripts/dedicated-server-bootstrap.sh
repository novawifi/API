#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

NOVA_LOG_DIR="${NOVA_LOG_DIR:-/var/log/nova}"
NOVA_SETUP_LOG="${NOVA_SETUP_LOG:-$NOVA_LOG_DIR/dedicated-bootstrap.log}"
NOVA_MARKER_DIR="${NOVA_MARKER_DIR:-/opt/nova}"
NOVA_HEALTH_DIR="${NOVA_HEALTH_DIR:-/var/www/nova-health}"
NOVA_USER="${NOVA_USER:-nova}"
NOVA_SSH_PORT="${NOVA_SSH_PORT:-22}"
NOVA_TIMEZONE="${NOVA_TIMEZONE:-Africa/Nairobi}"
NOVA_NODE_MAJOR="${NOVA_NODE_MAJOR:-24}"
NOVA_APP_ROOT="${NOVA_APP_ROOT:-/srv/nova}"

mkdir -p "$NOVA_LOG_DIR" "$NOVA_MARKER_DIR"
touch "$NOVA_SETUP_LOG"
chmod 0640 "$NOVA_SETUP_LOG"
exec > >(tee -a "$NOVA_SETUP_LOG") 2>&1

trap 'echo "[nova-bootstrap] failed at line $LINENO"; mark_status failed' ERR

mark_status() {
  local status="$1"
  local now
  now="$(date -Is)"
  cat > "$NOVA_MARKER_DIR/dedicated-setup-status.json" <<JSON
{"status":"$status","updatedAt":"$now","log":"$NOVA_SETUP_LOG"}
JSON
}

log() {
  echo "[nova-bootstrap] $(date -Is) $*"
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
  fi
}

apt_install() {
  apt-get install -y --no-install-recommends "$@"
}

configure_timezone() {
  timedatectl set-timezone "$NOVA_TIMEZONE" || true
}

configure_packages() {
  log "Updating apt package index"
  apt-get update -y
  apt_install ca-certificates curl gnupg lsb-release apt-transport-https software-properties-common
  apt_install ufw fail2ban unattended-upgrades logrotate jq git rsync unzip tar gzip
  apt_install nginx certbot python3-certbot-nginx
  apt_install postgresql postgresql-contrib redis-server
  apt_install build-essential python3 make g++ openssl
}

configure_node() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$current_major" = "$NOVA_NODE_MAJOR" ]; then
      log "Node.js v$NOVA_NODE_MAJOR already installed"
      return
    fi
  fi

  log "Installing Node.js $NOVA_NODE_MAJOR"
  mkdir -p /etc/apt/keyrings
  rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NOVA_NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt_install nodejs
  corepack enable || true
  npm install -g pm2
}

configure_users_and_dirs() {
  if ! id "$NOVA_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$NOVA_USER"
  fi

  mkdir -p "$NOVA_APP_ROOT" "$NOVA_HEALTH_DIR" /etc/nova
  chown -R "$NOVA_USER:$NOVA_USER" "$NOVA_APP_ROOT"
  chmod 0750 "$NOVA_APP_ROOT"

  cat > /etc/nova/dedicated.env <<EOF
NOVA_APP_ROOT=$NOVA_APP_ROOT
NOVA_USER=$NOVA_USER
NOVA_HEALTH_DIR=$NOVA_HEALTH_DIR
EOF
  chmod 0640 /etc/nova/dedicated.env
}

configure_firewall() {
  log "Configuring UFW"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow "$NOVA_SSH_PORT/tcp"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 1812/udp
  ufw allow 1813/udp
  ufw --force enable
}

configure_fail2ban() {
  cat > /etc/fail2ban/jail.d/nova-sshd.conf <<EOF
[sshd]
enabled = true
port = $NOVA_SSH_PORT
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban
}

configure_services() {
  systemctl enable --now nginx
  systemctl enable --now postgresql
  systemctl enable --now redis-server || true
  systemctl enable --now unattended-upgrades || true
}

configure_nginx_health() {
  local hostname
  hostname="$(hostname -f 2>/dev/null || hostname)"
  cat > "$NOVA_HEALTH_DIR/index.html" <<EOF
Nova dedicated server is ready.
Host: $hostname
Updated: $(date -Is)
EOF

  cat > /etc/nginx/sites-available/nova-health.conf <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root $NOVA_HEALTH_DIR;
    index index.html;

    location /health {
        access_log off;
        add_header Content-Type text/plain;
        return 200 'ok\n';
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF

  rm -f /etc/nginx/sites-enabled/default
  ln -sf /etc/nginx/sites-available/nova-health.conf /etc/nginx/sites-enabled/nova-health.conf
  nginx -t
  systemctl reload nginx
}

configure_postgres() {
  local pg_hba
  pg_hba="$(find /etc/postgresql -path '*/main/pg_hba.conf' | head -n 1 || true)"
  if [ -n "$pg_hba" ]; then
    cp "$pg_hba" "$pg_hba.nova.bak.$(date +%s)"
  fi
}

configure_swap() {
  if swapon --show | grep -q .; then
    return
  fi
  local mem_mb swap_mb
  mem_mb="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
  swap_mb=2048
  if [ "$mem_mb" -lt 2048 ]; then
    swap_mb=1024
  fi
  if [ ! -f /swapfile ]; then
    fallocate -l "${swap_mb}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb"
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

write_verify_script() {
  cat > /usr/local/sbin/nova-dedicated-check <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
fail=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok $name"
  else
    echo "fail $name"
    fail=1
  fi
}

check nginx systemctl is-active --quiet nginx
check postgresql systemctl is-active --quiet postgresql
check firewall ufw status
check node node --version
check pm2 pm2 --version
check health curl -fsS http://127.0.0.1/health

if [ -f /opt/nova/dedicated-setup-status.json ]; then
  cat /opt/nova/dedicated-setup-status.json
fi

exit "$fail"
EOF
  chmod 0755 /usr/local/sbin/nova-dedicated-check
}

main() {
  need_root
  mark_status running
  log "Starting Nova dedicated server bootstrap"
  configure_timezone
  configure_packages
  configure_node
  configure_users_and_dirs
  configure_swap
  configure_firewall
  configure_fail2ban
  configure_services
  configure_nginx_health
  configure_postgres
  write_verify_script
  nova-dedicated-check
  mark_status complete
  log "Nova dedicated server bootstrap complete"
}

main "$@"
