import type { RetrievalScope } from "./type";

export const KNOWLEDGE_SCOPE_KEYS = ["products", "regions", "roles", "permissions"] as const;

export function normalizeKnowledgeScope(scope: RetrievalScope = {}) {
  const sorted = (values?: readonly string[]) => [...new Set(values ?? [])].sort();
  return {
    products: sorted(scope.products), regions: sorted(scope.regions),
    roles: sorted(scope.roles), permissions: sorted(scope.permissions),
  };
}

/** Missing/empty restrictions are tenant-public; malformed restrictions fail closed. */
export function matchesKnowledgeScope(metadata: Record<string, unknown>, scope: RetrievalScope = {}): boolean {
  return KNOWLEDGE_SCOPE_KEYS.every((key) => {
    const required = metadata[key];
    if (required === undefined || required === null) return true;
    if (!Array.isArray(required) || required.some((value) => typeof value !== "string")) return false;
    if (required.length === 0) return true;
    const granted = scope[key] ?? [];
    return key === "permissions"
      ? required.every((value) => granted.includes(value))
      : required.some((value) => granted.includes(value));
  });
}
