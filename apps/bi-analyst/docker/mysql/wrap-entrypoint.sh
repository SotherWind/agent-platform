#!/bin/bash
# Windows bind-mount 私钥权限问题：复制到本地目录并 chown 后再启动。
set -euo pipefail
mkdir -p /var/lib/mysql-certs
cp /certs-ro/ca.pem /certs-ro/server-cert.pem /certs-ro/server-key.pem /var/lib/mysql-certs/
if command -v openssl >/dev/null 2>&1; then
  openssl rsa -in /var/lib/mysql-certs/server-key.pem \
    -out /var/lib/mysql-certs/server-key.rsa.pem 2>/dev/null \
    && mv /var/lib/mysql-certs/server-key.rsa.pem /var/lib/mysql-certs/server-key.pem \
    || true
fi
chown -R mysql:mysql /var/lib/mysql-certs
chmod 600 /var/lib/mysql-certs/server-key.pem
chmod 644 /var/lib/mysql-certs/ca.pem /var/lib/mysql-certs/server-cert.pem
exec docker-entrypoint.sh mysqld "$@"
