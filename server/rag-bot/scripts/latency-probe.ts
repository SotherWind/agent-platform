/**
 * 延迟探针：逐节点计时跑一次真实问答（chunked 真流式）。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/latency-probe.ts ["问题"]
 *   pnpm --filter @agent-platform/rag-bot-server exec tsx scripts/latency-probe.ts
 *
 * 输出：每个阶段的 span 耗时 + 首字时间 + 总耗时。用于定位首字延迟瓶颈。
 */
import { createGraph } from "@agent-platform/rag-boot";
import { Tracer } from "@agent-platform/rag-boot/src/observability/tracer";
import type { Span } from "@agent-platform/rag-boot/src/observability/tracer";
import "../src/env.js";

class TimingTracer extends Tracer {
  end(span: Span, result?: { error?: unknown; attributes?: Record<string, unknown> }): Span {
    const done = super.end(span, result);
    const model = done.attributes.model ? ` model=${done.attributes.model}` : "";
    console.log(
      `    [span] ${done.stage.padEnd(12)} ${String(done.durationMs ?? 0).padStart(6)}ms${model}${done.error ? ` ERROR=${done.error}` : ""}`,
    );
    return done;
  }
}

async function main(): Promise<void> {
  const question = process.argv[2] ?? "退款多久到账？";
  const tracer = new TimingTracer();

  console.log(`[probe] 问题: ${question}`);
  console.log("[probe] 构建图…");
  const graph = await createGraph({
    tracer,
    ...(process.env.SPECIALIST_POLICY === "skipSingleCategory"
      ? { specialistPolicy: "skipSingleCategory" as const }
      : {}),
  });

  const t0 = Date.now();
  let firstDelta: number | null = null;
  let chars = 0;
  let deltas = 0;
  let replaced = false;

  const events = graph.streamTokens(
    {
      query: question,
      tenantId: "tenant-demo",
      principal: "latency-probe",
      authenticated: true,
      threadId: `latency-${Date.now()}`,
      history: [],
    },
    undefined,
    { mode: "chunked" },
  );

  for await (const event of events) {
    if (event.type === "delta") {
      deltas += 1;
      chars += event.text.length;
      if (firstDelta === null) {
        firstDelta = Date.now() - t0;
        console.log(`  ★ 首字: ${firstDelta}ms`);
      }
    } else if (event.type === "replace") {
      replaced = true;
      console.log(`  ⚠ replace: ${event.reason}`);
    }
  }

  const total = Date.now() - t0;
  console.log(`[probe] 首字=${firstDelta ?? "-"}ms  总耗时=${total}ms  delta数=${deltas}  字数=${chars}${replaced ? "（触发替换）" : ""}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[probe] 失败:", error);
  process.exit(1);
});
