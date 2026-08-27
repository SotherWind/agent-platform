#!/bin/sh
# Windows bind-mount：复制证书并修正权限后启动 Postgres
set -eu
mkdir -p /var/lib/postgresql/certs
cp /certs-ro/ca.pem /var/lib/postgresql/certs/ca.crt
cp /certs-ro/server.crt /var/lib/postgresql/certs/server.crt
cp /certs-ro/server.key /var/lib/postgresql/certs/server.key
chown -R postgres:postgres /var/lib/postgresql/certs
chmod 600 /var/lib/postgresql/certs/server.key
chmod 644 /var/lib/postgresql/certs/server.crt /var/lib/postgresql/certs/ca.crt
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/var/lib/postgresql/certs/server.crt \
  -c ssl_key_file=/var/lib/postgresql/certs/server.key \
  -c ssl_ca_file=/var/lib/postgresql/certs/ca.crt \
  "$@"
