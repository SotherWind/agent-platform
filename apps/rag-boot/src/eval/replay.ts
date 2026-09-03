import type { EvaluationFixture, ReplayCall, ReplayObservation } from "./types";

export interface FakeExternalServices {
  replay(call: ReplayCall, fixture: EvaluationFixture): ReplayObservation;
  readonly calls: readonly ReplayCall[];
}

function hashSeed(seed: number, value: string): number {
  let hash = seed | 0;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function createFakeExternalServices(seed: number): FakeExternalServices {
  const calls: ReplayCall[] = [];

  return {
    calls,
    replay(call, fixture) {
      if (call.seed !== seed) throw new Error(`Replay seed mismatch: expected ${seed}, got ${call.seed}`);
      calls.push(call);
      const replayToken = `${seed.toString(16)}-${hashSeed(seed, fixture.id).toString(16)}`;
      return { ...fixture.replay, seed, replayToken };
    },
  };
}
