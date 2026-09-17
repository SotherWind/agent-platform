/**
 * 用户子智能体：真的开一个"不知道答案"的用户去用系统，然后把它当标签会怎样。
 *
 * ## 这个模块要回答的质疑
 *
 * "你可以开一个子智能体让它做真实用户，它又不知道答案。"
 *
 * 这条质疑是对的——**它确实是一个真实用户**。所以问题不在身份，而在**这个标签测的是什么量**：
 *
 * - 用户能提供的信号：**"这段回答看起来回答了我的问题吗"**（只看得到答案文本）
 * - 闸门需要的标签：**"知识库里到底有没有答案"**
 *
 * 两者在容易的样本上一致（知识库完全没有 → 回答含糊 → 用户说没答上；
 * 答案明确 → 用户说答上了），在**最要紧的那批上分道扬镳**：
 * 检索捞到一堆写法相近的邻章、模型拿它拼出一段笃定回答 → 用户说"答上了"，
 * 而知识库其实给不出那一点。**这批样本恰恰是闸门存在的唯一理由。**
 *
 * 所以本模块把这件事**测出来**，而不是论证：
 *
 * 1. `userVerdict`：人格化的用户子智能体，只看（问题 + 回答），不给知识库，
 *    判断"我有没有得到我想要的答案"。给两个人格是为了隔离"是不是只是人格太宽容"这个变量
 *    ——同一条回答分别喂给普通客户和挑剔客户。
 * 2. `compareUserLabels`：把用户判断与**构造真值**（消融）对照，算出不一致率。
 * 3. `floorFromUserLabels`：**按提案本身的做法**——拿 `!userSatisfied` 当 `shouldEscalate`，
 *    去选一个阈值，再把这个阈值拿回构造真值上评估。这是最直接的检验：
 *    如果照它选出来的阈值比现役基线更差，那这个提案就被它自己的口径否掉了。
 *
 * ## 设计上刻意"向着提案"
 *
 * - 问法直接问"有没有回答**你的问题**"，而不是"你满不满意"——后者会把
 *   "答非所问"漏掉，等于故意把用户智能体做笨。
 * - 明确告诉它"你不知道正确答案，只能凭回答本身判断"，避免它假装知道。
 * - 把"答得对不对"和"答没答到点上"分开问，让它可以只因为"没答到点上"就判否。
 *
 * 这样测出来的不一致率是**下限**：真实用户比这更宽松，不会更严。
 */
import { z } from "zod/v4";

import type { ConfidencePolicy } from "./profile";
import { decisionBand, topOf, type DecisionBand } from "./margin";
import type { LabeledCaseWithChunks } from "./calibration";

/**
 * 用户人格。
 *
 * 两个人格**不是**为了模拟用户多样性，而是为了做对照：如果换成明显更挑剔的人格之后
 * 结论不变，就说明问题不在"人格太宽容"，而在"信息本身不够"。
 */
export const UserPersonaSchema = z.enum(["plain", "skeptical"]);
export type UserPersona = z.infer<typeof UserPersonaSchema>;

export const PERSONA_SPECS: Record<UserPersona, { label: string; brief: string }> = {
  plain: {
    label: "普通客户",
    brief:
      "你是这位客户的本人。你只是想解决问题，看不懂的地方会跳过，看到具体数字会觉得踏实。" +
      "你没有耐心，不会逐句核对，只要回答不像在敷衍你，你一般就认为问题解决了。",
  },
  skeptical: {
    label: "挑剔客户",
    brief:
      "你是这位客户的本人，而且你很难缠。你会逐句看回答有没有**正面回答你问的那件事**，" +
      "发现它在讲别的东西、或者绕开你的问题，你就会认为没解决。" +
      "你对含糊其辞和泛泛而谈非常敏感。",
  },
};

export const USER_VERDICT_SYSTEM =
  "你现在扮演一位客户。你只知道你自己的问题和客服给你的回答，" +
  "**你不知道正确答案是什么**，也没有任何资料可查。你只能根据这段回答本身，" +
  "判断它有没有回答你的问题。只输出 JSON。";

