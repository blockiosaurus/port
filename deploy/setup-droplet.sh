#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 DigitalOcean droplet (run as root, once):
#
#   ssh root@<ip> PORT_DOMAIN=port.example.com bash -s < deploy/setup-droplet.sh
#
# PORT_DOMAIN is optional: without a domain it uses <public-ip>.sslip.io, which resolves to the
# droplet and for which Caddy can obtain a public certificate. Point a real domain's A record at
# the droplet and pass it instead when you have one.
#
# Sizing: solana-test-validator with the ~640 cloned accounts wants 8 GB RAM and ~20 GB of disk
# for the ledger; a 4 vCPU / 8 GB droplet is comfortable.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

APP_USER=port
APP_DIR=/opt/port
AGAVE_VERSION=v3.1.14                       # same as the version the fork was developed against
PORT_DOMAIN="${PORT_DOMAIN:-$(curl -s -4 https://ifconfig.me).sslip.io}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git rsync build-essential pkg-config libssl-dev libudev-dev ufw \
  debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg

# Node 22 (engines.node >= 22.12) and the pinned pnpm.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm@10.33.2

# Caddy (reverse proxy + automatic TLS).
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# Unprivileged service user. It may only start/stop the two PORT units (used by reset-fork.sh).
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" && chown "$APP_USER:$APP_USER" "$APP_DIR"
cat > /etc/sudoers.d/port <<SUDO
$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start port-fork, /usr/bin/systemctl stop port-fork, /usr/bin/systemctl restart port-fork, /usr/bin/systemctl start port-web, /usr/bin/systemctl stop port-web, /usr/bin/systemctl restart port-web
SUDO
chmod 440 /etc/sudoers.d/port

# Agave toolchain (solana-test-validator) for the service user.
su - "$APP_USER" -c "sh -c \"\$(curl -sSfL https://release.anza.xyz/$AGAVE_VERSION/install)\""
su - "$APP_USER" -c 'grep -q active_release ~/.profile || echo "export PATH=\$HOME/.local/share/solana/install/active_release/bin:\$PATH" >> ~/.profile'

# Only SSH and the proxy are reachable; the validator's RPC/gossip ports stay on localhost.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "$PORT_DOMAIN" > /etc/port-domain
echo
echo "Droplet ready. Domain: $PORT_DOMAIN"
echo "Next, from your machine:  pnpm deploy:sync root@$(curl -s -4 https://ifconfig.me)"
