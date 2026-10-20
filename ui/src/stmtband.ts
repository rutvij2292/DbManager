/** A soft band behind the statement the cursor is in, so it is clear what ⌘↵ will run. */
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { FUNCTIONS } from "./complete";
import { statementAt } from "./sqlsplit";

/** Character range of the statement at `pos` (no leading or trailing blank space), or null when there is none. */
export function bandRange(doc: string, pos: number): { from: number; to: number } | null {
  const s = statementAt(doc, pos);
  return s ? { from: s.from, to: s.to } : null;
}

const line = Decoration.line({ class: "cm-stmt" });

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  if (view.state.doc.length > 200_000) return b.finish(); // converting a huge script to a string on every cursor move is not worth a band
  const r = bandRange(view.state.doc.toString(), view.state.selection.main.head);
  if (r) {
    const first = view.state.doc.lineAt(r.from).number, last = view.state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) b.add(view.state.doc.line(n).from, view.state.doc.line(n).from, line);
  }
  return b.finish();
}

export const statementBand = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);

const fn = Decoration.mark({ class: "cm-fn" });
const FN = new Set(FUNCTIONS);
const NOT_CODE = new Set(["String", "LineComment", "BlockComment", "QuotedIdentifier"]);

/** The grammar colours names like COUNT as keywords; a function call reads better in the plain text colour. */
function fnMarks(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (!FN.has(m[1].toUpperCase())) continue;
      const at = from + m.index!;
      if (NOT_CODE.has(tree.resolveInner(at, 1).name)) continue;
      b.add(at, at + m[1].length, fn);
    }
  }
  return b.finish();
}

export const functionNames = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = fnMarks(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = fnMarks(u.view); }
  },
  { decorations: (v) => v.decorations },
);
