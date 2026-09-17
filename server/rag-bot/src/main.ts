/**
 * 智能客服 server 入口。
 *
 * 分层（拷问定稿）：
 *   HTTP（本包）→ AccessGateway（鉴权/幂等/限流）→ rag-boot 图（纯库）
 * 核心库不知道 HTTP 的存在；未来换框架/加渠道只动本包。
 */
import './env.js';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ActionGuardrails,
  ActionSignalBus,
  ActionDispatcher,
  ProposalService,
  Tracer,
  createGraph,
  createApiReranker,
  ShadowLabelCollector,
  TicketService,
  type VectorStoreType,
  type KnowledgePublicationStore,
} from '@agent-platform/rag-boot';
import type { Span } from '@agent-platform/rag-boot';
import { AuthService } from './auth.js';
import { loadServerConfig } from './config.js';
import { demoLlms } from './fake-llm.js';
import { buildAccessGateway } from './gateway.js';
import { handleRequest, type HttpDeps } from './http.js';
import { autoIngestKnowledge } from './ingest.js';
import { createPersistence } from './persistence.js';
import { resolveBusinessTools } from './business.js';
import { redactObject } from '@agent-platform/rag-boot';
import { assertNativeRuntimeCompatibility } from './runtime.js';

/**
 * 关键阶段日志：让每一轮都能回答"转人工/拦截发生在哪一步、为什么"。
 * 记录 triage/specialist/tools/generate/review/escalate 的耗时、终审结论与拒绝原因。
 */
class LoggingTracer extends Tracer {
  end(
    span: Span,
    result?: { error?: unknown; attributes?: Record<string, unknown> },
  ): Span {
    const done = super.end(span, result);
    const interesting = [
      'triage',
      'specialist',
      'tools',
      'generate',
      'review',
      'escalate',
    ];
    if (interesting.includes(done.stage)) {
      const attrs = done.attributes as Record<string, unknown>;
      const parts = [`stage=${done.stage}`, `${done.durationMs ?? 0}ms`];
      if (attrs.reviewPassed !== undefined)
        parts.push(`reviewPassed=${attrs.reviewPassed}`);
      if (attrs.reviewViolations)
        parts.push(`violations=${String(attrs.reviewViolations)}`);
      if (attrs.toolName) parts.push(`tool=${String(attrs.toolName)}`);
      if (attrs.model) parts.push(`model=${String(attrs.model)}`);
      if (done.error) parts.push(`error=${done.error}`);
      console.log(`[trace] ${parts.join('  ')}`);
    }
    return done;
  }
}

/** 检索降级的空实现：与 rag-boot 内部 EMPTY_VECTOR_STORE 同形状（Qdrant 不可用时注入） */
const emptyVectorStore: VectorStoreType = {
  async search() {
    return [];
  },
  async addDocuments() {
    return 0;
  },
  async ingestFile() {
    return 0;
  },
  async deleteByDocumentId() {},
};

/**
 * 预连 Qdrant：连得上 → 显式注入（避免 buildGraph 重复创建）；
 * 开发环境连不上时注入空检索并告警；生产环境连接失败则阻止启动。
 * 用户启动 qdrant.exe 后重启 server 即可恢复完整能力。
 */
