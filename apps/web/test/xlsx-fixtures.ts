import { CFB, utils, write } from "xlsx";
import type { WorkSheet, WritingOptions } from "xlsx";

export function syntheticXlsx(sheets: { name: string; grid: WorkSheet; hidden?: 1 | 2 }[], options: WritingOptions = {}): Buffer {
  const book = utils.book_new();
  for (const { name, grid } of sheets) utils.book_append_sheet(book, grid, name);
  book.Workbook = { Sheets: sheets.map(({ name, hidden }) => ({ name, Hidden: hidden ?? 0 })) };
  return write(book, { bookSST: true, ...options, type: "buffer" });
}

export function editXlsx(file: Buffer, edit: (part: (path: string, update: (xml: string) => string) => void,
  add: (path: string, bytes: Buffer, duplicate?: boolean) => void) => void): Buffer {
  const archive = CFB.read(file, { type: "buffer" });
  edit((path, update) => {
    const entry = CFB.find(archive, "/" + path);
    if (!entry) throw new Error("Недостасува дел од синтетичката работна книга.");
    CFB.utils.cfb_add(archive, "/" + path, Buffer.from(update(Buffer.from(entry.content).toString("utf8"))));
  }, (path, bytes, duplicate) => CFB.utils.cfb_add(archive, path, bytes, { unsafe: duplicate === true }));
  return CFB.write(archive, { type: "buffer", fileType: "zip", compression: true });
}
