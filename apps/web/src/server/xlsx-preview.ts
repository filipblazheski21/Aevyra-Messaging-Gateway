import { CFB, read, SSF, utils } from "xlsx";
import type { CellObject, CellAddress } from "xlsx";
import { formatPreviewCount, previewLimits } from "../import-preview.ts";
import type { XlsxPreview, XlsxSample } from "../import-preview.ts";
import { ImportPreviewError } from "./import-preview-error.ts";
import { createPhoneColumnAnalysis } from "./phone-column-analysis.ts";
import type { CollectPhoneCandidate } from "./phone-column-analysis.ts";
import { invalidXlsx, readXlsxPackage, spreadsheetNamespaces, visitXml, xmlAttribute } from "./xlsx-package.ts";

export type XlsxPreviewOptions = { sheet: number | null; hasHeader: boolean; phoneColumn: number | null };
const spreadsheet = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const spreadsheetMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.";

function cellAddress(reference: string) {
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(reference)) throw invalidXlsx();
  const position = utils.decode_cell(reference);
  if (position.r >= 1_048_576 || position.c >= 16_384) throw invalidXlsx();
  return position;
}

function rangeAddress(reference: string | undefined) {
  const parts = reference?.split(":");
  if (!parts || parts.length > 2) throw invalidXlsx();
  const start = cellAddress(parts[0]);
  const end = parts.length === 2 ? cellAddress(parts[1]) : start;
  if (start.r > end.r || start.c > end.c) throw invalidXlsx();
  return { start, end };
}

function checkPosition({ r, c }: CellAddress, hasHeader: boolean) {
  if (c >= previewLimits.columns) {
    throw new ImportPreviewError(`XLSX листот може да има најмногу ${previewLimits.columns} колони со податоци.`, 413);
  }
  if (r >= previewLimits.records + Number(hasHeader)) {
    throw new ImportPreviewError(`XLSX листот може да има најмногу ${formatPreviewCount(previewLimits.records)} податочни редови.`, 413);
  }
}

function phoneCellError(reference: string, reason: string) {
  return new ImportPreviewError(`Ќелијата ${reference} во телефонската колона ${reason}`);
}

// SheetJS only receives the actual grid. Comments and processing instructions
// are removed and CDATA is escaped so it cannot be mistaken for grid markup.
function gridXml(xml: string) {
  return xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>/g, (_markup, data?: string) =>
    data === undefined ? "" : data.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}

function inspectGrid(originalXml: string, { hasHeader, phoneColumn }: XlsxPreviewOptions) {
  const xml = gridXml(originalXml);
  const formulaCells = new Set<string>();
  const numericValues = new Map<string, string>();
  const valueCells = new Set<string>();
  const merges: ReturnType<typeof rangeAddress>[] = [];
  let gridStart = -1;
  let gridEnd = -1;
  let row = -1;
  let column = -1;
  let rootNamespace = "";
  let cell: { reference: string; kind: string; number: string; formula: boolean; content: boolean; valueTag?: "v" | "is" } | undefined;
  let reading: "v" | "t" | null = null;

  visitXml(xml, {
    open(tag, parents, offset) {
      if (!parents.length) {
        if (tag.local !== "worksheet" || !spreadsheetNamespaces.has(tag.uri)) throw invalidXlsx();
        rootNamespace = tag.uri;
      }
      const inGrid = parents[1]?.local === "sheetData" && parents[1].uri === rootNamespace;
      if (inGrid && (tag.uri !== rootNamespace
        || (parents.length === 2 && tag.local !== "row")
        || (parents.length === 3 && tag.local !== "c")
        || (parents.length === 4 && !["f", "v", "is"].includes(tag.local))
        || (parents.length > 4 && ["row", "c", "f", "v"].includes(tag.local)))) throw invalidXlsx();
      if (tag.uri !== rootNamespace) return;
      const parent = parents.at(-1)?.local;
      if (tag.local === "sheetData" && parents.length === 1) {
        if (gridStart !== -1) throw invalidXlsx();
        gridStart = offset;
      } else if (inGrid && tag.local === "row" && parent === "sheetData" && parents.length === 2) {
        const reference = xmlAttribute(tag, "r");
        const next = reference === undefined ? row + 1 : cellAddress("A" + reference).r;
        if (next <= row || next >= 1_048_576) throw invalidXlsx();
        row = next;
        column = -1;
      } else if (inGrid && tag.local === "c" && parent === "row" && parents.length === 3) {
        const reference = xmlAttribute(tag, "r") ?? utils.encode_cell({ r: row, c: column + 1 });
        const position = cellAddress(reference);
        if (position.r !== row || position.c <= column) throw invalidXlsx();
        column = position.c;
        cell = { reference, kind: xmlAttribute(tag, "t") ?? "n", number: "", formula: false, content: false };
      } else if (cell && parent === "c" && parents.length === 4) {
        if (tag.local === "f") {
          if (cell.formula || cell.valueTag) throw invalidXlsx();
          cell.formula = true;
          checkPosition({ r: row, c: column }, hasHeader);
          if (phoneColumn === column) throw phoneCellError(cell.reference, "содржи формула.");
          const reference = xmlAttribute(tag, "ref");
          if (reference && phoneColumn !== null) {
            const { start, end } = rangeAddress(reference);
            if (start.c <= phoneColumn && phoneColumn <= end.c) {
              throw phoneCellError(utils.encode_cell({ r: start.r, c: phoneColumn }), "е дел од опсег на формула.");
            }
          }
        }
        if (tag.local === "v" || tag.local === "is") {
          if (cell.valueTag || (tag.local === "is") !== (cell.kind === "inlineStr")) throw invalidXlsx();
          cell.valueTag = tag.local;
          if (tag.local === "v") reading = "v";
        }
      } else if (cell?.valueTag === "is" && tag.local === "t") {
        reading = "t";
      } else if (tag.local === "mergeCell" && parent === "mergeCells" && parents.length === 2) {
        const merge = rangeAddress(xmlAttribute(tag, "ref"));
        if (phoneColumn !== null && merge.start.c <= phoneColumn && phoneColumn <= merge.end.c) {
          throw new ImportPreviewError("Избраната телефонска колона допира споени ќелии. Изберете друга колона или отстранете го спојувањето.");
        }
        if (hasHeader && merge.start.r === 0) merges.push(merge);
      }
    },
    text(text) {
      if (!cell || !reading) return;
      if (text.length) cell.content = true;
      if (reading === "v" && cell.kind === "n" && phoneColumn === column) {
        if (cell.number.length + text.length > 128) throw phoneCellError(cell.reference, "има неподдржана бројчана вредност.");
        cell.number += text;
      }
    },
    close(tag, parents, offset) {
      if (tag.uri !== rootNamespace) return;
      if (tag.local === "sheetData" && parents.length === 1) {
        gridEnd = offset === gridStart ? gridStart : xml.lastIndexOf("</", offset - 1);
      } else if (cell && tag.local === reading) {
        reading = null;
      } else if (tag.local === "c" && parents.length === 3 && cell) {
        if (cell.formula) formulaCells.add(cell.reference);
        else if (cell.content) {
          valueCells.add(cell.reference);
          if (cell.number !== "") numericValues.set(cell.reference, cell.number);
        }
        cell = undefined;
      }
    },
  });
  if (gridStart < 0 || gridEnd < gridStart) throw invalidXlsx();
  return { rows: xml.slice(gridStart, gridEnd), formulaCells, numericValues, valueCells, merges };
}

