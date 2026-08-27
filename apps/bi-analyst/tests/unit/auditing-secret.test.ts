import assert from "node:assert/strict";
import {
  AuditingSecretProvider,
  withSecretAudit,
} from "../../src/datasource/auditing-secret-provider.js";
import { TestSecretProvider } from "../../src/datasource/secrets.js";
import type {
  AuditEmitter,
  StructuredAuditEvent,
} from "../../src/audit/events.js";
import { test, section } from "../helpers/runner.js";

export async function testAuditingSecretProvider() {
  section("AuditingSecretProvider (密钥轮换审计钩子)");

  await test("解析成功发出 secret.resolved（不含明文）", async () => {
    const events: Omit<StructuredAuditEvent, "timestamp">[] = [];
    const audit: AuditEmitter = {
      emit(e) {
        events.push(e);
      },
    };
    const provider = new AuditingSecretProvider(
      new TestSecretProvider({ DB_PASS: "s3cret" }),
      { audit },
    );
    const resolved = await provider.resolve({
      provider: "test",
      key: "DB_PASS",
    });
    assert.equal(resolved.value, "s3cret");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "secret.resolved");
    assert.equal(events[0]!.metadata?.key, "DB_PASS");
    assert.ok(!JSON.stringify(events[0]).includes("s3cret"));
  });

  await test("同一 key 值变化发出 secret.rotation_detected", async () => {
    const events: Omit<StructuredAuditEvent, "timestamp">[] = [];
    const audit: AuditEmitter = {
      emit(e) {
        events.push(e);
      },
    };
    const store: Record<string, string> = { DB_PASS: "v1" };
    const inner = {
      async resolve(ref: { key: string }) {
        return { value: store[ref.key]! };
      },
    };
    const provider = new AuditingSecretProvider(inner, { audit });
    await provider.resolve({ provider: "test", key: "DB_PASS" });
    store.DB_PASS = "v2";
    await provider.resolve({ provider: "test", key: "DB_PASS" });
    const rotated = events.filter((e) => e.event === "secret.rotation_detected");
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0]!.metadata?.fingerprintChanged, true);
  });

  await test("withSecretAudit 幂等包装", () => {
    const once = withSecretAudit(new TestSecretProvider({ K: "1" }));
    const twice = withSecretAudit(once);
    assert.equal(once, twice);
  });
}
