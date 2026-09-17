/**
 * 置信度 profile：把阈值从代码里的一个浮点数，变成「带标定出处 + 版本键」的配置产物。
 *
 * 为什么非要版本化：`0.35` 这个数只在标定它的那个条件下成立。
 * 换一版 rerank 模型（量纲平移）、知识库从 100 篇涨到 1 万篇（负样本变多变近）、
 * query 分布从商品咨询变成投诉工单（命中分布整体下移），这个数都会失效——
 * 而且是**静默失效**：代码能跑，测试能过，只有线上兜底率悄悄变了。
 *
 * 所以 profile 把「阈值」和「阈值成立的前提」绑在一起：前提对不上就标 stale，
 * 让失效浮出水面，而不是让一个过期常数继续当自然常数用。
 */
import { z } from "zod/v4";

/**
 * 置信度判决参数。computeConfidence 只认这一组数，不再认散落的魔法数。
 */
export const ConfidencePolicySchema = z.object({
  /**
   * 绝对下限：topScore < floor 视为「知识库里根本没有」。
   * 这是主闸门——它必须扛得住「候选集只有一条」这种被相对化洗成满分的场景。
   */
  floor: z.number().min(0).max(1).default(0.35),
  /**
   * 实心线：topScore >= solid 时，单条 chunk 就足以独立支撑回答，不再要求旁证。
   * 设这条线是为了避免把「一条强命中」误伤成低置信（旧实现用相对 coverage 扣了它的分）。
   */
  solid: z.number().min(0).max(1).default(0.55),
  /**
   * 区分度满值落差：top - min >= minRange 才算「模型能把这条和噪声区分开」。
   * 群像式幻觉的判据就在这里——一簇低分挤在一起时落差极小。
   */
  minRange: z.number().min(0).max(1).default(0.15),
  /** topScore < solid 时，过线 chunk 占比至少要这么多才算有旁证 */
  minSupportShare: z.number().min(0).max(1).default(0.5),
  /** 区分度低于该值且 top 处于 [floor, solid) → 判定为群像式幻觉 */
  flockDiscriminationMax: z.number().min(0).max(1).default(0.5),
  /** 少于这么多条时不判群像（两条样本判断不了分布形状） */
  flockMinChunks: z.number().int().min(2).default(3),
  /** 支撑度对 score 的乘性折扣强度 */
  coverageWeight: z.number().min(0).max(1).default(0.4),
});

export type ConfidencePolicy = z.infer<typeof ConfidencePolicySchema>;

export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = ConfidencePolicySchema.parse({});

export const ProfileKeySchema = z.object({
  /** 标定时的 reranker 模型名。换模型必须重标 */
  rerankerModel: z.string().min(1),
  /** 标定时的知识库版本号/快照名。库规模或语料分布变了必须重标 */
  kbVersion: z.string().min(1),
  /** 标定时的业务域，例如 "商品咨询" / "投诉工单" */
  domain: z.string().min(1),
});
export type ProfileKey = z.infer<typeof ProfileKeySchema>;

/**
 * 标签的出处。这一层区分决定了产出的阈值能不能被当成"已标定"。
 *
 * - `measured`：标签来自**真实结果**（人工接管记录、工单结案、用户否定/追认）。
 *   只有它配得上 `calibrated: true`。
 * - `constructed`：标签来自**构造**——题目是生成的，答案在不在库里由构造保证。
 *   它能定出类内分布与决策带，但流行度与"生产里负样本有多难"是我编的，
 *   所以只能产出 `provisional` 的先验，不能叫标定。
 * - `none`：没标过，用的保守默认值。
 *
 * 为什么要有这一层：跑了真实链路（真 embedding + 真 reranker）拿到的分数是**真的**，
 * 很容易让人误以为"整份数据都是真的"，于是把构造标签当实测标签用。
 * 分数量纲真、标签假，是最危险的组合——它会让 ROC 看起来很漂亮。
 */
export const CalibrationProvenanceSchema = z.enum(["measured", "constructed", "none"]);
export type CalibrationProvenance = z.infer<typeof CalibrationProvenanceSchema>;

