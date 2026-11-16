#!/usr/bin/env bash
# Despliega (o actualiza) la demo en Azure Container Apps, plan de consumo y escala a cero.
#   ca-vestirse-web  nginx + SPA Angular, ingress público
#   ca-vestirse-api  api + ai-worker + postgres + redis + seaweedfs en una réplica (localhost), ingress
#                    interno; los datos vienen sembrados en las imágenes y vuelven a ese estado cada vez
#                    que la app se apaga por inactividad.
# La IA de imagen es la de OpenAI (AI_DRESS_ENGINE=openai): la clave se lee de services/ai-worker/.env
# y va como secreto de la app; OPENAI_BUDGET_USD limita el gasto por arranque.
# Requisitos: az login, el entorno $ENV_NAME y el registro $ACR creados, imágenes subidas con $TAG.
# Uso (desde la raíz del repo): ACR=acrvestirse1234 TAG=<sha> bash infra/azure/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
RG=${RG:-rg-vestirse-demo}
ENV_NAME=${ENV_NAME:-cae-vestirse}
ACR=${ACR:?define ACR}
TAG=${TAG:?define TAG}
BUDGET=${OPENAI_BUDGET_USD:-1.00}
R=$ACR.azurecr.io

envval() { grep -E "^$1=" ../../services/ai-worker/.env | head -1 | cut -d= -f2- | tr -d '\r'; }
OPENAI_KEY=$(envval OPENAI_API_KEY)
GROQ_KEY=$(envval GROQ_API_KEY)
[ -n "$OPENAI_KEY" ] || { echo "falta OPENAI_API_KEY en services/ai-worker/.env" >&2; exit 1; }

ENV_ID=$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query id -o tsv)
LOC=$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query location -o tsv)
DOMAIN=$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query properties.defaultDomain -o tsv)
API_FQDN=ca-vestirse-api.internal.$DOMAIN
WEB_URL=https://ca-vestirse-web.$DOMAIN
ACR_PASS=$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)
rnd() { openssl rand -hex "$1"; }
PG_PASS=$(rnd 16) S3_KEY=$(rnd 10) S3_SECRET=$(rnd 20) JWT=$(rnd 32) ENC=$(rnd 32) TOKEN=$(rnd 24)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/api.yaml" <<YAML
location: $LOC
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: false
      targetPort: 3000
      transport: auto
      allowInsecure: true
    registries:
      - server: $R
        username: $ACR
        passwordSecretRef: acr-password
    secrets:
      - { name: acr-password, value: "$ACR_PASS" }
      - { name: pg-password, value: "$PG_PASS" }
      - { name: database-url, value: "postgresql://vestirse:$PG_PASS@localhost:5432/vestirse" }
      - { name: s3-key, value: "$S3_KEY" }
      - { name: s3-secret, value: "$S3_SECRET" }
      - { name: jwt, value: "$JWT" }
      - { name: encryption, value: "$ENC" }
      - { name: worker-token, value: "$TOKEN" }
      - { name: openai-key, value: "$OPENAI_KEY" }
      - { name: groq-key, value: "${GROQ_KEY:-none}" }
  template:
    scale:
      minReplicas: 0
      maxReplicas: 1
      rules:
        - name: http
          http: { metadata: { concurrentRequests: "80" } }
    containers:
      - name: api
        image: $R/api:$TAG
        resources: { cpu: 0.5, memory: 1Gi }
        env:
          - { name: NODE_ENV, value: production }
          - { name: PORT, value: "3000" }
          - { name: DATABASE_URL, secretRef: database-url }
          - { name: REDIS_HOST, value: localhost }
          - { name: REDIS_PORT, value: "6379" }
          - { name: S3_ENDPOINT, value: "http://localhost:9000" }
          - { name: S3_REGION, value: us-east-1 }
          - { name: S3_BUCKET, value: vestirse }
          - { name: S3_ACCESS_KEY, secretRef: s3-key }
          - { name: S3_SECRET_KEY, secretRef: s3-secret }
          - { name: JWT_SECRET, secretRef: jwt }
          - { name: APP_ENCRYPTION_KEY, secretRef: encryption }
          - { name: AI_WORKER_URL, value: "http://localhost:8000" }
          - { name: WORKER_TOKEN, secretRef: worker-token }
          - { name: AI_PROVIDER, value: mock }
          - { name: AI_DRESS_ENGINE, value: openai }
          - { name: GENERATION_TIMEOUT_SECONDS, value: "240" }
          - { name: PHOTO_TTL_HOURS, value: "24" }
          - { name: WEB_ORIGIN, value: "$WEB_URL" }
      - name: worker
        image: $R/worker:$TAG
        resources: { cpu: 0.5, memory: 1Gi }
        env:
          - { name: WORKER_TOKEN, secretRef: worker-token }
          - { name: DEFAULT_PROVIDER, value: mock }
          - { name: OPENAI_API_KEY, secretRef: openai-key }
          - { name: OPENAI_BUDGET_USD, value: "$BUDGET" }
          - { name: OPENAI_SPEND_FILE, value: /tmp/openai-spend.json }
          - { name: OPENAI_IMAGE_MODEL, value: gpt-image-1-mini }
          - { name: OPENAI_IMAGE_QUALITY, value: medium }
          - { name: VISION_PROVIDER, value: openai }
          - { name: GROQ_API_KEY, secretRef: groq-key }
      - name: postgres
        image: $R/postgres-demo:$TAG
        resources: { cpu: 0.25, memory: 0.5Gi }
        env:
          - { name: POSTGRES_USER, value: vestirse }
          - { name: POSTGRES_DB, value: vestirse }
          - { name: POSTGRES_PASSWORD, secretRef: pg-password }
      - name: redis
        image: $R/redis:$TAG
        resources: { cpu: 0.25, memory: 0.5Gi }
        args: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"]
      - name: storage
        image: $R/storage-demo:$TAG
        resources: { cpu: 0.25, memory: 0.5Gi }
        env:
          - { name: S3_ACCESS_KEY, secretRef: s3-key }
          - { name: S3_SECRET_KEY, secretRef: s3-secret }
YAML

cat > "$TMP/web.yaml" <<YAML
location: $LOC
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 80
      transport: auto
      allowInsecure: false
    registries:
      - server: $R
        username: $ACR
        passwordSecretRef: acr-password
    secrets:
      - { name: acr-password, value: "$ACR_PASS" }
  template:
    scale:
      minReplicas: 0
      maxReplicas: 1
      rules:
        - name: http
          http: { metadata: { concurrentRequests: "100" } }
    containers:
      - name: web
        image: $R/web:$TAG
        resources: { cpu: 0.25, memory: 0.5Gi }
        env:
          - { name: API_UPSTREAM, value: "$API_FQDN:80" }
          - { name: API_HOST, value: "$API_FQDN" }
YAML

for app in api web; do
  name=ca-vestirse-$app
  if az containerapp show -n "$name" -g "$RG" -o none 2>/dev/null; then
    az containerapp update -n "$name" -g "$RG" --yaml "$TMP/$app.yaml" -o none
  else
    az containerapp create -n "$name" -g "$RG" --yaml "$TMP/$app.yaml" -o none
  fi
  echo "$name desplegada"
done
echo "Web: $WEB_URL"
