import type { AccessPolicy } from "../policy/access-policy.js";
import type {
  ColumnReason,
  RetrievedSchema,
  SchemaDocument,
  SchemaDocType,
} from "./types.js";
import type { DialectFamily } from "../datasource/types.js";
import {
  filterByPolicy,
  rankAndEnrichResults,
  scoreDocument,
} from "./retriever-scoring.js";

export { scoreDocument, filterByPolicy, rankAndEnrichResults };

export interface SchemaSearchOptions {
  docType: SchemaDocType;
  datasourceId?: string;
  table?: string;
  tables?: string[];
  limit?: number;
  reviewStatus?: "approved";
}

export interface SchemaRetriever {
  search(
    query: string,
    options: SchemaSearchOptions,
    policy?: AccessPolicy | null,
  ): Promise<SchemaDocument[]>;
}

/** 内存检索器：测试与无 Qdrant 场景 */
export class InMemorySchemaRetriever implements SchemaRetriever {
  private readonly documents: SchemaDocument[];

  constructor(documents: SchemaDocument[]) {
    // Demo/staging metadata is loaded directly rather than through SchemaIndexer.
    // Preserve source timestamps while recording when this snapshot was indexed.
    const indexedAt = new Date().toISOString();
    this.documents = documents.map((doc) => ({
      ...doc,
      indexedAt: doc.indexedAt ?? indexedAt,
    }));
  }

  async search(
    query: string,
    options: SchemaSearchOptions,
    policy?: AccessPolicy | null,
  ): Promise<SchemaDocument[]> {
    let filtered = this.documents.filter((d) => d.docType === options.docType);

    if (options.datasourceId) {
      filtered = filtered.filter(
        (d) => d.datasourceId === options.datasourceId,
      );
    }
    if (options.table) {
      filtered = filtered.filter((d) => d.table === options.table);
    }
    if (options.tables?.length) {
      const set = new Set(options.tables);
      filtered = filtered.filter((d) => d.table && set.has(d.table));
    }

    filtered = filterByPolicy(filtered, policy);

    return rankAndEnrichResults(query, filtered, options, filtered);
  }
}

/** 漏斗式分层检索：源 → 表 → 字段 */
export async function retrieveRelevantSchema(
  retriever: SchemaRetriever,
  query: string,
  policy?: AccessPolicy | null,
  sessionDataSourceId?: string,
): Promise<{
  datasourceId: string;
  dialectFamily: DialectFamily;
  domain: string;
  documents: SchemaDocument[];
}> {
  const allowedSources = policy?.allowedDataSourceIds ?? [];

  let datasourceId = sessionDataSourceId;
  if (!datasourceId) {
    if (allowedSources.length === 1) {
      datasourceId = allowedSources[0];
    } else {
      const sourceDocs = await retriever.search(
        query,
        { docType: "datasource", limit: 3 },
        policy,
      );
      datasourceId =
        sourceDocs[0]?.datasourceId ?? allowedSources[0] ?? "ecommerce_sqlite";
    }
  }

  const sourceDoc = (
    await retriever.search(
      query,
      { docType: "datasource", datasourceId, limit: 1 },
      policy,
    )
  )[0];

  const dialectFamily = (sourceDoc?.dialectFamily ??
    "sqlite") as DialectFamily;
  const domain = sourceDoc?.domain ?? "retail";

  const [tableDocs, relationDocs, metricDocs] = await Promise.all([
    retriever.search(
      query,
      { docType: "table", datasourceId, limit: 5 },
      policy,
    ),
    retriever.search(
      query,
      { docType: "relation", datasourceId, limit: 5 },
      policy,
    ),
    retriever.search(
      query,
      { docType: "metric", datasourceId, limit: 3 },
      policy,
    ),
  ]);
  const tableNames = tableDocs.map((d) => d.table!).filter(Boolean);

  const [columnDocs, columnGroupDocs] = await Promise.all([
    retriever.search(
      query,
      {
        docType: "column",
        datasourceId,
        tables: tableNames,
        limit: 30,
      },
      policy,
    ),
    retriever.search(
      query,
      {
        docType: "column_group",
        datasourceId,
        tables: tableNames,
        limit: 30,
      },
      policy,
    ),
  ]);

  return {
    datasourceId,
    dialectFamily,
    domain,
    documents: [
      ...(sourceDoc ? [sourceDoc] : []),
      ...tableDocs,
      ...columnDocs,
      ...columnGroupDocs,
      ...relationDocs,
      ...metricDocs,
    ],
  };
}

export type { ColumnReason, RetrievedSchema };
