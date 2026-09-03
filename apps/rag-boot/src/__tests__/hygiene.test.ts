// T0.2 清理副本文件（工程卫生）
// 验收：src 下不存在带 copy 的文件；tsc --noEmit 无新增报错
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

describe("工程卫生", () => {
  it("src 下不存在带 copy 的文件", () => {
    const files = readdirSync(join(import.meta.dirname, ".."));
    expect(files.filter((f) => /copy/i.test(f))).toEqual([]);
  });

  it("src 下的文件名不含空格（部分工具链对空格文件名不友好）", () => {
    const files = readdirSync(join(import.meta.dirname, ".."));
    expect(files.filter((f) => f.includes(" ") && statSync(join(import.meta.dirname, "..", f)).isFile())).toEqual([]);
  });
});
