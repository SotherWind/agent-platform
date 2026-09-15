import { describe, expect, it } from "vitest";
import { buildHandoffPackage } from "../escalation";

const input = {
  threadId: "thread", tenantId: "a",
  transcript: [{ role: "user" as const, content: "phone 13812345678", at: 1 }],
  draftReply: "Contact person@example.com",
  decision: { required: true, triggers: ["user_request" as const], reasons: ["13812345678"] },
  accountContext: { address: "Street 42", nested: { phone: 13812345678, count: 4 } },
  toolResults: [{ name: "lookup", kind: "read", ok: true, at: 1,
    summary: JSON.stringify({ address: "Street 42", nested: { phone: "13812345678", confirmToken: "secret-token" } }) }],
  citations: [{ chunkId: "c", documentId: "d", tenantId: "a", text: "13812345678 person@example.com" }],
};

describe("handoff privacy", () => {
  it("masks tool summaries, citations, reasons and nested account fields while preserving structure", () => {
    const handoff = buildHandoffPackage(input);
    const text = JSON.stringify(handoff);
    expect(text).not.toContain("13812345678");
    expect(text).not.toContain("Street 42");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("secret-token");
    expect(handoff.accountContext.nested).toMatchObject({ count: 4 });
    expect(JSON.parse(handoff.toolResults[0].summary).nested.confirmToken).toBe("[REDACTED]");
  });

  it("honors clearance consistently without exposing secrets even to full-clearance seats", () => {
    const full = buildHandoffPackage({ ...input, clearance: "full" });
    expect(full.accountContext.address).toBe("Street 42");
    expect(full.citations[0].text).toContain("13812345678");
    expect(JSON.stringify(full)).not.toContain("secret-token");
    const none = buildHandoffPackage({ ...input, clearance: "none" });
    expect(none.citations[0].text).not.toContain("example.com");
    expect(none.accountContext.address).toBe("[REDACTED]");
  });
});