export const ConfidenceProfileSchema = ConfidencePolicySchema.extend({
  /** profile 自身的语义版本，改动参数即递增 */
  profileVersion: z.string().min(1),
  rerankerModel: z.string().min(1),
  kbVersion: z.string().min(1),
  domain: z.string().min(1),
  /** 是否真的做过标定。false = 用的保守默认值，进 tracing 时会被显式标出 */
  calibrated: z.boolean().default(false),
  /**
   * 标签出处。`calibrated: true` 必须蕴含 `provenance: "measured"`——
   * 这条约束由下面的 refine 强制，让"拿构造数据冒充标定"在校验层就不可能发生。
   */
  provenance: CalibrationProvenanceSchema.default("none"),
  /**
   * 是否是由**构造数据**导出的先验。true 表示：值有数据支撑，但标签是构造的，
   * 只能当过渡值用，必须在拿到实测标签后重新标定。
   *
   * 与 `calibrated` 分开是为了让两者能各自保持诚实：`calibrated` 只回答
   * "标签是不是真的"，`provisional` 只回答"这个值能不能直接上线用"。
   */
  provisional: z.boolean().default(false),
  calibratedAt: z.string().nullable().default(null),
  /** 标定样本量。0 表示没标过 */
  sampleSize: z.number().int().min(0).default(0),
  metrics: z
    .object({
      auc: z.number().nullable().default(null),
      tpr: z.number().default(0),
      fpr: z.number().default(0),
      precision: z.number().default(0),
    })
    .default({ auc: null, tpr: 0, fpr: 0, precision: 0 }),
  /** 标定数据出处，例如 "handoff-2026Q1.jsonl@sha256:ab12" */
  source: z.string().default(""),
  /**
   * 样本外验证结果。
   *
   * `metrics` 是**标定集**上的成绩（会被选择偏差抬高）；`generalization` 是同一份策略在
   * **留出集**上的成绩，以及两者之差。没有它，一份 profile 的"召回 100%"无法区分
   * "真的强"还是"在这份标注集上恰好强"——这也正是网格能不能加细的前提。
   */
  generalization: z
    .object({
      validationSampleSize: z.number().int().min(0),
      tpr: z.number(),
      fpr: z.number(),
      precision: z.number(),
      /** 标定集召回 − 验证集召回（正 = 验证集更差） */
      tprGap: z.number(),
      /** 验证集误伤 − 标定集误伤 */
      fprGap: z.number(),
      overfitSuspect: z.boolean(),
      reasons: z.array(z.string()).default(() => []),
    })
    .nullable()
    .default(null),
}).superRefine((profile, ctx) => {
  // 守卫一：「已标定」只留给实测标签。
  // 没有这条，"跑了真实链路拿到真分数"就会被当成"标签也是真的"，
  // 于是构造数据能产出一份 calibrated=true 的 profile 并静默上线。
  if (profile.calibrated && profile.provenance !== "measured") {
    ctx.addIssue({
      code: "custom",
      path: ["provenance"],
      message:
        `calibrated=true 只允许 provenance="measured"（当前 "${profile.provenance}"）。` +
        `构造标签能定出类内分布与决策带，但不能定出流行度，` +
        `因此只允许产出 provisional=true 的先验。`,
    });
  }
  // 守卫二：provisional 只能是「构造数据导出的、且未标定」的状态
  if (profile.provisional && (profile.calibrated || profile.provenance !== "constructed")) {
    ctx.addIssue({
      code: "custom",
      path: ["provisional"],
      message:
        `provisional=true 要求 calibrated=false 且 provenance="constructed"` +
        `（当前 calibrated=${profile.calibrated}, provenance="${profile.provenance}"）`,
    });
  }
});
export type ConfidenceProfile = z.infer<typeof ConfidenceProfileSchema>;

/**
 * 未标定时的兜底 profile。
 *
 * 刻意保留「未标定」字样与 calibrated=false：
 * 一个没说清出处的阈值，和一条有标定记录的阈值，风险完全不同，配置里必须能一眼分辨。
 */
export const UNCALIBRATED_PROFILE: ConfidenceProfile = ConfidenceProfileSchema.parse({
  ...DEFAULT_CONFIDENCE_POLICY,
  profileVersion: "uncalibrated-default",
  rerankerModel: "any",
  kbVersion: "any",
  domain: "any",
  calibrated: false,
  provenance: "none",
  provisional: false,
  calibratedAt: null,
  sampleSize: 0,
  source: "",
});

export type ProfileMatch = "exact" | "domain" | "default";

export interface ProfileResolution {
  profile: ConfidenceProfile;
  /** 参数是否来自真实标定 */
  calibrated: boolean;
  /** 标签出处，用于区分「实测标定」与「构造数据先验」 */
  provenance: CalibrationProvenance;
  /** 是否只是构造数据导出的过渡先验（可上线试用，但必须被实测标定替换） */
  provisional: boolean;
  /** 是否在「前提已变」的情况下使用（换模型 / 换库 / 换域 / 只能退回默认） */
  stale: boolean;
  /** 失效原因，人话，可直接进日志与 tracing */
  staleReasons: string[];
  matchedBy: ProfileMatch;
}

