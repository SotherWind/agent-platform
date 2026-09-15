import { Table } from "antd";
import * as echarts from "echarts";
import { useEffect, useMemo, useRef } from "react";
import type { ChartSpec } from "../../model/types";
import "./styles.css";

interface ChartPanelProps {
  spec: ChartSpec;
}

export function ChartPanel({ spec }: ChartPanelProps) {
  if (spec.type === "table") {
    return <TableChart spec={spec} />;
  }
  if (!spec.option) return null;
  return <EchartsChart spec={spec} />;
}

function TableChart({ spec }: ChartPanelProps) {
  const dataset = spec.dataset;
  if (!dataset?.columns.length) return null;
  const columns = dataset.columns.map((column) => ({
    title: column,
    dataIndex: column,
    key: column,
  }));
  const dataSource = dataset.rows.map((row, index) => {
    const record: Record<string, unknown> = { key: index };
    dataset.columns.forEach((column, columnIndex) => {
      record[column] = row[columnIndex];
    });
    return record;
  });
  return (
    <div className="ask-chart">
      <p className="ask-chart__title">{spec.title}</p>
      <Table
        size="small"
        pagination={false}
        columns={columns}
        dataSource={dataSource}
      />
    </div>
  );
}

function EchartsChart({ spec }: ChartPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const option = useMemo(() => spec.option ?? {}, [spec.option]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = echarts.init(host);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option as echarts.EChartsCoreOption, {
      notMerge: true,
    });
  }, [option]);

  return (
    <div className="ask-chart">
      <div ref={hostRef} className="ask-chart__canvas" role="img" aria-label={spec.title} />
    </div>
  );
}
