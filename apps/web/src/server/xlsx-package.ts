import { posix } from "node:path";
import { crc32 } from "node:zlib";
import { SaxesParser } from "saxes";
import type { SaxesTagNS } from "saxes";
import { fromBufferPromise } from "yauzl";
import { formatPreviewCount, previewFileSize, previewLimits, xlsxLimits } from "../import-preview.ts";
import type { XlsxSheet } from "../import-preview.ts";
import { ImportPreviewError } from "./import-preview-error.ts";

const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const strictOffice = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const packageNs = "http://schemas.openxmlformats.org/package/2006";
const mimeBase = "application/vnd.openxmlformats-officedocument.";
const spreadsheetMime = mimeBase + "spreadsheetml.";
const workbookMime = spreadsheetMime + "sheet.main+xml";
const relationshipsMime = "application/vnd.openxmlformats-package.relationships+xml";
const passiveTypes = new Set([
  workbookMime, relationshipsMime, "application/xml",
  "application/vnd.openxmlformats-package.core-properties+xml",
  ...["worksheet", "styles", "sharedStrings", "calcChain", "table", "comments", "sheetMetadata",
    "pivotTable", "pivotCacheDefinition", "pivotCacheRecords"].map((type) => spreadsheetMime + type + "+xml"),
  ...["theme", "extended-properties", "custom-properties", "drawing", "drawingml.chart"].map((type) => mimeBase + type + "+xml"),
  "image/png", "image/jpeg", "image/gif", "image/bmp", "image/tiff",
]);
const passiveRelations = new Set([
  "officeDocument", "worksheet", "styles", "sharedStrings", "theme", "sheetMetadata", "calcChain",
  "table", "comments", "pivotTable", "pivotCacheDefinition", "pivotCacheRecords", "drawing", "chart",
  "image", "core-properties", "extended-properties", "custom-properties", "hyperlink",
]);

export const spreadsheetNamespaces = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
export const invalidXlsx = () => new ImportPreviewError("XLSX датотеката е оштетена, шифрирана или не е поддржана работна книга.", 415);
const activeXlsx = () => new ImportPreviewError("XLSX датотеката содржи неподдржана активна или вградена содржина.", 415);

export function xmlAttribute(tag: SaxesTagNS, name: string) {
  return tag.attributes[name]?.value;
}

type XmlVisitor = (tag: SaxesTagNS, parents: readonly SaxesTagNS[], offset: number) => void;
export function visitXml(xml: string, events: { open?: XmlVisitor; close?: XmlVisitor; text?: (text: string) => void } = {}) {
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  parser.on("error", () => { throw invalidXlsx(); });
  parser.on("doctype", () => { throw activeXlsx(); });
  parser.on("opentag", (tag) => {
    if (stack.length >= xlsxLimits.xmlDepth) throw invalidXlsx();
    events.open?.(tag, stack, parser.position);
    stack.push(tag);
  });
  parser.on("closetag", (tag) => {
    stack.pop();
    events.close?.(tag, stack, parser.position);
  });
  if (events.text) {
    parser.on("text", events.text);
    parser.on("cdata", events.text);
  }
  parser.write(xml).close();
}

function decodeXml(bytes: Buffer) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0
    ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c
      ? "utf-16be" : "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw invalidXlsx();
  }
}

