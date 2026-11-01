export interface Check {
  name: string;
  /** Throws on failure; a returned string is the row's note in the report. */
  run: () => Promise<string | undefined> | string | undefined;
}
