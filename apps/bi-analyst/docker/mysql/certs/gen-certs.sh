#!/bin/sh
# 生成 Docker 联调用自签 CA / 服务端 / 客户端证书（仅开发）
set -e
OUT=${1:-/certs}
mkdir -p "$OUT"

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$OUT/ca-key.pem" -out "$OUT/ca.pem" \
  -subj "/CN=bi-analyst-test-ca"

# MySQL server
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT/mysql-server-key.pem" -out "$OUT/mysql-server.csr" \
  -subj "/CN=bi-mysql"
openssl x509 -req -in "$OUT/mysql-server.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca-key.pem" \
  -CAcreateserial -out "$OUT/mysql-server-cert.pem" -days 3650 -sha256 \
  -extfile /tmp/mysql-san.cnf
cat > /tmp/mysql-san.cnf <<'EOF'
subjectAltName=DNS:localhost,DNS:bi-mysql,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$OUT/mysql-server.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca-key.pem" \
  -CAcreateserial -out "$OUT/mysql-server-cert.pem" -days 3650 -sha256 \
  -extfile /tmp/mysql-san.cnf

# PostgreSQL server
cat > /tmp/pg-san.cnf <<'EOF'
subjectAltName=DNS:localhost,DNS:bi-postgres,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT/pg-server-key.pem" -out "$OUT/pg-server.csr" \
  -subj "/CN=bi-postgres"
openssl x509 -req -in "$OUT/pg-server.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca-key.pem" \
  -CAcreateserial -out "$OUT/pg-server-cert.pem" -days 3650 -sha256 \
  -extfile /tmp/pg-san.cnf

# Client (mTLS)
cat > /tmp/client-ext.cnf <<'EOF'
extendedKeyUsage=clientAuth
EOF
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT/client-key.pem" -out "$OUT/client.csr" \
  -subj "/CN=bi-mtls-client"
openssl x509 -req -in "$OUT/client.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca-key.pem" \
  -CAcreateserial -out "$OUT/client-cert.pem" -days 3650 -sha256 \
  -extfile /tmp/client-ext.cnf

# 兼容旧路径：mysql/certs 期望的文件名
cp "$OUT/ca.pem" "$OUT/server-cert.pem.bak" 2>/dev/null || true
cp "$OUT/mysql-server-cert.pem" "$OUT/server-cert.pem"
cp "$OUT/mysql-server-key.pem" "$OUT/server-key.pem"

rm -f "$OUT"/*.csr "$OUT"/ca.srl /tmp/mysql-san.cnf /tmp/pg-san.cnf /tmp/client-ext.cnf
chmod 644 "$OUT"/*.pem
chmod 600 "$OUT"/*-key.pem "$OUT"/server-key.pem "$OUT"/ca-key.pem 2>/dev/null || true
ls -la "$OUT"