async function readArchive(bytes: Buffer) {
  if (bytes.length > previewLimits.fileBytes) throw new ImportPreviewError(`XLSX датотеката надминува ${previewFileSize}.`, 413);
  if (bytes.length < 4 || bytes.readUInt32LE() !== 0x04034b50) throw invalidXlsx();
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  const files = new Map<string, Buffer>();
  const paths = new Set<string>();
  let total = 0;
  let entries = 0;
  const tooManyEntries = () => new ImportPreviewError(
    `XLSX архивата може да има најмногу ${formatPreviewCount(xlsxLimits.zipEntries)} записи.`, 413,
  );
  try {
    if (zip.entryCount > xlsxLimits.zipEntries) throw tooManyEntries();
    for await (const entry of zip.eachEntry()) {
      if (++entries > xlsxLimits.zipEntries) throw tooManyEntries();
      const directory = entry.fileName.endsWith("/");
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const key = name.toLowerCase();
      if (!/^[A-Za-z0-9_.[\]/-]+$/.test(name) || name.split("/").some((segment) => !segment || segment === "." || segment === "..")
          || paths.has(key) || !entry.canDecodeFileData()) throw invalidXlsx();
      paths.add(key);
      const header = await zip.readLocalFileHeaderPromise(entry);
      if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod
          || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
          || (!(entry.generalPurposeBitFlag & 8) && header.crc32 !== entry.crc32)) throw invalidXlsx();

      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      let crc = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > xlsxLimits.expandedBytes) {
          throw new ImportPreviewError(`Декомпресираната XLSX содржина надминува ${xlsxLimits.expandedBytes / (1024 * 1024)} MiB.`, 413);
        }
        crc = crc32(chunk, crc);
        size += chunk.length;
        chunks.push(chunk);
      }
      if (crc !== entry.crc32 || (directory && size !== 0)) throw invalidXlsx();
      if (!directory) files.set(name, Buffer.concat(chunks, size));
    }
  } finally {
    zip.close();
  }
  return files;
}

function required<K, V>(values: Map<K, V>, key: K) {
  const value = values.get(key);
  if (value === undefined) throw invalidXlsx();
  return value;
}

function contentTypes(xml: string) {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  visitXml(xml, { open(tag, parents) {
    if (!parents.length && (tag.local !== "Types" || tag.uri !== packageNs + "/content-types")) throw invalidXlsx();
    if (!parents.length) return;
    const override = tag.local === "Override";
    if (parents.length !== 1 || tag.uri !== parents[0].uri || (!override && tag.local !== "Default")) throw invalidXlsx();
    const key = xmlAttribute(tag, override ? "PartName" : "Extension");
    const type = xmlAttribute(tag, "ContentType");
    const map = override ? overrides : defaults;
    if (!key || !type || (override && !key.startsWith("/")) || map.has(key)) throw invalidXlsx();
    map.set(key, type);
  } });
  return (path: string) => overrides.get("/" + path) ?? defaults.get(path.endsWith(".rels") ? "rels" : posix.extname(path).slice(1));
}

type Relation = { kind: string; path: string };
function readRelationships(xml: string, source: string, files: Map<string, Buffer>) {
  const relations = new Map<string, Relation>();
  const ids = new Set<string>();
  visitXml(xml, { open(tag, parents) {
    if (!parents.length && (tag.local !== "Relationships" || tag.uri !== packageNs + "/relationships")) throw invalidXlsx();
    if (!parents.length) return;
    if (parents.length !== 1 || tag.local !== "Relationship" || tag.uri !== parents[0].uri) throw invalidXlsx();
    const id = xmlAttribute(tag, "Id");
    const type = xmlAttribute(tag, "Type") ?? "";
    const target = xmlAttribute(tag, "Target");
    const mode = xmlAttribute(tag, "TargetMode");
    if (!id || !target || ids.has(id)) throw invalidXlsx();
    ids.add(id);
    const kind = type.slice(type.lastIndexOf("/") + 1);
    if (!passiveRelations.has(kind) || ![office, strictOffice, packageNs].some((ns) => type.startsWith(ns + "/"))) throw activeXlsx();
    if (kind === "hyperlink") return; // The address is never handed to the workbook reader.
    if (mode !== undefined && mode !== "Internal") throw activeXlsx();
    const path = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(source), target));
    if (!files.has(path)) throw invalidXlsx();
    relations.set(id, { kind, path });
  } });
  return relations;
}

