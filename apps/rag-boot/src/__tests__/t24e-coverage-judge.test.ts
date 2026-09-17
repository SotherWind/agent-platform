/**
 * 属性覆盖判据的测试。
 *
 * 这个文件最重要的作用不是"证明它好用"，而是**把一条被测量过的死路钉住**：
 * 该判据实测比基线更差（误伤 28.6% vs 26.2%，漏放 45.2% vs 26.2%），
 * 根因是"同一主体的另一个属性会满足词共现"。下面有一条用例专门复现这个根因——
 * 删掉它，下一个人还会重新提出同一个想法再撞一次。
 */
import { describe, expect, it } from "vitest";

import {
  assessCoverage,
  compareJudges,
  detectAskedAttributes,
  subjectTerms,
  type CoverageDecision,
} from "../confidence/coverage";

describe("属性识别", () => {
  it("从真实口语问句里认出被问的属性", () => {
    expect(detectAskedAttributes("买东西降价了，多久之内能申请退差价？").map((a) => a.type)).toEqual([
      "duration",
    ]);
    expect(detectAskedAttributes("偏远地区运费要加多少？").map((a) => a.type)).toEqual(["amount"]);
    expect(detectAskedAttributes("会员每月有几张无门槛券？").map((a) => a.type)).toEqual(["count"]);
    expect(detectAskedAttributes("注销账号有什么前提条件？").map((a) => a.type)).toEqual([
      "condition",
    ]);
    expect(detectAskedAttributes("支持货到付款吗？").map((a) => a.type)).toEqual(["capability"]);
  });

  it("主体词会滤掉疑问词与停用词", () => {
    const terms = subjectTerms("多久之内能申请退差价");
    expect(terms).not.toContain("多久");
    expect(terms).not.toContain("什么");
    // 真正的主体片段要留下
    expect(terms).toContain("差价");
    expect(terms).toContain("申请");
  });
});

describe("覆盖判定", () => {
  it("上下文里有时长取值且与主体共现 → 覆盖充分", () => {
    const result = assessCoverage(
      "退款多久能到账？",
      "退款方式：微信支付退回原卡，到账时效 1-3 个工作日。",
    );
    expect(result.assessable).toBe(true);
    expect(result.insufficient).toBe(false);
    expect(result.assessed[0]?.evidence).toContain("1-3 个工作日");
  });

  it("上下文里压根没有该属性的取值 → 判覆盖不足", () => {
    const result = assessCoverage(
      "退款多久能到账？",
      "平台支持微信、支付宝与银联卡付款，企业客户支持对公转账。",
    );
    expect(result.assessable).toBe(true);
    expect(result.insufficient).toBe(true);
    expect(result.reason).toContain("时长");
  });

  it("上下文里有该属性的取值，但谈的不是问题问的那件事 → 仍判覆盖不足", () => {
    // 上下文里确实有时长（48 小时），但那是发货时效，与"退款到账"无关。
    // 这一条是共现要求的承载测试：去掉主体词共现，它就会误判成"覆盖充分"。
    const result = assessCoverage("退款多久能到账？", "现货商品：付款后 48 小时内发货。");
    expect(result.assessable).toBe(true);
    expect(result.insufficient).toBe(true);
    // 注意断言的是**逐属性的** reason：汇总 reason 只笼统说"找不到取值"，
    // 而"有取值但不是谈这件事"这个关键区分只在逐属性说明里
    expect(result.assessed[0]?.reason).toContain("主体词未共现");
  });

  it("问法不在规则表内时明确弃权，而不是猜一个结论", () => {
    const result = assessCoverage("你们这个平台怎么样啊", "任意上下文。");
    expect(result.assessable).toBe(false);
    expect(result.insufficient).toBe(false);
    expect(result.reason).toContain("不表态");
  });

  it("只问到主体名时弃权——没有可靠词法特征，不假判定", () => {
    const result = assessCoverage("上门取件是哪家快递公司？", "退货可用免费上门取件。");
    expect(result.assessable).toBe(false);
    expect(result.reason).toContain("不表态");
  });

  /**
   * 这一条是**根因复现**，不是"期望行为"。
   *
   * 实测里最贵的一次漏放：问的是"退差价**多久能到账**"，而检索到的上下文里有
   * 「一般商品：签收后 15 天内降价可申请价保。」——主体词（申请）与属性（时长）都在同一句里，
   * 但那是**价保申请时限**，不是**退款到账时效**。词共现判不了"同一主体的哪个属性"，
   * 于是判成"覆盖充分"，把一条知识库其实答不了的问题放了过去。
   *
   * 断言写成"它确实会误判"是刻意的：这条用例的价值就在于拦住"再试一次词法判据"的念头。
   */
  it("已知失效：同一主体的另一个属性会冒充，判成覆盖充分（这是它更差的原因）", () => {
    const context = "一般商品：签收后 15 天内降价可申请价保。";
    const result = assessCoverage("买完降价了退差价多久能到账", context);

    // 判据认为覆盖充分……
    expect(result.assessable).toBe(true);
    expect(result.insufficient).toBe(false);
    // ……但证据句讲的是"申请时限"，不是"到账时效"。判据看不出这个区别。
    expect(result.assessed[0]?.evidence).toContain("15 天");
  });
});

