/**
 * 用 node-forge 生成 Docker 联调证书（CA + MySQL/PG server + mTLS client）。
 * 不依赖 Docker daemon。
 */
import forge from "node-forge";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mysqlCerts = path.join(root, "docker/mysql/certs");
const pgCerts = path.join(root, "docker/postgres/certs");
const stagingMysqlCerts = path.join(root, "docker/staging-acc/mysql-certs");
const stagingPgCerts = path.join(root, "docker/staging-acc/postgres-certs");

mkdirSync(mysqlCerts, { recursive: true });
mkdirSync(pgCerts, { recursive: true });
mkdirSync(stagingMysqlCerts, { recursive: true });
mkdirSync(stagingPgCerts, { recursive: true });

function fixWrapLf() {
  for (const rel of [
    "docker/mysql/wrap-entrypoint.sh",
    "docker/postgres/wrap-entrypoint.sh",
    "docker/staging-acc/mysql-wrap-entrypoint.sh",
    "docker/staging-acc/postgres-wrap-entrypoint.sh",
  ]) {
    const p = path.join(root, rel);
    if (existsSync(p)) {
      writeFileSync(p, readFileSync(p, "utf8").replace(/\r\n/g, "\n"));
    }
  }
}

function makeKeyPair() {
  return forge.pki.rsa.generateKeyPair(2048);
}

function makeCa() {
  const keys = makeKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);
  const attrs = [{ name: "commonName", value: "bi-analyst-test-ca" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}

function makeLeaf(ca, commonName, { dns = [], ips = [], clientAuth = false } = {}) {
  const keys = makeKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(ca.cert.subject.attributes);
  const altNames = [
    ...dns.map((value) => ({ type: 2, value })),
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const extensions = [
    { name: "basicConstraints", cA: false },
    {
      name: "extKeyUsage",
      serverAuth: !clientAuth,
      clientAuth,
    },
  ];
  if (altNames.length) {
    extensions.push({ name: "subjectAltName", altNames });
  }
  cert.setExtensions(extensions);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}

function writePem(filePath, pem) {
  writeFileSync(filePath, pem.replace(/\r\n/g, "\n"));
}

const ca = makeCa();
const mysql = makeLeaf(ca, "bi-mysql", {
  dns: ["localhost", "bi-mysql", "bi-acc-mysql"],
  ips: ["127.0.0.1"],
});
const pg = makeLeaf(ca, "bi-postgres", {
  dns: ["localhost", "bi-postgres", "bi-acc-postgres"],
  ips: ["127.0.0.1"],
});
const client = makeLeaf(ca, "bi-mtls-client", { clientAuth: true });

const caPem = forge.pki.certificateToPem(ca.cert);
const caKeyPem = forge.pki.privateKeyToPem(ca.keys.privateKey);
const mysqlCertPem = forge.pki.certificateToPem(mysql.cert);
const mysqlKeyPem = forge.pki.privateKeyToPem(mysql.keys.privateKey);
const pgCertPem = forge.pki.certificateToPem(pg.cert);
const pgKeyPem = forge.pki.privateKeyToPem(pg.keys.privateKey);
const clientCertPem = forge.pki.certificateToPem(client.cert);
const clientKeyPem = forge.pki.privateKeyToPem(client.keys.privateKey);

writePem(path.join(mysqlCerts, "ca.pem"), caPem);
writePem(path.join(mysqlCerts, "ca-key.pem"), caKeyPem);
writePem(path.join(mysqlCerts, "mysql-server-cert.pem"), mysqlCertPem);
writePem(path.join(mysqlCerts, "mysql-server-key.pem"), mysqlKeyPem);
writePem(path.join(mysqlCerts, "server-cert.pem"), mysqlCertPem);
writePem(path.join(mysqlCerts, "server-key.pem"), mysqlKeyPem);
writePem(path.join(mysqlCerts, "client-cert.pem"), clientCertPem);
writePem(path.join(mysqlCerts, "client-key.pem"), clientKeyPem);

writePem(path.join(pgCerts, "ca.pem"), caPem);
writePem(path.join(pgCerts, "server.crt"), pgCertPem);
writePem(path.join(pgCerts, "server.key"), pgKeyPem);

writePem(path.join(stagingMysqlCerts, "ca.pem"), caPem);
writePem(path.join(stagingMysqlCerts, "server-cert.pem"), mysqlCertPem);
writePem(path.join(stagingMysqlCerts, "server-key.pem"), mysqlKeyPem);

writePem(path.join(stagingPgCerts, "ca.pem"), caPem);
writePem(path.join(stagingPgCerts, "server.crt"), pgCertPem);
writePem(path.join(stagingPgCerts, "server.key"), pgKeyPem);

fixWrapLf();
console.log(
  "certs ready (node-forge):",
  mysqlCerts,
  pgCerts,
  stagingMysqlCerts,
  stagingPgCerts,
);
