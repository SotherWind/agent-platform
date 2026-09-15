import { useEffect, useRef, useState } from "react";

/**
 * 打字机文本：把"目标文本"按稳定节奏逐字显示。
 *
 * 与流式配合的关键：目标文本在流式过程中会不断变长（text prop 持续增长），
 * 组件只负责"追上"当前目标；每帧按待显示量自适应提速（落后越多吐得越快），
 * 因此既不会卡住等待，也不会因为一次收到一大块而整段蹦出。
 *
 * @param text   目标文本（可随时间增长）
 * @param active 是否处于打字中（false 时不显示光标）
 * @param charsPerTick 每帧基准字符数（决定打字速度）
 */
interface Props {
  text: string;
  active?: boolean;
  charsPerTick?: number;
  tickMs?: number;
  /** 已显示内容追平当前目标文本时触发（流式场景 = 模型缓冲耗尽，等待终审/下一段） */
  onCaughtUpChange?: (caughtUp: boolean) => void;
}

export default function TypewriterText({
  text,
  active = false,
  charsPerTick = 3,
  tickMs = 20,
  onCaughtUpChange,
}: Props) {
  const [shown, setShown] = useState("");
  const shownRef = useRef("");

  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  useEffect(() => {
    // 目标文本被清空（新会话 / 重置）时同步清空已显示内容
    if (text.length === 0) {
      setShown("");
      return;
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    const step = () => {
      setShown((current) => {
        // 目标被整体替换（如安全策略 replace 事件）：清空重来
        if (!text.startsWith(current)) return "";
        if (current.length >= text.length) return current;
        // 落后越多，这一帧吐得越快——保证总能追上最新文本
        const pending = text.length - current.length;
        const take = Math.max(1, Math.min(pending, Math.ceil(charsPerTick + pending / 12)));
        return text.slice(0, current.length + take);
      });
    };

    timer = setInterval(() => {
      step();
      // 已经追平且流已结束：停表，避免无谓的定时器
      if (shownRef.current.length >= text.length && !active) {
        if (timer) clearInterval(timer);
        timer = undefined;
      }
    }, tickMs);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [text, active, charsPerTick, tickMs]);

  const done = shown.length >= text.length;
  const caughtUp = done && active;

  // 追平状态通知（供父级显示"审查中"等提示）；回调引用不稳定时不会造成死循环
  const onCaughtUpRef = useRef(onCaughtUpChange);
  useEffect(() => {
    onCaughtUpRef.current = onCaughtUpChange;
  }, [onCaughtUpChange]);
  useEffect(() => {
    onCaughtUpRef.current?.(caughtUp);
  }, [caughtUp]);

  const showCursor = active || !done;

  return (
    <span className="typewriter">
      <span>{shown}</span>
      {showCursor ? <span className="typewriter-cursor" aria-hidden="true" /> : null}
    </span>
  );
}