describe("新旧判据对比", () => {
  const decision = (
    id: string,
    topScore: number,
    floor: number,
    newFlags: boolean | null,
  ): CoverageDecision => ({
    id,
    question: "q",
    topScore,
    oldFlags: topScore < floor,
    newFlags,
    coverage: {
      assessed: [],
      assessable: newFlags !== null,
      covered: newFlags === false,
      insufficient: newFlags === true,
      reason: "",
    },
  });

  it("弃权按回落旧判据计——不让弃权把数字做好看", () => {
    // 可答样本 top=0.9（旧判放行，正确），新判弃权 → 应沿用旧判的"放行"，不算误伤
    // 消融样本 top=0.02（旧判低置信，正确），新判弃权 → 同样沿用
    const rows = [
      { decision: decision("a", 0.9, 0.35, null), shouldEscalate: false },
      { decision: decision("b", 0.02, 0.35, null), shouldEscalate: true },
    ];
    const comparison = compareJudges(rows);

    expect(comparison.assessable).toBe(0);
    expect(comparison.abstainRate).toBe(1);
    expect(comparison.new.falseAlarm).toBe(comparison.old.falseAlarm);
    expect(comparison.new.missed).toBe(comparison.old.missed);
  });

  it("数出两个方向的错误率：误伤看可答样本，漏放看答不了样本", () => {
    const rows = [
      // 可答：一条被判低置信 → 误伤
      { decision: decision("a", 0.1, 0.35, true), shouldEscalate: false },
      // 可答：放行 → 正确
      { decision: decision("b", 0.8, 0.35, false), shouldEscalate: false },
      // 答不了：放行 → 漏放
      { decision: decision("c", 0.9, 0.35, false), shouldEscalate: true },
      // 答不了：判低置信 → 正确
      { decision: decision("d", 0.05, 0.35, true), shouldEscalate: true },
    ];
    const comparison = compareJudges(rows);

    expect(comparison.total).toBe(4);
    expect(comparison.old.falseAlarmRate).toBeCloseTo(0.5, 4);
    expect(comparison.old.missRate).toBeCloseTo(0.5, 4);
    expect(comparison.new.falseAlarmRate).toBeCloseTo(0.5, 4);
    expect(comparison.new.missRate).toBeCloseTo(0.5, 4);
  });

  it("空输入不产生 NaN", () => {
    const comparison = compareJudges([]);
    expect(comparison.total).toBe(0);
    expect(comparison.old.falseAlarmRate).toBe(0);
    expect(comparison.new.missRate).toBe(0);
  });
});
