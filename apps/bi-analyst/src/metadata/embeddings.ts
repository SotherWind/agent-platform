import { createHash } from "node:crypto";

export interface EmbeddingProvider {
  readonly modelVersion: string;
  readonly vectorSize: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** 测试/离线用：从文本哈希生成确定性向量，无需 LLM 或网络 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = "deterministic-v1";
  readonly vectorSize: number;

  constructor(vectorSize = 64) {
    this.vectorSize = vectorSize;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.vectorSize).fill(0);
    const normalized = text.toLowerCase();

    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      vector[i % this.vectorSize] += code / 255;
    }

    const hash = createHash("sha256").update(normalized).digest();
    for (let i = 0; i < this.vectorSize; i++) {
      vector[i] += hash[i % hash.length] / 255;
    }

    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}
