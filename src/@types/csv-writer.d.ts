/**
 * Type declarations for csv-writer
 * 
 * The original package ships broken TypeScript source files that cause TS2742 errors.
 * This declaration file provides proper types to work around the issue.
 */

declare module 'csv-writer' {
  export interface ObjectCsvStringifierParams {
    header: Array<{ id: string; title: string }>;
    fieldDelimiter?: string;
    recordDelimiter?: string;
    headerIdDelimiter?: string;
    alwaysQuote?: boolean;
  }

  export interface ArrayCsvStringifierParams {
    header?: string[];
    fieldDelimiter?: string;
    recordDelimiter?: string;
    alwaysQuote?: boolean;
  }

  export interface ObjectCsvWriterParams extends ObjectCsvStringifierParams {
    path: string;
    encoding?: string;
    append?: boolean;
  }

  export interface ArrayCsvWriterParams extends ArrayCsvStringifierParams {
    path: string;
    encoding?: string;
    append?: boolean;
  }

  export interface CsvStringifier<T> {
    getHeaderString(): string | null;
    stringifyRecords(records: T[]): string;
  }

  export interface CsvWriter<T> {
    writeRecords(records: T[]): Promise<void>;
  }

  export function createObjectCsvStringifier(
    params: ObjectCsvStringifierParams
  ): CsvStringifier<Record<string, unknown>>;

  export function createArrayCsvStringifier(
    params: ArrayCsvStringifierParams
  ): CsvStringifier<unknown[]>;

  export function createObjectCsvWriter(
    params: ObjectCsvWriterParams
  ): CsvWriter<Record<string, unknown>>;

  export function createArrayCsvWriter(
    params: ArrayCsvWriterParams
  ): CsvWriter<unknown[]>;
}