async function resolveVectorStore(
  production: boolean,
  publications: KnowledgePublicationStore,
): Promise<VectorStoreType | undefined> {
  if (!process.env.QDRANT_URL && !process.env.QDRANT_API_KEY) {
    if (production)
      throw new Error('Production requires Qdrant configuration.');
    console.log('[boot] 未配置 Qdrant：检索为空（安全降级），图仍可直答');
    return undefined;
  }
  try {
    const store = await import('@agent-platform/rag-boot').then((m) =>
      m.createVectorStore({ publications }),
    );
    console.log(
      `[boot] Qdrant 已连接: ${process.env.QDRANT_URL ?? '(由 API key 推断)'}`,
    );
    return store;
  } catch (error) {
    if (production) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[boot] ⚠️ Qdrant 连接失败，检索降级为空（不影响对话启动）：${message}`,
    );
    console.warn(
      '[boot] ⚠️ 请确认 qdrant.exe 已启动（默认 6333 端口）后重启本服务以恢复知识检索。',
    );
    return emptyVectorStore;
  }
}

async function main(): Promise<void> {
  const config = loadServerConfig();
  assertNativeRuntimeCompatibility();

  const persistence = createPersistence(config.dataDir, {
    localCrm: !config.businessModule,
  });
  const authService = new AuthService(config);
  const gateway = buildAccessGateway(authService, {
    environment: config.environment,
    idempotency: persistence.entry,
    sessionBindings: persistence.sessions,
  });

  // ---- 二期装配（T5.3 确认流 / T5.4 工单 / 业务工具）----
  // 三段分离：图内提出动作，确定性确认后入队，ActionDispatcher 投递给业务适配器。
  // 开发默认使用持久化 LocalCrmAdapter；生产必须加载显式配置的真实业务模块。
  // ticketService 提升到 server 层：同一个实例既注入图（escalate/create_ticket 建单），
  // 也供 GET /api/tickets 路由查询——工单数据的唯一来源，避免两套存储。
  const audit = (entry: unknown) =>
    console.log('[audit]', JSON.stringify(redactObject(entry)));
  const ticketService = new TicketService({ store: persistence.tickets });
  const proposalService = new ProposalService({
    secret: config.proposalSecret,
    store: persistence.proposals,
    onAudit: audit,
  });
  const signalBus = new ActionSignalBus({
    store: persistence.signals,
    onAudit: audit,
  });
  const localCrm = 'crm' in persistence ? persistence.crm : undefined;
  const tools = await resolveBusinessTools(config, ticketService, localCrm);
  const actionGuardrails = new ActionGuardrails();
  const dispatcher = new ActionDispatcher({
    proposals: proposalService,
    signals: signalBus,
    tools,
    idempotency: persistence.tools,
    guardrails: actionGuardrails,
    audit,
  });

  // ---- reranker 装配 ----
  // 此前 .env 配了 RERANK_* 但从未接进图：图退化为纯向量序，rerankScore 实际是余弦相似度。
  // 这不只是检索质量损失——影子标签会把余弦分数标成 reranker 模型名，污染标定数据。
  // 所以接 reranker 是弱标签有效的前提。未配 key 时显式传 null（关闭重排，向量序降级）。
  const reranker = process.env.RERANK_API_KEY ? createApiReranker() : null;
  const rerankerModel = reranker
    ? (process.env.RERANK_MODEL ?? 'Qwen3-Reranker-8B')
    : 'vector-order';

  // ---- 影子模式弱标签采集（只记录，不干预判决）----
  // 快照落 dataDir/shadow-labels.json；攒够后导出给 pnpm calibrate 做实测标定。
  let shadowCollector: ShadowLabelCollector | undefined;
  if (config.shadowLabels) {
    const options = {
      context: {
        rerankerModel,
        kbVersion: process.env.SHADOW_KB_VERSION ?? 'kb-unversioned',
        domain: process.env.SHADOW_DOMAIN ?? 'customer-service',
      },
      onChange: (snapshot: unknown[]) => {
        try {
          mkdirSync(dirname(config.shadowLabelsPath), { recursive: true });
          writeFileSync(
            config.shadowLabelsPath,
            JSON.stringify(snapshot),
            'utf8',
          );
        } catch (error) {
          console.warn('[shadow] 快照写入失败（不影响对话）:', String(error));
        }
      },
    };
    shadowCollector = existsSync(config.shadowLabelsPath)
      ? ShadowLabelCollector.restore(
          JSON.parse(
            readFileSync(config.shadowLabelsPath, 'utf8'),
          ) as unknown[],
          options,
        )
      : new ShadowLabelCollector(options);
    console.log(
      `[boot] 影子标签已开启 → ${config.shadowLabelsPath}（reranker=${rerankerModel}）`,
    );
  }

  console.log('[boot] 正在构建智能客服图…');
  const vectorStore = await resolveVectorStore(
    config.environment === 'production',
    persistence.publications,
  );
  const graph = await createGraph({
    environment: config.environment,
    ...(reranker ? { reranker } : { reranker: null }),
    ...(shadowCollector ? { shadowCollector } : {}),
    checkpointer: persistence.checkpointer,
    idempotency: persistence.tools,
    tracer: new LoggingTracer(),
    ...(config.useFakeLlm ? { llms: demoLlms() } : {}),
    ...(vectorStore ? { vectorStore } : {}),
    ...(config.specialistPolicy === 'skipSingleCategory'
      ? { specialistPolicy: 'skipSingleCategory' as const }
      : {}),
    tools,
    proposalService,
    signalBus,
    actionGuardrails,
    ticketService,
  });
  console.log(
    config.useFakeLlm
      ? '[boot] 演示模式（USE_FAKE_LLM=true）：回答为固定话术'
      : '[boot] 真实 LLM 模式',
  );
  if (config.specialistPolicy === 'skipSingleCategory') {
    console.log(
      '[boot] 专家直通已开启：单类别查询跳过 specialist/orchestration（省一次 LLM 调用）',
    );
  }

  if (vectorStore && vectorStore !== emptyVectorStore) {
    await autoIngestKnowledge(config, vectorStore);
  } else {
    console.log('[ingest] 检索降级或未配置 Qdrant，跳过自动灌库');
  }

  const deps: HttpDeps = { config, authService, gateway, graph, ticketService };
  const server = createHttpServer(deps);
  let delivery: Promise<unknown> | undefined;
  const flush = () => {
    if (delivery) return;
    delivery = dispatcher
      .flush()
      .then((results) => {
        for (const result of results)
          if (!result.ok) console.warn('[action]', redactObject(result));
      })
      .catch((error) => console.error('[action] delivery failed', error))
      .finally(() => {
        delivery = undefined;
      });
  };
  flush();
  const deliveryTimer = setInterval(flush, 5_000);
  deliveryTimer.unref();

  server.listen(config.port, () => {
    console.log(
      `[boot] 智能客服 server 已启动: http://localhost:${config.port}`,
    );
    console.log(
      `[boot] 账号 ${config.users.length} 个，系统 token ${config.systemTokens.length} 个`,
    );
    console.log(
      '[boot] 接口: POST /login（登录换 token）、POST /api/chat（Bearer token 对话）、GET /api/tickets（工单列表）、GET /health',
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] 收到 ${signal}，正在退出…`);
    clearInterval(deliveryTimer);
    server.close(() => {
      void Promise.resolve(delivery).finally(() => {
        persistence.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function createHttpServer(deps: HttpDeps) {
  return createServer((req, res) => {
    void handleRequest(deps, req, res);
  });
}

main().catch((error) => {
  console.error('[boot] 启动失败:', error);
  process.exit(1);
});