function readGrid(rows: string, styles: string | undefined, sharedStrings: string | undefined) {
  const container = CFB.utils.cfb_new();
  const add = (path: string, xml: string) => CFB.utils.cfb_add(container, path, Buffer.from(xml));
  const parts = [
    { kind: "worksheet", path: "sheet.xml", xml: `<worksheet xmlns="${spreadsheet}"><sheetData>${rows}</sheetData></worksheet>` },
  ];
  if (styles !== undefined) parts.push({ kind: "styles", path: "styles.xml", xml: gridXml(styles) });
  if (sharedStrings !== undefined) parts.push({ kind: "sharedStrings", path: "sharedStrings.xml", xml: gridXml(sharedStrings) });
  add("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="${spreadsheetMime}sheet.main+xml"/>
    ${parts.map(({ path, kind }) => `<Override PartName="/xl/${path}" ContentType="${spreadsheetMime}${kind}+xml"/>`).join("")}
    </Types>`);
  add("_rels/.rels", `<Relationships xmlns="${relationships}">
    <Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add("xl/workbook.xml", `<workbook xmlns="${spreadsheet}" xmlns:r="${office}">
    <sheets><sheet name="Preview" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  add("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${relationships}">
    ${parts.map(({ path, kind }, index) => `<Relationship Id="rId${index + 1}" Type="${office}/${kind}" Target="${path}"/>`).join("")}
    </Relationships>`);
  for (const { path, xml } of parts) add("xl/" + path, xml);

  // The ZIP handed to SheetJS is rebuilt from checked parts, with no original ZIP metadata.
  const safeZip: Buffer = CFB.write(container, { type: "buffer", fileType: "zip" });
  const workbook = read(safeZip, {
    dense: false, nodim: true, cellFormula: false, cellDates: true, cellNF: true, cellText: false, cellHTML: false, WTF: true,
  });
  const sheet = workbook.Sheets.Preview;
  if (!sheet) throw invalidXlsx();
  return sheet;
}

function checkText(value: string, reference: string) {
  if (value.length > previewLimits.fieldCharacters && [...value].length > previewLimits.fieldCharacters) {
    throw new ImportPreviewError(`Ќелијата ${reference} надминува ${formatPreviewCount(previewLimits.fieldCharacters)} знаци.`, 413);
  }
}

function exactPhoneNumber(raw: string | undefined, reference: string) {
  const match = /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw?.trim() ?? "");
  if (match) {
    const fraction = match[3] ?? "";
    const digits = match[2] + fraction;
    const exponent = Number(match[4] ?? "0");
    const significant = digits.replace(/0+$/, "");
    const value = Number(raw);
    if (digits && Number.isSafeInteger(value) && value >= 0
        && (!significant || (match[1] !== "-" && significant.length <= digits.length - fraction.length + exponent))) {
      return String(value);
    }
  }
  throw phoneCellError(reference, "мора да содржи ненегативен безбеден цел број или текст.");
}

