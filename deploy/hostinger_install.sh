#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-zap.zapmro.com.br}"
LE_EMAIL="${LE_EMAIL:-admin@zapmro.com.br}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"

APP_DIR="${APP_DIR:-/var/www/zapmro-app}"
APP_PORT="${APP_PORT:-3010}"
EVOLUTION_DIR="${EVOLUTION_DIR:-/opt/evolution-api}"
EVOLUTION_PORT="${EVOLUTION_PORT:-18080}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "execute como root: sudo -i"
  exit 1
fi

if [[ -z "${REPO_URL}" ]]; then
  echo "defina REPO_URL (URL do seu repositório GitHub) antes de rodar"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx openssl

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm i -g pm2

if ! command -v docker >/dev/null 2>&1; then
  apt-mark unhold containerd containerd.io docker-ce docker-ce-cli docker.io >/dev/null 2>&1 || true

  apt-get remove -y docker.io docker-doc docker-compose podman-docker containerd runc >/dev/null 2>&1 || true
  apt-get autoremove -y >/dev/null 2>&1 || true

  apt-get install -y lsb-release >/dev/null 2>&1 || true
  mkdir -p /etc/apt/keyrings

  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  if [[ -n "${CODENAME}" ]]; then
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
  fi

  apt-get update -y

  set +e
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  DOCKER_INSTALL_CODE="$?"
  set -e

  if [[ "${DOCKER_INSTALL_CODE}" -ne 0 ]]; then
    apt-get install -y docker.io docker-compose-plugin
  fi
fi
systemctl enable --now docker
systemctl enable --now nginx

if ! id -u zapmro >/dev/null 2>&1; then
  useradd -m -s /bin/bash zapmro
fi

mkdir -p "${EVOLUTION_DIR}"
cd "${EVOLUTION_DIR}"

EVOLUTION_API_KEY="$(openssl rand -hex 32)"
EVOLUTION_POSTGRES_PASSWORD="$(openssl rand -hex 16)"
EVOLUTION_REDIS_PASSWORD="$(openssl rand -hex 16)"

cat > "${EVOLUTION_DIR}/docker-compose.yaml" <<YAML
version: "3.8"

services:
  api:
    container_name: evolution_api
    image: evoapicloud/evolution-api:latest
    restart: always
    depends_on:
      - redis
      - evolution-postgres
    ports:
      - "127.0.0.1:${EVOLUTION_PORT}:8080"
    volumes:
      - evolution_instances:/evolution/instances
    networks:
      - evolution-net
    env_file:
      - .env
    expose:
      - "8080"

  redis:
    container_name: evolution_redis
    image: redis:latest
    restart: always
    command: >
      redis-server --port 6379 --appendonly yes --requirepass ${EVOLUTION_REDIS_PASSWORD}
    volumes:
      - evolution_redis:/data
    networks:
      evolution-net:
        aliases:
          - evolution-redis
    expose:
      - "6379"

  evolution-postgres:
    container_name: evolution_postgres
    image: postgres:15
    restart: always
    command:
      - postgres
      - -c
      - max_connections=1000
      - -c
      - listen_addresses=*
    environment:
      - POSTGRES_DB=evolution_db
      - POSTGRES_USER=evolution
      - POSTGRES_PASSWORD=${EVOLUTION_POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - evolution-net
    expose:
      - "5432"

volumes:
  evolution_instances:
  evolution_redis:
  postgres_data:

networks:
  evolution-net:
    name: evolution-net
    driver: bridge
YAML

cat > "${EVOLUTION_DIR}/.env" <<ENV
SERVER_URL=http://localhost:8080
AUTHENTICATION_API_KEY=${EVOLUTION_API_KEY}

DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://evolution:${EVOLUTION_POSTGRES_PASSWORD}@evolution-postgres:5432/evolution_db?schema=evolution_api

CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://:${EVOLUTION_REDIS_PASSWORD}@evolution-redis:6379/6
CACHE_REDIS_PREFIX_KEY=evolution

DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_HISTORIC=true

WEBHOOK_GLOBAL_ENABLED=false
ENV

docker compose up -d

mkdir -p "$(dirname "${APP_DIR}")"
if [[ -d "${APP_DIR}/.git" ]]; then
  cd "${APP_DIR}"
  git fetch --all
  git checkout "${BRANCH}"
  git pull origin "${BRANCH}"
else
  rm -rf "${APP_DIR}"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"
npm install

cat > "${APP_DIR}/.env" <<ENV
PORT=${APP_PORT}
NODE_ENV=production

WHATSAPP_PROVIDER=evolution
EVOLUTION_API_URL=http://127.0.0.1:${EVOLUTION_PORT}
EVOLUTION_API_KEY=${EVOLUTION_API_KEY}
EVOLUTION_WEBHOOK_URL=https://${DOMAIN}/api/evolution/webhook
EVOLUTION_INTEGRATION=WHATSAPP-BAILEYS
ENV

chown -R zapmro:zapmro "${APP_DIR}"

NGINX_SITE="/etc/nginx/sites-available/${DOMAIN}"
cat > "${NGINX_SITE}" <<NGINX
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name ${DOMAIN};

  location / {
    proxy_pass http://127.0.0.1:${APP_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location /socket.io/ {
    proxy_pass http://127.0.0.1:${APP_PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINX

ln -sf "${NGINX_SITE}" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t
systemctl reload nginx

certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${LE_EMAIL}" --redirect

sudo -u zapmro bash -lc "cd '${APP_DIR}' && pm2 delete zapmro-api >/dev/null 2>&1 || true"
sudo -u zapmro bash -lc "cd '${APP_DIR}' && pm2 start Server/index.js --name zapmro-api"

STARTUP_CMD="$(sudo -u zapmro bash -lc 'env PATH=$PATH pm2 startup systemd -u zapmro --hp /home/zapmro' | grep -Eo 'sudo .+' || true)"
if [[ -n "${STARTUP_CMD}" ]]; then
  bash -lc "${STARTUP_CMD}"
fi

sudo -u zapmro bash -lc "pm2 save"

echo
echo "OK"
echo "DOMINIO: https://${DOMAIN}"
echo "EVOLUTION_API_URL (interno): http://127.0.0.1:${EVOLUTION_PORT}"
echo "EVOLUTION_API_KEY: ${EVOLUTION_API_KEY}"
echo "WEBHOOK: https://${DOMAIN}/api/evolution/webhook"
