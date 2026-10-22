#!/bin/bash
# EC2 user data for the hosted Unrush demo (Amazon Linux 2023, arm64, e.g. t4g.micro).
# deploy.sh fills in the __PLACEHOLDERS__. Installs Node and Caddy, builds the app,
# and runs the MCP server, the web backend and Caddy (HTTPS) under systemd.
set -euxo pipefail

DOMAIN="__DOMAIN__"
REPO="__REPO__"
NODE_VERSION="v24.18.0"
CADDY_VERSION="2.10.0"

# 1 GB of swap: npm install and the Vite build are tight in 1 GB of memory.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

dnf install -y git tar xz gcc-c++ make python3

# Node (official linux-arm64 build) and Caddy (official release binary).
curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz" | tar -xz -C /usr/local/bin caddy

id unrush &>/dev/null || useradd --system --create-home --home-dir /var/lib/unrush unrush
id caddy &>/dev/null || useradd --system --create-home --home-dir /var/lib/caddy caddy

# App
if [ ! -d /opt/unrush ]; then git clone --depth 1 "$REPO" /opt/unrush; fi
chown -R unrush:unrush /opt/unrush
sudo -u unrush -H bash -c 'cd /opt/unrush && npm ci --no-audit --no-fund && npm run build'

cat > /etc/unrush.env <<EOF
AWS_REGION=__REGION__
BEDROCK_MODEL_ID=__MODEL_ID__
AGENTCORE_MEMORY_ID=__MEMORY_ID__
UNRUSH_PUBLIC=1
UNRUSH_DB_PATH=/var/lib/unrush/unrush.db
MCP_PORT=3001
WEB_PORT=3000
NODE_OPTIONS=--max-old-space-size=384
EOF

cat > /etc/systemd/system/unrush-mcp.service <<'EOF'
[Unit]
Description=Unrush MCP server (Streamable HTTP, localhost only)
After=network-online.target

[Service]
User=unrush
WorkingDirectory=/opt/unrush/packages/mcp-server
EnvironmentFile=/etc/unrush.env
Environment=PATH=/usr/local/bin:/usr/bin
ExecStart=/usr/local/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/unrush-web.service <<'EOF'
[Unit]
Description=Unrush web backend (Bedrock agent + UI, localhost only)
After=unrush-mcp.service
Requires=unrush-mcp.service

[Service]
User=unrush
WorkingDirectory=/opt/unrush/packages/web
EnvironmentFile=/etc/unrush.env
Environment=PATH=/usr/local/bin:/usr/bin
ExecStart=/usr/local/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		# Server-Sent Events: pass every chunk straight through.
		flush_interval -1
	}
}
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy (HTTPS for the Unrush demo)
After=network-online.target

[Service]
User=caddy
Environment=HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now unrush-mcp unrush-web caddy
