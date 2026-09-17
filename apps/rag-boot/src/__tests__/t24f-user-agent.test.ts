/**
 * 用户子智能体（"不知道答案的真实用户"当标签）的测试。
 *
 * 这里的关键用例是**机械性**的，不依赖某次实验的具体数字：
 * 用户的判断一旦与分数排序不一致（说"答上了"的那条分数反而更低），
 * 照它选的阈值就无解，而按构造真值评估会漏掉全部应转人工的样本。
 * 那条性质是把"用户判断不能当标签"变成可回归断言的落点。
 */
import { describe, expect, it } from "vitest";

import {
  baselineEvaluation,
  compareUserLabels,
  floorFromUserLabels,
  parseUserVerdict,
  PERSONA_SPECS,
  userVerdictPrompt,
  USER_VERDICT_SYSTEM,
  type UserLabelCase,
  type UserPersona,
} from "../confidence/user-agent";

const verdict = (answered: boolean, addressed = answered, reason = "") => ({
  answered,
  addressedMyQuestion: addressed,
  reason,
});

const sample = (
  id: string,
  persona: UserPersona,
  shouldEscalate: boolean,
  topScore: number,
  answered: boolean,
): UserLabelCase => ({
  id,
  question: "q",
  shouldEscalate,
  topScore,
  answer: "a",
  persona,
  verdict: verdict(answered),
});

describe("用户判断的解析", () => {
  it("从带前后缀的输出里抠出 JSON", () => {
    const parsed = parseUserVerdict(
      '好的，我的判断是：{"answered": true, "addressedMyQuestion": false, "reason": "有点绕"} 就这样',
    );
    expect(parsed?.answered).toBe(true);
    expect(parsed?.addressedMyQuestion).toBe(false);
    expect(parsed?.reason).toBe("有点绕");
  });

  it("缺 addressedMyQuestion 时保守跟随 answered，不凭空造出'没答到点上'", () => {
    expect(parseUserVerdict('{"answered": false}')?.addressedMyQuestion).toBe(false);
    expect(parseUserVerdict('{"answered": true}')?.addressedMyQuestion).toBe(true);
  });

  it("解析不了就返回 null，由调用方跳过而不是猜一个", () => {
    expect(parseUserVerdict("我觉得还行")).toBeNull();
    expect(parseUserVerdict('{"answered": "yes"}')).toBeNull();
    expect(parseUserVerdict("")).toBeNull();
  });
});

describe("人格设定", () => {
  it("system 里明确写'你不知道正确答案'——这是让它做真实用户的前提", () => {
    // 注意这句在 system 里，不在 user prompt 里：prompt 只带人格 + 问题 + 回答
    expect(USER_VERDICT_SYSTEM).toContain("你不知道正确答案");

    const prompt = userVerdictPrompt({ persona: "plain", question: "q", answer: "a" });
    expect(prompt).toContain("answered");
    expect(prompt).toContain("addressedMyQuestion");
    // 用户看得到的只有问题和回答，看不到知识库
    expect(prompt).toContain("【我问的问题】");
    expect(prompt).toContain("【客服给我的回答】");
  });

  it("挑剔人格被明确要求核对'有没有正面回答你问的那件事'（所以它其实是评委）", () => {
    expect(PERSONA_SPECS.skeptical.brief).toContain("正面回答");
    expect(PERSONA_SPECS.plain.brief).not.toContain("正面回答");
  });
});

describe("用户判断与构造真值的一致性", () => {
  it("分母分人格统计，不会因为另一种人格掉样本而算出 7.5 这种数", () => {
    const cases = [
      sample("a", "plain", true, 0.9, true),
      sample("b", "plain", true, 0.8, false),
      sample("c", "plain", false, 0.7, true),
      // 挑剔人格少一条（模拟解析失败被跳过）
      sample("a", "skeptical", true, 0.9, false),
      sample("c", "skeptical", false, 0.7, true),
    ];
    const [plain, skeptical] = compareUserLabels(cases);

    expect(plain?.unanswerableTotal).toBe(2);
    expect(plain?.answerableTotal).toBe(1);
    expect(plain?.reportedAnsweredOnUnanswerable).toBe(1);
    expect(plain?.reportedAnsweredOnUnanswerableRate).toBeCloseTo(0.5, 4);

    expect(skeptical?.unanswerableTotal).toBe(1);
    expect(skeptical?.answerableTotal).toBe(1);
    expect(skeptical?.reportedAnsweredOnUnanswerable).toBe(0);
  });

  it("两个方向分别统计：漏标（答不了却说答上了）与过判（答得了却说没答上）", () => {
    const cases: UserLabelCase[] = [
      sample("a", "plain", true, 0.9, true), // 漏标
      sample("b", "plain", true, 0.8, false),
      sample("c", "plain", false, 0.7, false), // 过判
      sample("d", "plain", false, 0.6, true),
    ];
    const [plain] = compareUserLabels(cases);

    expect(plain?.reportedAnsweredOnUnanswerable).toBe(1);
    expect(plain?.reportedUnansweredOnAnswerable).toBe(1);
    // 一致 2 条 / 4 条
    expect(plain?.agreementOnAnswered).toBeCloseTo(0.5, 4);
  });
});

