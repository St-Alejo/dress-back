# Postgres con el esquema migrado, el catálogo, las vistas por modelo y la cuenta demo: el volcado se
# carga en el primer arranque (en Azure no hay volumen, así que cada arranque en frío vuelve a este estado).
FROM postgres:17.11-alpine
COPY build/demo.sql /docker-entrypoint-initdb.d/10-demo.sql
COPY build/admin.sql /docker-entrypoint-initdb.d/20-admin.sql
