import { AuthError } from "../auth/principal.js";



export type ClarificationChoiceKind = "datasource" | "metric" | "range";



export interface ParsedClarificationChoice {

  kind: ClarificationChoiceKind;

  /** 完整选项 ID，如 datasource.ecommerce_sqlite */

  id: string;

  /** 去掉前缀后的值，如 ecommerce_sqlite */

  value: string;

}



const CHOICE_PREFIX_RE = /^(datasource|metric|range)\.(.+)$/;



/** 解析并校验澄清选项 ID；非法格式 fail closed */

export function parseClarificationChoice(

  raw: unknown,

): ParsedClarificationChoice | undefined {

  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== "string") {

    throw new AuthError("clarificationChoice 必须为字符串", "unauthenticated");

  }

  const trimmed = raw.trim();

  if (!trimmed) return undefined;



  const match = trimmed.match(CHOICE_PREFIX_RE);

  if (!match) {

    throw new AuthError(

      "clarificationChoice 格式无效，须为 datasource.* / metric.* / range.*",

      "unauthenticated",

    );

  }



  const kind = match[1] as ClarificationChoiceKind;

  const value = match[2]!.trim();

  if (!value) {

    throw new AuthError("clarificationChoice 值不能为空", "unauthenticated");

  }



  return { kind, id: `${kind}.${value}`, value };

}


