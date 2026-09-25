#!/usr/bin/env bash
# Runs on the droplet as root after every sync: install, build, install units, start.
set -euo pipefail
APP_USER=port
APP_DIR=/opt/port
DOMAIN="$(cat /etc/port-domain)"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
su - "$APP_USER" -c "cd $APP_DIR && pnpm install --frozen-lockfile && pnpm --filter @port/web build"

cat > /etc/port-web.env <<ENV
RPC_URL=http://127.0.0.1:28899
PORT_CLUSTER=fork
PUBLIC_RPC_URL=https://$DOMAIN/rpc
PORT=3100
NODE_ENV=production
ENV

install -m 644 "$APP_DIR/deploy/systemd/port-fork.service" /etc/systemd/system/port-fork.service
install -m 644 "$APP_DIR/deploy/systemd/port-web.service" /etc/systemd/system/port-web.service
sed "s/{{DOMAIN}}/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl daemon-reload
systemctl enable caddy port-fork port-web >/dev/null 2>&1
systemctl reload-or-restart caddy

if [ "${PORT_RESET:-}" = "--reset" ] || [ ! -f "$APP_DIR/.demo/fork/env.json" ]; then
  su - "$APP_USER" -c "bash $APP_DIR/deploy/reset-fork.sh"
else
  systemctl restart port-web
fi

echo
echo "PORT is live at https://$DOMAIN   (health: https://$DOMAIN/api/health, env: https://$DOMAIN/api/env)"
