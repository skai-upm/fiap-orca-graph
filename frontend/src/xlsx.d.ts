declare module "xlsx" {
  export const utils: {
    book_new(): unknown;
    book_append_sheet(workbook: unknown, worksheet: unknown, name: string): void;
    json_to_sheet(rows: Record<string, string>[], options?: { header?: string[] }): unknown;
  };
  export function writeFile(workbook: unknown, filename: string): void;
}
