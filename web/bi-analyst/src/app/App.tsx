import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AskDataPage } from "../features/ask-data/AskDataPage";

export function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "oklch(0.48 0.175 10)",
          colorText: "oklch(0.22 0.025 10)",
          borderRadius: 8,
          fontFamily: "inherit",
        },
      }}
    >
      <AntApp>
        <AskDataPage />
      </AntApp>
    </ConfigProvider>
  );
}
