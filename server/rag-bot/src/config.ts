import type { RetrievalScope } from '@agent-platform/rag-boot';

/**
 * 服务配置：从环境变量解析账号表、系统 token 表与运行参数。
 *
 * 设计约束：密钥只进内存，不进日志；格式错误 fail-fast，带行内定位。
 */

export interface UserEntry {
  username: string;
  password: string;
  tenantId: string;
  knowledgeScope?: RetrievalScope;
}

export interface SystemTokenEntry {
  token: string;
  tenantId: string;
  principal: string;
  knowledgeScope?: RetrievalScope;
}

export interface ServerConfig {
  environment: 'development' | 'production';
  dataDir?: string;
  businessModule?: string;
  port: number;
  corsOrigin: string[];
  users: UserEntry[];
  systemTokens: SystemTokenEntry[];
  tokenTtlSeconds: number;
  autoIngest: boolean;
  knowledgeDir: string;
  useFakeLlm: boolean;
  /** 流式输出：每个片段的字符数（越小越平滑） */
  streamChunkSize: number;
  /** 流式输出：片段之间的基础间隔（毫秒，句末标点会加长）；0 表示不节流 */
  streamChunkDelayMs: number;
  /** strict 默认且生产必选；chunked/async 仅用于开发兼容测试。 */
  reviewStreamMode: 'strict' | 'chunked' | 'async';
  /** 专家节点策略：skipSingleCategory 时单类别查询跳过 specialist/orchestration（省一次 LLM 调用） */
  specialistPolicy: 'always' | 'skipSingleCategory';
  /** T5.3 确认令牌派生密钥（proposalToken = hash(secret|proposalId|threadId|principal)） */
  proposalSecret: string;
  /**
   * 影子模式弱标签采集（rag-boot ShadowLabelCollector）。
   * 快照含用户 query 原文（PII），生产默认关闭；开发默认开启。
   * 攒下的标签导出给 `pnpm calibrate` 做置信度阈值的实测标定。
   */
  shadowLabels: boolean;
  /** 影子标签快照路径（JSON，随 dataDir 持久化） */
  shadowLabelsPath: string;
}