function sampleCell(cell: CellObject | undefined, recordNumber: number, reference: string, rawNumber: string | undefined): XlsxSample {
  if ((!cell || cell.t === "z") && rawNumber === undefined) return { recordNumber, value: "", cellKind: "empty" };
  if (cell?.t === "s" && typeof cell.v === "string") return { recordNumber, value: cell.v, cellKind: cell.v === "" ? "empty" : "text" };
  if (cell?.t === "d" || (cell?.t === "n" && cell.z && SSF.is_date(cell.z))) throw phoneCellError(reference, "содржи датум или време.");
  if (cell?.t === "b") throw phoneCellError(reference, "содржи логичка вредност.");
  if (cell?.t === "e") throw phoneCellError(reference, "содржи Excel грешка.");
  if (cell?.t === "n" || rawNumber !== undefined) {
    return { recordNumber, value: exactPhoneNumber(rawNumber, reference), cellKind: "number", warning: "numeric-phone" };
  }
  throw phoneCellError(reference, "е од неподдржан вид.");
}

export async function previewXlsx(file: Buffer, options: XlsxPreviewOptions, collect?: CollectPhoneCandidate): Promise<XlsxPreview> {
  try {
    const book = await readXlsxPackage(file);
    const sheets = book.sheets.map(({ index, name, hidden }) => ({ index, name, hidden }));
    if (options.sheet === null) {
      if (options.phoneColumn !== null) throw new ImportPreviewError("Прво изберете работен лист.");
      return { format: "xlsx", sheets, sheet: null, preview: null };
    }
    const selected = book.sheets[options.sheet];
    if (!selected) throw new ImportPreviewError("Изберете постоечки работен лист.");
    const { hasHeader, phoneColumn } = options;
    const { rows, formulaCells, numericValues, valueCells, merges } = inspectGrid(book.worksheetXml(selected), options);
    const grid = readGrid(rows, book.styles, book.sharedStrings);
    const occupied = new Set<number>();
    let width = 0;
    const mark = (reference: string) => {
      const position = cellAddress(reference);
      checkPosition(position, hasHeader);
      width = Math.max(width, position.c + 1);
      occupied.add(position.r);
    };
    for (const reference of Object.keys(grid)) {
      const cell = grid[reference] as CellObject;
      if (reference.startsWith("!") || cell.t === "z" || cell.v === "") continue;
      if (!valueCells.has(reference) && !formulaCells.has(reference)) throw invalidXlsx();
      mark(reference);
      if (typeof cell.v === "string") checkText(cell.v, reference);
    }
    for (const reference of valueCells) {
      if (!Object.hasOwn(grid, reference)) throw invalidXlsx();
    }
    for (const reference of formulaCells) mark(reference);
    for (const reference of numericValues.keys()) mark(reference);
    if (merges.some(({ start }) => start.c < width)) {
      throw new ImportPreviewError("Заглавието допира споени ќелии. Отстранете го спојувањето или исклучете го заглавието.");
    }
    if (!width) throw new ImportPreviewError("Избраниот работен лист нема податоци.");
    if (phoneColumn !== null && (!Number.isInteger(phoneColumn) || phoneColumn < 0 || phoneColumn >= width)) {
      throw new ImportPreviewError("Изберете постоечка телефонска колона.");
    }
    const columns = Array.from({ length: width }, (_, index) => {
      const reference = utils.encode_cell({ r: 0, c: index });
      const cell = grid[reference] as CellObject | undefined;
      const value = formulaCells.has(reference) ? undefined : cell?.v;
      return { index, name: hasHeader ? typeof value === "string" || typeof value === "number" ? String(value) : "" : null };
    });
    const firstDataRow = Number(hasHeader);
    const lastRow = Math.max(...occupied);
    const analysis = phoneColumn === null ? null : createPhoneColumnAnalysis<XlsxSample>(collect);
    let skippedEmptyRecords = 0;
    for (let row = firstDataRow; row <= lastRow; row++) {
      if (!occupied.has(row)) {
        skippedEmptyRecords++;
      } else if (phoneColumn !== null) {
        const reference = utils.encode_cell({ r: row, c: phoneColumn });
        const sample = sampleCell(grid[reference] as CellObject | undefined, row + 1, reference, numericValues.get(reference));
        analysis?.add(sample, sample.cellKind);
      }
    }
    return {
      format: "xlsx", sheets, sheet: sheets[options.sheet],
      preview: {
        columns, phoneColumn, totalRecords: lastRow + 1 - firstDataRow, skippedEmptyRecords,
        ...(analysis?.finish(skippedEmptyRecords) ?? { analysis: null, samples: [] }),
      },
    };
  } catch (error) {
    if (error instanceof ImportPreviewError) throw error;
    throw invalidXlsx();
  }
}
