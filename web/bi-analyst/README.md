# web/bi-analyst

BI 问数工作台。React + Vite + Ant Design + `@ai-sdk/react`，通过自定义 ChatTransport 对接 `apps/bi-analyst` 的 `POST /api/analyze/stream`。

规格见 [specs/001-ask-data-workbench](./specs/001-ask-data-workbench/spec.md)。

## 启动

先启动问数后端，再开前端：

```bash
# 终端 1
cd apps/bi-analyst
pnpm dev

# 终端 2（仓库根目录）
pnpm --filter @agent-platform/web-bi-analyst dev
```

浏览器打开 `http://127.0.0.1:5173`。Vite 会把 `/api` 和 `/health` 代理到 `http://127.0.0.1:3000`。

本地鉴权头固定为 `x-subject-id: user-dev`、`x-tenant-id: tenant-1`。
