import type { SloAlert } from "../runtime/slo.js";

export interface AlertSink {
  notify(alert: SloAlert, context?: Record<string, unknown>): Promise<void>;
}

export class ConsoleAlertSink implements AlertSink {
  async notify(
    alert: SloAlert,
    context?: Record<string, unknown>,
  ): Promise<void> {
    console.warn(
      "[slo:alert]",
      JSON.stringify({ ...alert, context: context ?? {} }),
    );
  }
}

/** HTTP webhook 告警：POST JSON；失败仅记日志不抛出（避免影响主路径） */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly webhookUrl: string,
    private readonly next?: AlertSink,
  ) {}

  async notify(
    alert: SloAlert,
    context?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "bi-analyst",
          alert,
          context: context ?? {},
        }),
      });
    } catch (err) {
      console.error(
        "[slo:alert:webhook-failed]",
        err instanceof Error ? err.message : String(err),
      );
    }
    await this.next?.notify(alert, context);
  }
}

export function createAlertSink(env: NodeJS.ProcessEnv = process.env): AlertSink {
  const consoleSink = new ConsoleAlertSink();
  const url = env.SLO_ALERT_WEBHOOK_URL;
  if (url) {
    return new WebhookAlertSink(url, consoleSink);
  }
  return consoleSink;
}