/** 解析 "a:b:c,d2:b2:c2" 形式的紧凑列表；空串返回空数组 */
function parseTripleList(
  raw: string | undefined,
  label: string,
  fields: number,
): string[][] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const pieces = part.split(':').map((p) => p.trim());
      if (pieces.length !== fields || pieces.some((p) => !p)) {
        throw new Error(
          `${label} 第 ${index + 1} 项格式错误（期望 ${fields} 段以冒号分隔，实际 ${pieces.length} 段）`,
        );
      }
      return pieces;
    });
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const port = Number.parseInt(env.PORT ?? '8787', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 非法: ${env.PORT ?? '(未设置)'}`);
  }

  const users: UserEntry[] = parseTripleList(
    env.RAGBOT_USERS,
    'RAGBOT_USERS',
    3,
  ).map(([username, password, tenantId]) => ({ username, password, tenantId }));

  const systemTokens: SystemTokenEntry[] = parseTripleList(
    env.RAGBOT_SYSTEM_TOKENS,
    'RAGBOT_SYSTEM_TOKENS',
    3,
  ).map(([token, tenantId, principal]) => ({ token, tenantId, principal }));

  const tokenTtlSeconds = Number.parseInt(
    env.RAGBOT_TOKEN_TTL_SECONDS ?? '604800',
    10,
  );
  if (!Number.isInteger(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new Error(
      `RAGBOT_TOKEN_TTL_SECONDS 非法: ${env.RAGBOT_TOKEN_TTL_SECONDS ?? '(未设置)'}`,
    );
  }

  const corsRaw = env.CORS_ORIGIN ?? '*';
  const corsOrigin = corsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const streamChunkDelayMs = Number.parseInt(
    env.STREAM_CHUNK_DELAY_MS ?? '22',
    10,
  );
  if (
    !Number.isInteger(streamChunkDelayMs) ||
    streamChunkDelayMs < 0 ||
    streamChunkDelayMs > 1000
  ) {
    throw new Error(
      `STREAM_CHUNK_DELAY_MS 非法（0-1000）: ${env.STREAM_CHUNK_DELAY_MS ?? '(未设置)'}`,
    );
  }
  const streamChunkSize = Number.parseInt(env.STREAM_CHUNK_SIZE ?? '12', 10);
  if (
    !Number.isInteger(streamChunkSize) ||
    streamChunkSize < 1 ||
    streamChunkSize > 200
  ) {
    throw new Error(
      `STREAM_CHUNK_SIZE 非法（1-200）: ${env.STREAM_CHUNK_SIZE ?? '(未设置)'}`,
    );
  }

  const reviewStreamModeRaw = env.REVIEW_STREAM_MODE ?? 'strict';
  if (
    reviewStreamModeRaw !== 'strict' &&
    reviewStreamModeRaw !== 'chunked' &&
    reviewStreamModeRaw !== 'async'
  ) {
    throw new Error(
      `REVIEW_STREAM_MODE 非法（strict|chunked|async）: ${reviewStreamModeRaw}`,
    );
  }

  const specialistPolicyRaw = env.SPECIALIST_POLICY ?? 'always';
  if (
    specialistPolicyRaw !== 'always' &&
    specialistPolicyRaw !== 'skipSingleCategory'
  ) {
    throw new Error(
      `SPECIALIST_POLICY 非法（always|skipSingleCategory）: ${specialistPolicyRaw}`,
    );
  }

  const environment =
    env.NODE_ENV === 'production' ? 'production' : 'development';
  const dataDir =
    env.RAGBOT_DATA_DIR?.trim() ||
    (environment === 'development' ? './data' : undefined);
  const businessModule = env.RAGBOT_BUSINESS_MODULE?.trim() || undefined;
  const proposalSecret = env.RAGBOT_PROPOSAL_SECRET ?? 'rag-boot-dev-secret';
  // 影子标签：快照含 query 原文（PII），生产默认关闭、开发默认开启
  const shadowLabels =
    env.SHADOW_LABELS === undefined
      ? environment !== 'production'
      : env.SHADOW_LABELS === 'true';
  const shadowLabelsPath =
    env.SHADOW_LABELS_PATH?.trim() ||
    `${dataDir ?? './data'}/shadow-labels.json`;
  if (environment === 'production') {
    if (!dataDir)
      throw new Error(
        'Production requires RAGBOT_DATA_DIR on durable storage.',
      );
    if (
      Buffer.byteLength(proposalSecret) < 32 ||
      proposalSecret === 'rag-boot-dev-secret'
    ) {
      throw new Error(
        'Production requires RAGBOT_PROPOSAL_SECRET of at least 32 bytes.',
      );
    }
    if (reviewStreamModeRaw !== 'strict')
      throw new Error('Production requires REVIEW_STREAM_MODE=strict.');
    if (env.USE_FAKE_LLM === 'true')
      throw new Error('Production cannot use a fake LLM.');
    if (env.USE_FAKE_EMBEDDINGS === 'true')
      throw new Error('Production cannot use fake embeddings.');
    if (!businessModule)
      throw new Error(
        'Production requires RAGBOT_BUSINESS_MODULE with real authorized business tools.',
      );
  }

  const grants: unknown = JSON.parse(env.RAGBOT_KNOWLEDGE_SCOPES ?? '[]');
  if (!Array.isArray(grants))
    throw new Error('RAGBOT_KNOWLEDGE_SCOPES must be an array.');
  for (const grant of grants) {
    if (
      !grant ||
      typeof grant !== 'object' ||
      typeof grant.tenantId !== 'string' ||
      typeof grant.principal !== 'string'
    ) {
      throw new Error('Each knowledge grant requires tenantId and principal.');
    }
    const scope: Record<string, string[]> = {};
    for (const key of ['products', 'regions', 'roles', 'permissions']) {
      const values = grant[key] ?? [];
      if (
        !Array.isArray(values) ||
        values.some(
          (value: unknown) => typeof value !== 'string' || !value.trim(),
        )
      ) {
        throw new Error(`Knowledge grant ${key} must be a string array.`);
      }
      scope[key] = [...values];
    }
    for (const user of users) {
      if (user.tenantId === grant.tenantId && user.username === grant.principal)
        user.knowledgeScope = scope;
    }
    for (const token of systemTokens) {
      if (
        token.tenantId === grant.tenantId &&
        token.principal === grant.principal
      )
        token.knowledgeScope = scope;
    }
  }

  return {
    environment,
    dataDir,
    businessModule,
    port,
    corsOrigin,
    users,
    systemTokens,
    tokenTtlSeconds,
    autoIngest:
      env.AUTO_INGEST === undefined
        ? environment !== 'production'
        : env.AUTO_INGEST !== 'false',
    knowledgeDir: env.KNOWLEDGE_DIR ?? './knowledge',
    useFakeLlm: env.USE_FAKE_LLM === 'true',
    streamChunkSize,
    streamChunkDelayMs,
    reviewStreamMode: reviewStreamModeRaw,
    specialistPolicy: specialistPolicyRaw,
    proposalSecret,
    shadowLabels,
    shadowLabelsPath,
  };
}
