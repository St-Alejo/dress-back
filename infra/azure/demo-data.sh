#!/usr/bin/env bash
# Construye las imágenes de datos de la demo en Azure a partir del entorno local (docker compose):
#   vestirse-pg-demo:local  Postgres con el volcado de la base local (catálogo, vistas por modelo,
#                           cuenta demo y sus favoritos), sin sesiones de prueba ni métricas
#   vestirse-s3-demo:local  SeaweedFS con el bucket local, sin uploads/ (fotos de personas)
# La cuenta admin recibe una contraseña aleatoria nueva (se guarda en infra/azure/.secrets, ignorado).
# Requiere los contenedores vestirse-postgres-1 y vestirse-s3-1 en marcha.
# Uso (desde la raíz del repo): bash infra/azure/demo-data.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
S3=vestirse-bake-s3 KEY=bake-key SECRET=bake-secret-bake-secret PORT=9333
cleanup() { docker rm -f $S3 >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
rm -rf build && mkdir -p build/s3data

docker exec vestirse-postgres-1 pg_dump -U vestirse -d vestirse --no-owner --no-privileges \
  --exclude-table-data='"TryOnSession"' --exclude-table-data='"MetricEvent"' > build/demo.sql

# Contraseña de admin nueva: la de la semilla es pública en el repo.
ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=')
HASH=$(cd ../../apps/api && node -e "require('argon2').hash(process.argv[1]).then(h=>process.stdout.write(h))" "$ADMIN_PASS")
printf "UPDATE \"User\" SET \"passwordHash\" = '%s' WHERE role = 'admin';\n" "$HASH" > build/admin.sql
printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASS" > .secrets

docker build -q -f storage.Dockerfile -t vestirse-s3-demo:local . >/dev/null
docker run -d --name $S3 -p $PORT:9000 -e S3_ACCESS_KEY=$KEY -e S3_SECRET_KEY=$SECRET vestirse-s3-demo:local >/dev/null
for _ in $(seq 1 120); do
  curl -s -o /dev/null http://localhost:$PORT/ && break
  sleep 1
done
SRC_KEY=vestirse SRC_SECRET=vestirse-secret DST_KEY=$KEY DST_SECRET=$SECRET \
  node s3-copy.mjs http://localhost:9000 http://localhost:$PORT
docker stop -t 20 $S3 >/dev/null
docker cp $S3:/seed/. build/s3data/
docker build -q -f postgres.Dockerfile -t vestirse-pg-demo:local . >/dev/null
docker build -q -f storage.Dockerfile -t vestirse-s3-demo:local . >/dev/null
echo "listo: $(du -sh build/demo.sql | cut -f1) de SQL, $(du -sh build/s3data | cut -f1) de archivos"
