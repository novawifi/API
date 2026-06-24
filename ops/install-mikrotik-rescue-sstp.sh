#!/usr/bin/env bash
set -Eeuo pipefail

ACCEL_VERSION="1.14.0"
APP_DIR="${APP_DIR:-/home/kyan/apps/nova-server}"
RESCUE_HOST="${RESCUE_HOST:-api.novawifi.co.ke}"
RESCUE_PORT="${RESCUE_PORT:-4443}"
RESCUE_PREFIX="${RESCUE_PREFIX:-10.250.0}"
RESCUE_CERT_DIR="${RESCUE_CERT_DIR:-/etc/nova}"
RESCUE_CERT_PATH="${RESCUE_CERT_PATH:-${RESCUE_CERT_DIR}/sstp-rescue-rsa.crt}"
RESCUE_KEY_PATH="${RESCUE_KEY_PATH:-${RESCUE_CERT_DIR}/sstp-rescue-rsa.key}"
SOURCE_DIR="/usr/local/src/accel-ppp-${ACCEL_VERSION}"
BUILD_DIR="${SOURCE_DIR}/build"
CONFIG_FILE="/etc/accel-ppp.conf"
SECRETS_FILE="/etc/ppp/nova-rescue-secrets"
PASSWORD_FILE="/etc/nova/mikrotik-rescue-password"
SERVICE_FILE="/etc/systemd/system/accel-ppp-rescue.service"

if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this installer as root." >&2
    exit 1
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
    echo "Nova production environment file not found: ${APP_DIR}/.env" >&2
    exit 1
fi

install -d -m 0750 /etc/nova /etc/ppp /var/log/accel-ppp /usr/local/src
if [[ ! -s "${PASSWORD_FILE}" ]]; then
    umask 077
    openssl rand -base64 36 | tr -d '\n' > "${PASSWORD_FILE}"
fi
chmod 0600 "${PASSWORD_FILE}"
RESCUE_PASSWORD="$(cat "${PASSWORD_FILE}")"

install -d -m 0750 "${RESCUE_CERT_DIR}"
if [[ ! -r "${RESCUE_CERT_PATH}" || ! -r "${RESCUE_KEY_PATH}" ]]; then
    umask 077
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
        -subj "/CN=${RESCUE_HOST}" \
        -keyout "${RESCUE_KEY_PATH}" \
        -out "${RESCUE_CERT_PATH}"
fi
chmod 0644 "${RESCUE_CERT_PATH}"
chmod 0600 "${RESCUE_KEY_PATH}"
modprobe ppp_mppe || true
echo ppp_mppe > /etc/modules-load.d/nova-rescue-ppp.conf

if ! command -v accel-pppd >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y --no-install-recommends build-essential cmake git libpcre2-dev libssl-dev ca-certificates
    rm -rf "${SOURCE_DIR}"
    git clone --depth 1 --branch "${ACCEL_VERSION}" https://github.com/accel-ppp/accel-ppp.git "${SOURCE_DIR}"
    install -d "${BUILD_DIR}"
    (
        cd "${BUILD_DIR}"
        cmake \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_INSTALL_PREFIX=/usr \
            -DBUILD_PPTP_DRIVER=FALSE \
            -DBUILD_IPOE_DRIVER=FALSE \
            -DBUILD_VLAN_MON_DRIVER=FALSE \
            -DRADIUS=FALSE \
            -DSHAPER=FALSE \
            -DLUA=FALSE \
            ..
        nice -n 19 make -j1
        make install
    )
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
[[ -f "${CONFIG_FILE}" ]] && cp -a "${CONFIG_FILE}" "${CONFIG_FILE}.backup-${timestamp}"
[[ -f "${SECRETS_FILE}" ]] && cp -a "${SECRETS_FILE}" "${SECRETS_FILE}.backup-${timestamp}"

umask 077
{
    echo "# client server secret ip-address"
    for router_id in $(seq 2 254); do
        printf 'nova-rescue-%s * "%s" %s.%s\n' "${router_id}" "${RESCUE_PASSWORD}" "${RESCUE_PREFIX}" "${router_id}"
    done
} > "${SECRETS_FILE}"
chmod 0600 "${SECRETS_FILE}"

cat > "${CONFIG_FILE}" <<EOF
[modules]
log_file
connlimit
chap-secrets
sstp
auth_mschap_v2

[core]
log-error=/var/log/accel-ppp/core.log
thread-count=2

[common]
single-session=replace
max-sessions=300

[ppp]
verbose=0
min-mtu=1280
mtu=1452
mru=1452
ipv4=require
mppe=require
ipv6=deny
lcp-echo-interval=20
lcp-echo-timeout=60
unit-cache=32

[auth]
timeout=10
max-failure=5

[chap-secrets]
chap-secrets=${SECRETS_FILE}
gw-ip-address=${RESCUE_PREFIX}.1

[sstp]
verbose=1
bind=0.0.0.0
port=${RESCUE_PORT}
accept=ssl
ssl-protocol=tls1.2,tls1.3
ssl-ciphers=AES256-SHA:@SECLEVEL=0
ssl-prefer-server-ciphers=0
ssl-pemfile=${RESCUE_CERT_PATH}
ssl-keyfile=${RESCUE_KEY_PATH}
http-error=deny
timeout=30
hello-interval=30
ifname=sstp%d

[connlimit]
limit=20/min
burst=10
timeout=60

[client-ip-range]
0.0.0.0/0

[log]
log-file=/var/log/accel-ppp/accel-ppp.log
log-emerg=/var/log/accel-ppp/emerg.log
log-fail-file=/var/log/accel-ppp/auth-fail.log
copy=1
level=4
EOF
chmod 0600 "${CONFIG_FILE}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Nova MikroTik SSTP rescue server
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/sbin/accel-pppd -d -p /run/accel-ppp-rescue.pid -c ${CONFIG_FILE}
PIDFile=/run/accel-ppp-rescue.pid
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

env_tmp="$(mktemp)"
grep -Ev '^MIKROTIK_RESCUE_(SSTP_ENABLED|SSTP_SERVER|SSTP_PORT|SSTP_USERNAME_TEMPLATE|SSTP_PASSWORD|ADDRESS_PREFIX)=' "${APP_DIR}/.env" > "${env_tmp}"
cat >> "${env_tmp}" <<EOF
MIKROTIK_RESCUE_SSTP_ENABLED="true"
MIKROTIK_RESCUE_SSTP_SERVER="${RESCUE_HOST}"
MIKROTIK_RESCUE_SSTP_PORT="${RESCUE_PORT}"
MIKROTIK_RESCUE_SSTP_USERNAME_TEMPLATE="nova-rescue-{router_id}"
MIKROTIK_RESCUE_SSTP_PASSWORD="${RESCUE_PASSWORD}"
MIKROTIK_RESCUE_ADDRESS_PREFIX="${RESCUE_PREFIX}"
EOF
chown --reference="${APP_DIR}/.env" "${env_tmp}"
chmod --reference="${APP_DIR}/.env" "${env_tmp}"
mv "${env_tmp}" "${APP_DIR}/.env"

systemctl daemon-reload
systemctl enable accel-ppp-rescue.service
systemctl restart accel-ppp-rescue.service
ufw allow "${RESCUE_PORT}/tcp" comment 'Nova MikroTik SSTP rescue'

systemctl is-active --quiet accel-ppp-rescue.service
ss -lnt | grep -Eq ":${RESCUE_PORT}[[:space:]]"
echo "Nova MikroTik SSTP rescue server is active on ${RESCUE_HOST}:${RESCUE_PORT}."