type SheetPart = XlsxSheet & { path: string };
export async function readXlsxPackage(bytes: Buffer) {
  const files = await readArchive(bytes);
  const types = contentTypes(decodeXml(required(files, "[Content_Types].xml")));
  const xmlParts = new Map<string, string>();
  const allRelations = new Map<string, Map<string, Relation>>();
  for (const [path, bytes] of files) {
    if (path === "[Content_Types].xml") continue;
    const type = types(path);
    if (!type || !passiveTypes.has(type)) throw activeXlsx();
    if (type.startsWith("image/")) continue;
    const xml = decodeXml(bytes);
    if (type === relationshipsMime) {
      const parts = /^(?:(.*)\/)?_rels\/([^/]*)\.rels$/.exec(path);
      if (!parts) throw invalidXlsx();
      const source = parts[2] ? posix.join(parts[1] ?? "", parts[2]) : "";
      if (allRelations.has(source) || (source && !files.has(source))) throw invalidXlsx();
      allRelations.set(source, readRelationships(xml, source, files));
    } else {
      const root = type === spreadsheetMime + "worksheet+xml" ? "worksheet"
        : type === spreadsheetMime + "styles+xml" ? "styleSheet"
          : type === spreadsheetMime + "sharedStrings+xml" ? "sst" : null;
      let grids = 0;
      visitXml(xml, { open(tag, parents) {
        if (root && !parents.length && (tag.local !== root || !spreadsheetNamespaces.has(tag.uri))) throw invalidXlsx();
        if (root === "worksheet" && parents.length === 1 && tag.uri === parents[0].uri) {
          if (tag.local === "sheetData") grids++;
          if (["oleObjects", "controls", "legacyDrawing", "legacyDrawingHF", "webPublishItems"].includes(tag.local)) throw activeXlsx();
        }
        if (type === workbookMime && parents.length === 1 && ["externalReferences", "webPublishing", "oleSize"].includes(tag.local)) throw activeXlsx();
      } });
      if (root === "worksheet" && grids !== 1) throw invalidXlsx();
      xmlParts.set(path, xml);
    }
  }

  const documents = [...required(allRelations, "").values()].filter(({ kind }) => kind === "officeDocument");
  if (documents.length !== 1 || types(documents[0].path) !== workbookMime) throw invalidXlsx();
  const workbookPath = documents[0].path;
  const workbookRels = required(allRelations, workbookPath);
  const sheets: SheetPart[] = [];
  const sheetPaths = new Set<string>();
  const sheetNames = new Set<string>();
  visitXml(required(xmlParts, workbookPath), { open(tag, parents) {
    if (!parents.length && (tag.local !== "workbook" || !spreadsheetNamespaces.has(tag.uri))) throw invalidXlsx();
    if (parents.length !== 2 || parents[1].local !== "sheets" || tag.local !== "sheet" || tag.uri !== parents[0].uri) return;
    if (sheets.length >= xlsxLimits.sheets) {
      throw new ImportPreviewError(`XLSX датотеката може да има најмногу ${xlsxLimits.sheets} работни листови.`, 413);
    }
    const name = xmlAttribute(tag, "name");
    const state = xmlAttribute(tag, "state") ?? "visible";
    const relationId = Object.values(tag.attributes).find((attribute) =>
      attribute.local === "id" && [office, strictOffice].includes(attribute.uri))?.value;
    const relation = relationId ? workbookRels.get(relationId) : undefined;
    if (!name || name.length > 31 || sheetNames.has(name.toLowerCase()) || !["visible", "hidden", "veryHidden"].includes(state)
        || relation?.kind !== "worksheet" || types(relation.path) !== spreadsheetMime + "worksheet+xml"
        || sheetPaths.has(relation.path)) throw invalidXlsx();
    sheets.push({ index: sheets.length, name, hidden: state !== "visible", path: relation.path });
    sheetPaths.add(relation.path);
    sheetNames.add(name.toLowerCase());
  } });
  if (!sheets.length) throw invalidXlsx();

  function workbookPart(kind: "styles" | "sharedStrings") {
    const entries = [...workbookRels.values()].filter((relation) => relation.kind === kind);
    if (!entries.length) return undefined;
    if (entries.length !== 1 || types(entries[0].path) !== spreadsheetMime + kind + "+xml") throw invalidXlsx();
    return required(xmlParts, entries[0].path);
  }
  return {
    sheets, worksheetXml: (sheet: SheetPart) => required(xmlParts, sheet.path),
    styles: workbookPart("styles"), sharedStrings: workbookPart("sharedStrings"),
  };
}
