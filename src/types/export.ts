/** Payload of the `export:completed` event (`ExportCompleted` in commands.rs). */
export interface ExportCompleted {
  /** Absolute path of the file that was just written. */
  path: string;
  count: number;
  /** "csv" | "xlsx" */
  format: string;
  /**
   * Rows the writer could not fully write (R-25). Only the Excel path can be
   * non-zero: `write_string` rejects cells Excel cannot hold, and those cells
   * used to disappear without the panel noticing.
   */
  failedRows?: number;
}
