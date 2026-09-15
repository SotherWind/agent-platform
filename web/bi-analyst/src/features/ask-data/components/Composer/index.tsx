import { Button, Input } from "antd";
import { useState, type KeyboardEvent } from "react";
import "./styles.css";

interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ busy, disabled, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setValue("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="ask-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input.TextArea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="用一句话问数据"
        autoSize={{ minRows: 2, maxRows: 6 }}
        disabled={disabled}
        aria-label="问数输入"
      />
      {busy ? (
        <Button type="primary" htmlType="button" onClick={onStop}>
          停止生成
        </Button>
      ) : (
        <Button type="primary" htmlType="submit" disabled={disabled || !value.trim()}>
          发送问题
        </Button>
      )}
    </form>
  );
}
