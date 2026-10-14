/** Turn selected grid rows into text for the clipboard: TSV, CSV, JSON, Markdown or SQL INSERT. Pure, so it is unit-tested. */
export type CellVal = { t: "Null" } | { t: "Bool" | "I64" | "F64" | "Text"; v: any } | { t: "Bytes"; v: number[] };
export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "sql";

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
/** Plain text of a cell; NULL becomes an empty string. */
export function cellText(v: CellVal | undefined): string {
  if (!v || v.t === "Null") return "";
  if (v.t === "Bytes") return "0x" + hex(v.v);
  return String(v.v);
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const mdField = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const tsvField = (s: string) => s.replace(/[\t\r\n]+/g, " ");

function jsValue(v: CellVal | undefined): unknown {
  if (!v || v.t === "Null") return null;
  if (v.t === "Bytes") return "0x" + hex(v.v);
  if (v.t === "Text") return v.v;
  if (v.t === "Bool") return !!v.v;
  return v.v;
}

/** `dialect` decides string escaping and blob literals: "mysql" doubles backslashes, "postgres" writes bytea as '\x…'. */
function sqlLiteral(v: CellVal | undefined, dialect: string): string {
  if (!v || v.t === "Null") return "NULL";
  if (v.t === "Bytes") return dialect === "postgres" ? `'\\x${hex(v.v)}'` : `X'${hex(v.v)}'`;
  if (v.t === "Bool") return dialect === "postgres" ? String(!!v.v) : v.v ? "1" : "0";
  if (v.t === "I64" || v.t === "F64") return Number.isFinite(Number(v.v)) ? String(v.v) : "NULL";
  let s = String(v.v).replace(/'/g, "''");
  if (dialect === "mysql") s = s.replace(/\\/g, "\\\\");
  return `'${s}'`;
}

export interface CopyOptions { columns: string[]; table?: string; quote?: (ident: string) => string; dialect?: string; header?: boolean }

export function formatRows(fmt: CopyFormat, rows: (CellVal | undefined)[][], o: CopyOptions): string {
  const { columns } = o;
  const text = (r: (CellVal | undefined)[]) => columns.map((_, i) => cellText(r[i]));
  switch (fmt) {
    case "tsv": {
      const lines = rows.map((r) => text(r).map(tsvField).join("\t"));
      return (o.header ? [columns.map(tsvField).join("\t"), ...lines] : lines).join("\n");
    }
    case "csv": {
      const lines = rows.map((r) => text(r).map(csvField).join(","));
      return (o.header === false ? lines : [columns.map(csvField).join(","), ...lines]).join("\n");
    }
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, jsValue(r[i])]))), null, 2);
    case "markdown": {
      const head = `| ${columns.map(mdField).join(" | ")} |`, sep = `| ${columns.map(() => "---").join(" | ")} |`;
      return [head, sep, ...rows.map((r) => `| ${text(r).map(mdField).join(" | ")} |`)].join("\n");
    }
    case "sql": {
      const q = o.quote ?? ((s: string) => `"${s.replace(/"/g, '""')}"`);
      const dialect = o.dialect ?? "";
      const head = `INSERT INTO ${q(o.table ?? "table_name")} (${columns.map(q).join(", ")}) VALUES`;
      const out: string[] = [];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => `  (${columns.map((_, c) => sqlLiteral(r[c], dialect)).join(", ")})`);
        out.push(`${head}\n${chunk.join(",\n")};`);
      }
      return out.join("\n");
    }
  }
}

/** Which rows a click selects: plain click = just this row, ⌘/Ctrl = toggle it, Shift = the range from the anchor. */
export function nextSelection(current: ReadonlySet<number>, anchor: number, row: number, mode: "single" | "toggle" | "range"): { rows: Set<number>; anchor: number } {
  if (mode === "single" || anchor < 0) return { rows: new Set([row]), anchor: row };
  if (mode === "toggle") {
    const rows = new Set(current);
    rows.has(row) ? rows.delete(row) : rows.add(row);
    return { rows, anchor: row };
  }
  const [a, b] = anchor <= row ? [anchor, row] : [row, anchor];
  const rows = new Set<number>();
  for (let i = a; i <= b; i++) rows.add(i);
  return { rows, anchor };
}
