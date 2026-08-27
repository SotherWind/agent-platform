import type { DialectFamily } from "./types.js";
import type { TimeGrain } from "../query-plan/logical-query.js";

/**
 * Render a stable, sortable time label for a certified metric query.
 * The input column is already identifier-quoted by the caller; only the
 * allow-listed grain reaches this function.
 */
export function renderTimeBucket(
  dialect: DialectFamily,
  qualifiedColumn: string,
  grain: TimeGrain,
): string {
  switch (dialect) {
    case "mysql":
      return mysqlTimeBucket(qualifiedColumn, grain);
    case "postgresql":
      return postgresqlTimeBucket(qualifiedColumn, grain);
    case "oracle":
      return oracleTimeBucket(qualifiedColumn, grain);
    case "tsql":
      return tsqlTimeBucket(qualifiedColumn, grain);
    case "db2":
      return `VARCHAR_FORMAT(${qualifiedColumn}, '${db2Format(grain)}')`;
    case "hana":
      return `TO_VARCHAR(${qualifiedColumn}, '${hanaFormat(grain)}')`;
    case "sqlite":
    default:
      return sqliteTimeBucket(qualifiedColumn, grain);
  }
}

function sqliteTimeBucket(column: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return `strftime('%Y-%m-%d', ${column})`;
    case "week":
      return `strftime('%Y-W%W', ${column})`;
    case "month":
      return `strftime('%Y-%m', ${column})`;
    case "quarter":
      return `printf('%s-Q%d', strftime('%Y', ${column}), ((CAST(strftime('%m', ${column}) AS INTEGER) - 1) / 3) + 1)`;
    case "year":
      return `strftime('%Y', ${column})`;
  }
}

function mysqlTimeBucket(column: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return `DATE_FORMAT(${column}, '%Y-%m-%d')`;
    case "week":
      return `DATE_FORMAT(${column}, '%x-W%v')`;
    case "month":
      return `DATE_FORMAT(${column}, '%Y-%m')`;
    case "quarter":
      return `CONCAT(YEAR(${column}), '-Q', QUARTER(${column}))`;
    case "year":
      return `DATE_FORMAT(${column}, '%Y')`;
  }
}

function postgresqlTimeBucket(column: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return `TO_CHAR(${column}, 'YYYY-MM-DD')`;
    case "week":
      return `TO_CHAR(DATE_TRUNC('week', ${column}), 'IYYY-"W"IW')`;
    case "month":
      return `TO_CHAR(${column}, 'YYYY-MM')`;
    case "quarter":
      return `TO_CHAR(${column}, 'YYYY-"Q"Q')`;
    case "year":
      return `TO_CHAR(${column}, 'YYYY')`;
  }
}

function oracleTimeBucket(column: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return `TO_CHAR(${column}, 'YYYY-MM-DD')`;
    case "week":
      return `TO_CHAR(${column}, 'IYYY-"W"IW')`;
    case "month":
      return `TO_CHAR(${column}, 'YYYY-MM')`;
    case "quarter":
      return `TO_CHAR(${column}, 'YYYY-"Q"Q')`;
    case "year":
      return `TO_CHAR(${column}, 'YYYY')`;
  }
}

function tsqlTimeBucket(column: string, grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return `CONVERT(varchar(10), ${column}, 23)`;
    case "week":
      return `CONCAT(DATEPART(year, ${column}), '-W', RIGHT('0' + CONVERT(varchar(2), DATEPART(iso_week, ${column})), 2))`;
    case "month":
      return `CONVERT(varchar(7), ${column}, 120)`;
    case "quarter":
      return `CONCAT(DATEPART(year, ${column}), '-Q', DATEPART(quarter, ${column}))`;
    case "year":
      return `CONVERT(varchar(4), DATEPART(year, ${column}))`;
  }
}

function db2Format(grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return "YYYY-MM-DD";
    case "week":
      return 'IYYY-"W"IW';
    case "month":
      return "YYYY-MM";
    case "quarter":
      return 'YYYY-"Q"Q';
    case "year":
      return "YYYY";
  }
}

function hanaFormat(grain: TimeGrain): string {
  switch (grain) {
    case "day":
      return "YYYY-MM-DD";
    case "week":
      return 'YYYY-"W"WW';
    case "month":
      return "YYYY-MM";
    case "quarter":
      return 'YYYY-"Q"Q';
    case "year":
      return "YYYY";
  }
}