describe("照用户标签选阈值", () => {
  it("用户判断与分数排序一致时，能选出一个可用的阈值", () => {
    const cases: UserLabelCase[] = [
      sample("n1", "plain", false, 0.9, true),
      sample("n2", "plain", false, 0.8, true),
      sample("p1", "plain", true, 0.5, false),
      sample("p2", "plain", true, 0.4, false),
    ];
    const [derived] = floorFromUserLabels(cases);

    expect(derived?.band.separable).toBe(true);
    expect(derived?.derivedFloor).toBeCloseTo(0.65, 4);
    expect(derived?.evaluation.missed).toBe(0);
    expect(derived?.evaluation.falseAlarm).toBe(0);
  });

  /**
   * 这是核心用例，也是实测里真实发生的情形：
   * 在**同一类**（都答不了）里，用户对分数低的那条说"答上了"、对分数高的那条说"没答上"。
   * 用户判断与分数排序一冲突，照它选阈值就无解——**这正是"用户标签不是有效的监督信号"的落点**：
   * 它不是一个更差的标签，而是一个**和特征不同向**的标签。
   */
  it("用户判断与分数排序冲突时：选不出阈值，且按真值评估会漏掉全部", () => {
    const cases: UserLabelCase[] = [
      sample("n1", "plain", false, 0.9, true),
      // 答不了、但用户说答上了 → 被当成负类
      sample("p-low", "plain", true, 0.2, true),
      // 答不了、用户说没答上 → 留在正类
      sample("p-high", "plain", true, 0.8, false),
    ];
    const [derived] = floorFromUserLabels(cases);

    expect(derived?.band.separable).toBe(false);
    expect(derived?.derivedFloor).toBeNull();
    // 无解时评估退化为"一条都没拦"，所以真值里的两个正类全漏
    expect(derived?.evaluation.missed).toBe(2);
    expect(derived?.evaluation.missRate).toBe(1);
  });

  it("用户全部说'答上了'时正类为空，不产出阈值（而不是给出一个好看的数）", () => {
    const cases: UserLabelCase[] = [
      sample("n1", "plain", false, 0.9, true),
      sample("p1", "plain", true, 0.1, true),
    ];
    const [derived] = floorFromUserLabels(cases);
    expect(derived?.derivedFloor).toBeNull();
    expect(derived?.band.reason).toContain("没有正类样本");
  });

  it("两种人格各出一份结果，便于对照", () => {
    const cases: UserLabelCase[] = [
      sample("n1", "plain", false, 0.9, true),
      sample("p1", "plain", true, 0.4, false),
      sample("n1", "skeptical", false, 0.9, false), // 挑剔人格过判
      sample("p1", "skeptical", true, 0.4, false),
    ];
    const results = floorFromUserLabels(cases);
    expect(results.map((r) => r.persona).sort()).toEqual(["plain", "skeptical"]);
  });
});

describe("基线对照", () => {
  it("按 id 去重：同一问题在两种人格下各有一行，不能重复计数", () => {
    const cases: UserLabelCase[] = [
      sample("n1", "plain", false, 0.9, true),
      sample("n1", "skeptical", false, 0.9, true),
      sample("p1", "plain", true, 0.2, false),
      sample("p1", "skeptical", true, 0.2, false),
    ];
    const baseline = baselineEvaluation(cases, { floor: 0.35 });

    // 去重后是 1 负 1 正；floor=0.35 → 正类被判低置信（正确），负类放行（正确）
    expect(baseline.falseAlarm).toBe(0);
    expect(baseline.missed).toBe(0);
    expect(baseline.falseAlarmRate).toBe(0);
    expect(baseline.missRate).toBe(0);
  });

  it("空输入不产生 NaN", () => {
    const baseline = baselineEvaluation([], { floor: 0.35 });
    expect(baseline.falseAlarmRate).toBe(0);
    expect(baseline.missRate).toBe(0);
  });
});
