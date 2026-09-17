/**
 * T4.3 输出侧 Guardrails 与终审 Reviewer——专属测试
 *
 * 清单 T4.3 五条规格逐条钉死。此前「检出绝对化用语等广告法风险表述」
 * （清单 568 行，ABSOLUTE_CLAIM_PATTERNS）全库无断言——本文件补上。
 * 「Reviewer 不通过时携带草稿转人工」联动 T5.2 交接包验证草稿不丢弃。
 */
import { describe, expect, it } from 'vitest';
import { checkOutput, Reviewer } from '../guardrails/output';
import { buildHandoffPackage, evaluateEscalation } from '../escalation';
import { createFakeLlm } from '../llm/fake';
import type { AnswerCitation } from '../schema';

const citation = (text: string): AnswerCitation[] => [
  { chunkId: 'c1', documentId: 'd1', tenantId: 't', text },
];

function expectViolation(codes: string[], code: string): void {
  expect(codes).toContain(code);
}

describe('T4.3 输出侧 Guardrails 与 Reviewer', () => {
  it('答案中出现未在 citations 中的账户数字时判定不通过', () => {
    const result = checkOutput({
      answer: '已为您退款 129.00 元，订单 12345678 已关闭',
      citations: citation('退款会在几个工作日内到账'),
    });
    expect(result.passed).toBe(false);
    expectViolation(
      result.violations.map((v) => v.code),
      'ungrounded_numbers',
    );
    // 引用里出现的数字不算凭空捏造
    const ok = checkOutput({
      answer: '已为您退款 129.00 元',
      citations: citation('退款金额 129.00 元将在 3 个工作日内到账'),
    });
    expect(ok.violations.some((v) => v.code === 'ungrounded_numbers')).toBe(
      false,
    );
  });

  it('检出虚假承诺（『一定』『保证』『百分百』）并要求改写', () => {
    for (const phrase of ['一定能解决', '保证到账', '百分百成功']) {
      const result = checkOutput({ answer: `我们${phrase}。` });
      expect(result.passed).toBe(false);
      expectViolation(
        result.violations.map((v) => v.code),
        'overpromise',
      );
    }
  });

  it('检出绝对化用语等广告法风险表述', () => {
    // T4.3#3（清单 568 行）：此前全库无断言
    for (const phrase of ['全网最佳', '行业第一品牌', '唯一选择', '最低价']) {
      const result = checkOutput({ answer: `我们的服务是${phrase}。` });
      expect(result.passed).toBe(false);
      expectViolation(
        result.violations.map((v) => v.code),
        'absolute_claim',
      );
      expect(
        result.violations.find((v) => v.code === 'absolute_claim')?.matched,
      ).toBeTruthy();
    }
  });

  it('提议了需确认动作却未附确认入口时判定不通过', () => {
    const result = checkOutput({
      answer: '我可以为您办理退款。',
      hasActionProposal: true,
      hasConfirmationEntry: false,
    });
    expect(result.passed).toBe(false);
    expectViolation(
      result.violations.map((v) => v.code),
      'missing_confirmation',
    );
    // 附了确认入口 → 通过
    const ok = checkOutput({
      answer: '我可以为您办理退款。',
      hasActionProposal: true,
      hasConfirmationEntry: true,
    });
    expect(ok.passed).toBe(true);
  });

  it('Reviewer 不通过时携带草稿转人工，而不是直接丢弃', async () => {
    // 有模型 + 模型两轮终审都判不通过 → verdict.passed=false，attempts 达上限
    const model = createFakeLlm({
      reply: JSON.stringify({
        passed: false,
        violations: [{ code: 'tone', detail: '措辞不当' }],
      }),
    });
    const reviewer = new Reviewer({ llm: model, maxAttempts: 2 });
    const draft = '这个问题的答案写的有点随意';
    const verdict = await reviewer.review({ answer: draft, citations: [] });

    expect(verdict.passed).toBe(false);
    expect(verdict.attempts).toBe(2);
    expect(model.callsFor('review')).toHaveLength(2); // 两次终审都真的跑了模型

    // 关键行为（清单 570 行）：草稿不丢弃——调用方拿着 verdict + 原 answer
    // 直接建交接包（T5.2），人工是在编辑草稿而非从零开始
    const handoff = buildHandoffPackage({
      threadId: 'th-review-fail',
      tenantId: 't',
      transcript: [
        { role: 'user', content: '帮我处理', at: 1 },
        { role: 'assistant', content: draft, at: 2 },
      ],
      draftReply: draft,
      decision: evaluateEscalation({ consecutiveReviewFailures: 2 }),
    });
    expect(handoff.draftReply).toBe(draft);
    expect(handoff.transcript.some((entry) => entry.content === draft)).toBe(
      true,
    );
  });

  it('确定性检查不过时直接短路，不消耗终审模型', async () => {
    const model = createFakeLlm({
      reply: JSON.stringify({ passed: true, violations: [] }),
    });
    const reviewer = new Reviewer({ llm: model, maxAttempts: 2 });
    const verdict = await reviewer.review({
      answer: '保证退款',
      citations: [],
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.source).toBe('deterministic');
    expect(model.callsFor('review')).toHaveLength(0); // 规则能抓的就不花钱
  });

  it('承诺性百分比也算 grounding：未在引用中出现的百分比不得凭空给出', () => {
    // 这是 dogfooding 时发现的缺口：原规则只抓金额与 8 位以上账号/订单号，
    // 于是「99.99% 可用性」这种"看起来很具体、其实无出处"的承诺能一路发出去。
    // 群像式幻觉最典型的产物恰恰就是它。
    const bad = checkOutput({
      answer: '我们承诺 99.99% 的可用性。',
      citations: citation('服务说明中提到了可用性相关的表述'),
    });
    expect(bad.passed).toBe(false);
    expect(
      bad.violations.find((v) => v.code === 'ungrounded_numbers')?.matched,
    ).toBe('99.99');

    // 引用里给了这个百分比 → 不能误杀
    const ok = checkOutput({
      answer: '我们承诺 99.99% 的可用性。',
      citations: citation('SLA 说明：可用性 99.99，按月统计'),
    });
    expect(ok.violations.some((v) => v.code === 'ungrounded_numbers')).toBe(
      false,
    );
  });

  it('百分比按「数字核心」比对，兼容引用里的不同写法（防格式性误杀）', () => {
    // 引用常写 "99.99 per cent" / "可用性99.99" / "百分之99.99"，
    // 若按整串 "99.99%" 匹配就会误杀——本文件已因类似问题踩过一次坑
    // （系统自产单号被 8 位数字规则误判，确认流程整个断掉）。
    for (const citationText of [
      '可用性 99.99 per cent',
      '承诺可用性99.99',
      '百分之99.99',
    ]) {
      const result = checkOutput({
        answer: '可用性为 99.99%。',
        citations: citation(citationText),
      });
      expect(
        result.violations.some((v) => v.code === 'ungrounded_numbers'),
      ).toBe(false);
    }
    // 中文写法同样能被提取
    const chinese = checkOutput({
      answer: '我们保证百分之99.9的可用性',
      citations: [],
    });
    expect(
      chinese.violations.some((v) => v.code === 'ungrounded_numbers'),
    ).toBe(true);
  });

  it('普通数量词不是承诺性数字，不得被误伤', () => {
    // 「3 个工作日」「5 分钟」这类正常知识问答必须放行，否则规则会大面积误杀
    const result = checkOutput({
      answer: '退款会在 3 个工作日内到账，通常 5 分钟就提交成功。',
      citations: citation('退款流程说明'),
    });
    expect(result.violations.some((v) => v.code === 'ungrounded_numbers')).toBe(
      false,
    );
  });

  it('系统自产单号仍被 scrub，不因新规则回归误杀确认话术', () => {
    // 历史坑：单号里的时间戳含 8 位以上连续数字，会被账户数字规则误判，
    // 导致确认流程整个断掉。这里守两件事：scrub 仍生效 + 新增的百分比规则不掺和。
    const result = checkOutput({
      answer:
        '请确认：退款提案 prop-1788647761323-1 已生成，确认后 3 个工作日内到账。',
      citations: citation('退款流程说明'),
      hasActionProposal: true,
      hasConfirmationEntry: true,
    });
    expect(result.violations.some((v) => v.code === 'ungrounded_numbers')).toBe(
      false,
    );
  });

  // ── 引用接地 fail-closed（群像式幻觉的答案侧防线）────────────────────
  // 分数侧的三条绝对判据挡不住"数字真在引用里、但讲的是另一件事"的张冠李戴；
  // 这里把它从"数字在不在"升级到"数字挂在哪件事上"。

  it('跨主体借用：时长数字在引用里但挂在另一件事上时判定不通过', () => {
    // 群像式幻觉的典型产物：模型把价保**申请时限**的 15 天，答成退款**到账时效**。
    // 答案句主体是「退差价/到账」，引用句主体是「商品/降价/价保」——
    // GENERIC_MODIFIERS 挡掉「一般」、数字片段被过滤后，两句没有真正的主体词共现 → 判借用。
    const bad = checkOutput({
      answer: '退差价一般 15 天就能到账。',
      citations: citation('一般商品：签收后 15 天内降价可申请价保。'),
    });
    expect(bad.passed).toBe(false);
    expectViolation(
      bad.violations.map((v) => v.code),
      'ungrounded_claim',
    );
    expect(
      bad.violations.find((v) => v.code === 'ungrounded_claim')?.matched,
    ).toBe('15天');
  });

  it('已知局限：共享时长单位片段时会漏判（词法判据的天花板，不假装已解决）', () => {
    // 「天内」是时长单位的滑窗残留，两句都含它 → 被当成主体共现而放行。
    // 这正是 coverage.ts 实测失败的同一条死路：词法共现分不清「同一主体的哪个属性」。
    // 本测试钉的是「我们知道它在哪失效」，而不是「它不会失效」。
    const leak = checkOutput({
      answer: '退款 15 天内到账。',
      citations: citation('价保周期：一般商品签收后 15 天内可申请。'),
    });
    expect(leak.violations.some((v) => v.code === 'ungrounded_claim')).toBe(
      false,
    );
  });

  it('同主体引用不误杀：数字所在句的主体与引用句一致', () => {
    const ok = checkOutput({
      answer: '价保申请需在签收后 15 天内提交。',
      citations: citation('一般商品：签收后 15 天内降价可申请价保。'),
    });
    expect(ok.violations.some((v) => v.code === 'ungrounded_claim')).toBe(
      false,
    );
  });

  it('答案句抽不出主体词时不判借用（判不了就放行，防大面积误杀）', () => {
    // 纯数字句没有主体词可锚定，此时宁可漏判也不误杀——
    // coverage.ts 的实测教训：词法判据的弃权率降不到 0，硬判会大面积误伤。
    const result = checkOutput({
      answer: '15。',
      citations: citation('价保周期：签收后 15 天内可申请。'),
    });
    expect(result.violations.some((v) => v.code === 'ungrounded_claim')).toBe(
      false,
    );
  });

  it('有知识上下文却零引用时 fail-closed 拦截', () => {
    const result = checkOutput({
      answer: '根据您的情况，退款会尽快处理。',
      citations: [],
      hasKnowledgeContext: true,
    });
    expect(result.passed).toBe(false);
    expectViolation(
      result.violations.map((v) => v.code),
      'missing_citation',
    );
  });

  it('工具直答 / FAQ 等无知识上下文路径不因缺引用被误杀', () => {
    const result = checkOutput({
      answer: '您的订单已发货，预计明天送达。',
      citations: [],
      hasKnowledgeContext: false,
    });
    expect(result.violations.some((v) => v.code === 'missing_citation')).toBe(
      false,
    );
  });

  it('Reviewer 把缺引用作为确定性违规短路（不消耗终审模型）', async () => {
    const model = createFakeLlm({
      reply: JSON.stringify({ passed: true, violations: [] }),
    });
    const reviewer = new Reviewer({ llm: model, maxAttempts: 2 });
    const verdict = await reviewer.review({
      answer: '退款一般 3 天到账。',
      citations: [],
      hasKnowledgeContext: true,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.source).toBe('deterministic');
    expect(model.callsFor('review')).toHaveLength(0);
  });
});
