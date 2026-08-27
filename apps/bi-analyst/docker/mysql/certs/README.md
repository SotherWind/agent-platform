# 本地 MySQL TLS / mTLS 测试证书（仅开发，勿用于生产）

```bash
pnpm docker:certs
```

生成文件：`ca.pem`、`server-*.pem`、`client-*.pem`（由 CA 签发）。
