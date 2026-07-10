export let passed = 0;
export let skipped = 0;

export async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

export function section(title: string) {
  console.log(`\n▶ ${title}`);
}

export function addSkipped(count: number) {
  skipped += count;
}

export function resetStats() {
  passed = 0;
  skipped = 0;
}