/**
 * 按运行时前提（当前 reranker 模型、知识库版本、业务域）解析出该用哪份 profile。
 *
 * 匹配顺序：精确三元组 → 同域（标记 stale）→ 默认未标定 profile。
 * 注意这里**不会**因为找不到完全匹配就默默用旧的：只要不是精确匹配，就一定带 stale 标记。
 */
export function resolveProfile(
  profiles: ConfidenceProfile[] | undefined,
  key: ProfileKey,
): ProfileResolution {
  const list = profiles ?? [];

  const exact = list.find(
    (p) =>
      p.rerankerModel === key.rerankerModel &&
      p.kbVersion === key.kbVersion &&
      p.domain === key.domain,
  );
  if (exact) {
    return {
      profile: exact,
      calibrated: exact.calibrated,
      provenance: exact.provenance,
      provisional: exact.provisional,
      stale: false,
      staleReasons: exact.calibrated
        ? []
        : exact.provisional
          ? ["该 profile 由构造数据导出，是过渡先验，不是实测标定"]
          : ["该 profile 自身标记为未标定"],
      matchedBy: "exact",
    };
  }

  const sameDomain = list.find((p) => p.domain === key.domain);
  if (sameDomain) {
    const reasons: string[] = [];
    if (sameDomain.rerankerModel !== key.rerankerModel) {
      reasons.push(
        `reranker 已从 ${sameDomain.rerankerModel} 换到 ${key.rerankerModel}，分数量纲不可平移，阈值需重标`,
      );
    }
    if (sameDomain.kbVersion !== key.kbVersion) {
      reasons.push(
        `知识库版本已从 ${sameDomain.kbVersion} 变到 ${key.kbVersion}，命中分布会整体位移，阈值需重标`,
      );
    }
    if (reasons.length === 0) reasons.push("仅按业务域匹配到 profile，前提不完全一致");
    return {
      profile: sameDomain,
      calibrated: sameDomain.calibrated,
      provenance: sameDomain.provenance,
      provisional: sameDomain.provisional,
      stale: true,
      staleReasons: reasons,
      matchedBy: "domain",
    };
  }

  return {
    profile: UNCALIBRATED_PROFILE,
    calibrated: false,
    provenance: "none",
    provisional: false,
    stale: true,
    staleReasons: [
      `没有 ${key.domain} 域（reranker=${key.rerankerModel}, kb=${key.kbVersion}）的标定 profile，已退回保守默认值`,
    ],
    matchedBy: "default",
  };
}

/**
 * 供 tracing / 日志使用的紧凑标记。
 *
 * 形如 `exact/measured`、`exact/provisional`、`default/none/stale`。
 * 刻意把 provisional 显式打出来：一个"构造数据导出的先验"和一条"实测标定阈值"
 * 在日志里长得一样的话，没人会在意它其实还没被真数据验证过。
 */
export function describeResolution(resolution: ProfileResolution): string {
  const calibration =
    resolution.provenance === "measured"
      ? "measured"
      : resolution.provenance === "constructed"
        ? "provisional"
        : "uncalibrated";
  return `${resolution.matchedBy}/${calibration}${resolution.stale ? "/stale" : ""}`;
}

/**
 * 一次置信度判决的诊断快照，进 state、进 tracing、进交接包。
 *
 * 存在的意义是把「这个阈值哪来的、为什么这次判低置信」变成可查的数据：
 * 只留一个 confidence 数字，线上一旦兜底率变了根本没法归因——是分布漂移了，
 * 还是 profile 早就 stale 了，还是 flock 判据在误伤。
 */
export const ConfidenceDiagnosticsSchema = z.object({
  /** 生效的绝对下限 */
  threshold: z.number(),
  /** 生效的实心线 */
  solid: z.number(),
  topScore: z.number(),
  /** 绝对口径覆盖度 */
  coverage: z.number(),
  supportCount: z.number(),
  spread: z.number(),
  discrimination: z.number(),
  corroborated: z.boolean(),
  flockHallucination: z.boolean(),
  /** profile 匹配与标定状态，例如 "exact/measured" */
  profile: z.string(),
  profileVersion: z.string(),
  /** 该阈值是否只是构造数据导出的过渡先验（坐席与运维都该看见这一点） */
  provisional: z.boolean().default(false),
  /** 是否在前提已变的情况下沿用该 profile */
  stale: z.boolean(),
  staleReasons: z.array(z.string()).default(() => []),
});
export type ConfidenceDiagnostics = z.infer<typeof ConfidenceDiagnosticsSchema>;