/** 用户子智能体看到的（也只有这些）：问题 + 系统回答 */
export function userVerdictPrompt(input: {
  persona: UserPersona;
  question: string;
  answer: string;
}): string {
  return [
    PERSONA_SPECS[input.persona].brief,
    "",
    "【我问的问题】",
    input.question,
    "",
    "【客服给我的回答】",
    input.answer,
    "",
    "请只输出这个 JSON，不要任何其他文字：",
    '{"answered": true/false, "addressedMyQuestion": true/false, "reason": "一句话说明"}',
    "",
    "说明：",
    "- answered：你认为你的问题被解决了吗；",
    "- addressedMyQuestion：这段回答有没有在讲你问的那件事（可以 answered=true 但这里是 false，" +
      "如果你觉得它答得含糊但你也认了的话）。",
  ].join("\n");
}

export const UserVerdictSchema = z.object({
  /** 用户认为问题被解决了 */
  answered: z.boolean(),
  /** 用户认为回答在讲他问的那件事 */
  addressedMyQuestion: z.boolean(),
  reason: z.string().default(""),
});
export type UserVerdict = z.infer<typeof UserVerdictSchema>;

/** 宽松解析：容忍模型在 JSON 外面多写话，或漏字段 */
export function parseUserVerdict(raw: string): UserVerdict | null {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.answered !== "boolean") return null;
    return {
      answered: parsed.answered,
      // 缺字段时保守地跟随 answered，避免把"没答到点上"凭空算出来
      addressedMyQuestion:
        typeof parsed.addressedMyQuestion === "boolean"
          ? parsed.addressedMyQuestion
          : parsed.answered,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

/** 一条样本：构造真值 + 两种条件下系统的表现 + 用户判断 */
export interface UserLabelCase {
  id: string;
  question: string;
  /** 构造真值：true = 承载答案的那一节已被消融，知识库给不出答案 */
  shouldEscalate: boolean;
  /** 该条件下系统的 topScore */
  topScore: number;
  /** 该条件下系统给出的回答（用户子智能体只看到这个） */
  answer: string;
  persona: UserPersona;
  verdict: UserVerdict;
}

export interface LabelAgreement {
  persona: UserPersona;
  total: number;
  /** 该人格下"答不了"的样本数（= 构造真值的正类数，分人格统计以免显示错分母） */
  unanswerableTotal: number;
  /** 该人格下"答得了"的样本数 */
  answerableTotal: number;
  /**
   * **关键数字**：本应转人工（知识库答不了）的问题里，用户却说"答上了"的比例。
   * 这就是把用户判断当标签时的**漏标**——闸门最该拦的一批被标成了"答得了"。
   */
  reportedAnsweredOnUnanswerable: number;
  reportedAnsweredOnUnanswerableRate: number;
  /** 反向：知识库答得了，用户却说没答上 */
  reportedUnansweredOnAnswerable: number;
  reportedUnansweredOnAnswerableRate: number;
  /** 用户判断与构造真值的一致率（分两个口径） */
  agreementOnAnswered: number;
  agreementOnAddressed: number;
}

/** 把用户判断与构造真值对照 */
export function compareUserLabels(cases: UserLabelCase[]): LabelAgreement[] {
  const personas = [...new Set(cases.map((c) => c.persona))];
  const rate = (part: number, whole: number) => (whole === 0 ? 0 : Number((part / whole).toFixed(4)));

  return personas.map((persona) => {
    const rows = cases.filter((c) => c.persona === persona);
    const unanswerable = rows.filter((row) => row.shouldEscalate);
    const answerable = rows.filter((row) => !row.shouldEscalate);

    const answeredOnUnanswerable = unanswerable.filter((row) => row.verdict.answered).length;
    const unansweredOnAnswerable = answerable.filter((row) => !row.verdict.answered).length;

    // 一致率：真值"该转人工" ⟺ 用户"没答上"
    const agreeAnswered = rows.filter((row) => row.shouldEscalate !== row.verdict.answered).length;
    const agreeAddressed = rows.filter(
      (row) => row.shouldEscalate !== row.verdict.addressedMyQuestion,
    ).length;

    return {
      persona,
      total: rows.length,
      unanswerableTotal: unanswerable.length,
      answerableTotal: answerable.length,
      reportedAnsweredOnUnanswerable: answeredOnUnanswerable,
      reportedAnsweredOnUnanswerableRate: rate(answeredOnUnanswerable, unanswerable.length),
      reportedUnansweredOnAnswerable: unansweredOnAnswerable,
      reportedUnansweredOnAnswerableRate: rate(unansweredOnAnswerable, answerable.length),
      agreementOnAnswered: rate(agreeAnswered, rows.length),
      agreementOnAddressed: rate(agreeAddressed, rows.length),
    };
  });
}

export interface UserLabelFloor {
  persona: UserPersona;
  /** 按提案做法（`!answered` 当 shouldEscalate）算出的决策带 */
  band: DecisionBand;
  /** 该带的中点，即"照用户标签选出来的阈值" */
  derivedFloor: number | null;
  /** 把这个阈值拿回**构造真值**上评估的结果 */
  evaluation: {
    falseAlarm: number;
    missed: number;
    falseAlarmsAllowed: number;
    missesAllowed: number;
    falseAlarmRate: number;
    missRate: number;
  };
}

/**
 * 按提案本身的做法选阈值，再拿回构造真值评估。
 *
 * 这是对"用用户子智能体当标签"最直接的检验——不提任何理论，
 * 只说：照你的标签选出来的阈值，按真值看表现如何。
 */
export function floorFromUserLabels(
  cases: UserLabelCase[],
  options: { useAddressed?: boolean } = {},
): UserLabelFloor[] {
  const personas = [...new Set(cases.map((c) => c.persona))];
  const rate = (part: number, whole: number) => (whole === 0 ? 0 : Number((part / whole).toFixed(4)));
  const key = options.useAddressed ? "addressedMyQuestion" : "answered";

  return personas.map((persona) => {
    const rows = cases.filter((c) => c.persona === persona);

    // 照提案：用户说"没答上"就当作应该转人工
    const labeled: LabeledCaseWithChunks[] = rows.map((row) => ({
      id: row.id,
      score: row.topScore,
      shouldEscalate: row.verdict[key] === false,
      chunkScores: [row.topScore],
    }));
    const band = decisionBand(labeled);
    const derivedFloor = band.midpoint;

    // 拿回构造真值评估
    const truth = rows.filter((row) => row.shouldEscalate);
    const negatives = rows.filter((row) => !row.shouldEscalate);
    const evaluate = (rowsToJudge: UserLabelCase[]) =>
      derivedFloor === null ? 0 : rowsToJudge.filter((row) => row.topScore < derivedFloor).length;
    const falseAlarm = evaluate(negatives);
    const missed = truth.length - evaluate(truth);

    return {
      persona,
      band,
      derivedFloor,
      evaluation: {
        falseAlarm,
        missed,
        falseAlarmsAllowed: negatives.length,
        missesAllowed: truth.length,
        falseAlarmRate: rate(falseAlarm, negatives.length),
        missRate: rate(missed, truth.length),
      },
    };
  });
}

/** 现役基线在同一批样本上的表现，用作对照 */
export function baselineEvaluation(
  cases: UserLabelCase[],
  policy: Pick<ConfidencePolicy, "floor">,
): { falseAlarm: number; missed: number; falseAlarmRate: number; missRate: number } {
  const unique = [...new Map(cases.map((c) => [c.id, c])).values()];
  const truth = unique.filter((row) => row.shouldEscalate);
  const negatives = unique.filter((row) => !row.shouldEscalate);
  const flagged = (rows: UserLabelCase[]) =>
    rows.filter((row) => topOf([row.topScore]) < policy.floor).length;
  const rate = (part: number, whole: number) => (whole === 0 ? 0 : Number((part / whole).toFixed(4)));

  return {
    falseAlarm: flagged(negatives),
    missed: truth.length - flagged(truth),
    falseAlarmRate: rate(flagged(negatives), negatives.length),
    missRate: rate(truth.length - flagged(truth), truth.length),
  };
}
