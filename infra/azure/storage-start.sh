#!/bin/sh
# Arranca SeaweedFS como S3 con las credenciales del entorno (S3_ACCESS_KEY / S3_SECRET_KEY).
set -eu
printf '{"identities":[{"name":"vestirse","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' \
  "$S3_ACCESS_KEY" "$S3_SECRET_KEY" > /tmp/s3.json
mkdir -p /seed && cd /seed
# El índice del filer iría a /data/filerldb2; un filer.toml en el directorio de trabajo lo deja junto a los datos.
printf '[leveldb2]\nenabled = true\ndir = "/seed/filerldb2"\n' > filer.toml
exec weed server -dir=/seed -ip=127.0.0.1 -ip.bind=0.0.0.0 -s3 -s3.port=9000 -s3.config=/tmp/s3.json \
  -master.volumeSizeLimitMB=1024
