# 瘦身多阶段：builder 编译 → runtime 仅运行产物
# 构建上下文目录需含 monorepo 子集（见 pack），镜像标签 bi-analyst-staging-acc:app

FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS builder
WORKDIR /src

# 国内构建加速：Debian + npm 镜像
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-workspace.yaml ./
COPY packages/llm-sdk/package.json packages/llm-sdk/
COPY apps/bi-analyst/package.json apps/bi-analyst/
COPY pnpm-lock.yaml* ./

RUN pnpm install --filter @agent-platform/bi-analyst... --filter @agent-platform/llm-sdk... \
  --frozen-lockfile

COPY packages/llm-sdk/tsconfig.json packages/llm-sdk/
COPY packages/llm-sdk/src packages/llm-sdk/src
COPY apps/bi-analyst/tsconfig.json apps/bi-analyst/tsconfig.build.json apps/bi-analyst/
COPY apps/bi-analyst/scripts/fix-dist-esm-extensions.mjs apps/bi-analyst/scripts/clean-production-dist.mjs apps/bi-analyst/scripts/
COPY apps/bi-analyst/src apps/bi-analyst/src
COPY apps/bi-analyst/metadata apps/bi-analyst/metadata
COPY apps/bi-analyst/config apps/bi-analyst/config

RUN pnpm --filter @agent-platform/llm-sdk build \
  && node apps/bi-analyst/scripts/fix-dist-esm-extensions.mjs packages/llm-sdk/dist \
  && pnpm --filter @agent-platform/bi-analyst build \
  && node apps/bi-analyst/scripts/fix-dist-esm-extensions.mjs apps/bi-analyst/dist \
  && pnpm deploy --filter @agent-platform/bi-analyst --prod /out/app \
  && node -e "const fs=require('node:fs'); const file='/out/app/package.json'; const pkg=JSON.parse(fs.readFileSync(file,'utf8')); delete pkg.devDependencies; delete pkg.scripts; fs.writeFileSync(file, JSON.stringify(pkg, null, 2));" \
  && rm -rf /out/app/src /out/app/tests /out/app/scripts /out/app/logs /out/app/data /out/app/.env /out/app/.env.example \
  && rm -rf /out/app/metadata /out/app/config \
  && cp -a apps/bi-analyst/metadata /out/app/metadata \
  && cp -a apps/bi-analyst/config /out/app/config \
  && test -f /out/app/dist/main.js

FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_ENV=staging \
    PORT=3000 \
    BI_SQLITE_SYNC=1 \
    BI_SINGLE_MACHINE_STAGING=1 \
    BI_ALLOW_INMEMORY_RETRIEVER=1 \
    USE_FAKE_EMBEDDINGS=true

RUN useradd --uid 10001 --create-home bi \
  && chown -R bi:bi /app

COPY --from=builder --chown=bi:bi /out/app /app

USER bi
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=10 --start-period=25s \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
