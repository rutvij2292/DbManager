import { icon } from "./icons";
import { buildWhere, FILTER_OPS, type FilterOp, type FilterRule, type Quote } from "./builder-sql";
import { esc } from "./ui";

/**
 * Row filter for the table view: build conditions from column / operator / value,
 * or switch to a raw SQL condition. `apply` receives the WHERE text ("" clears the filter).
 */
export function createFilterBar(columns: () => string[], quote: () => Quote, apply: (where: string) => void) {
  const el = document.createElement("div");
  el.className = "shrink-0 border-b border-line bg-canvas px-3 py-2 text-[13px]";
  el.style.display = "none";
  let rules: FilterRule[] = [{ col: "", op: "=", value: "" }];
  let raw = false, rawText = "";

  const submit = () => apply(raw ? rawText.trim() : buildWhere(rules.filter((r) => r.col), quote()));
  const sel = (opts: [string, string][], val: string, on: (v: string) => void, w: string) => {
    const s = document.createElement("select");
    s.className = "field";
    s.style.width = w;
    s.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(l)}</option>`).join("");
    s.onchange = () => on(s.value);
    return s;
  };

  function draw() {
    const cols = columns();
    if (!rules[0].col && cols.length) rules[0].col = cols[0];
    el.innerHTML = "";
    const top = document.createElement("div");
    top.className = "flex items-center gap-2 mb-1.5";
    top.innerHTML = `<span class="text-soft">${icon("filter", 14)}</span><span class="font-medium">Filter rows</span>`;
    const seg = document.createElement("div");
    seg.className = "inline-flex p-0.5 rounded-lg bg-raised ml-2";
    for (const [id, label] of [["rules", "Rules"], ["sql", "SQL"]] as const) {
      const b = document.createElement("button");
      const on = (id === "sql") === raw;
      b.textContent = label;
      b.className = "btn btn-ghost";
      b.style.cssText = `height:22px;${on ? "background:var(--panel);color:var(--ink);box-shadow:0 1px 2px rgb(20 28 46 / .12)" : ""}`;
      b.onclick = () => { raw = id === "sql"; draw(); };
      seg.append(b);
    }
    const spacer = document.createElement("span"); spacer.className = "flex-1";
    const clear = document.createElement("button");
    clear.className = "btn btn-ghost"; clear.textContent = "Clear";
    clear.onclick = () => { rules = [{ col: cols[0] ?? "", op: "=", value: "" }]; rawText = ""; draw(); apply(""); };
    const go = document.createElement("button");
    go.className = "btn btn-primary"; go.innerHTML = `<span>Apply</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">↵</span>`;
    go.onclick = submit;
    top.append(seg, spacer, clear, go);
    el.append(top);

    if (raw) {
      const inp = document.createElement("input");
      inp.className = "field mono w-full";
      inp.placeholder = "status = 'paid' AND total > 100";
      inp.value = rawText;
      inp.oninput = () => { rawText = inp.value; };
      inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") submit(); };
      const hint = document.createElement("div");
      hint.className = "text-muted mt-1";
      hint.textContent = "A SQL condition, without the WHERE keyword.";
      el.append(inp, hint);
      return;
    }
    rules.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-1.5 mb-1";
      if (i > 0) row.append(sel([["and", "AND"], ["or", "OR"]], r.or ? "or" : "and", (v) => { r.or = v === "or"; }, "64px"));
      else { const gap = document.createElement("span"); gap.style.width = "64px"; gap.className = "text-muted text-right pr-2"; gap.textContent = "Where"; row.append(gap); }
      row.append(sel(cols.map((c) => [c, c]), r.col, (v) => { r.col = v; }, "170px"));
      row.append(sel(FILTER_OPS.map((o) => [o, o]), r.op, (v) => { r.op = v as FilterOp; draw(); }, "128px"));
      const val = document.createElement("input");
      val.className = "field flex-1";
      val.style.minWidth = "120px";
      val.value = r.value;
      val.placeholder = r.op === "in list" ? "a, b, c" : "value";
      val.disabled = r.op === "is null" || r.op === "is not null";
      val.oninput = () => { r.value = val.value; };
      val.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") submit(); };
      const add = document.createElement("button");
      add.className = "btn btn-ghost"; add.style.cssText = "width:26px;padding:0;justify-content:center"; add.title = "Add a condition"; add.innerHTML = icon("plus", 14);
      add.onclick = () => { rules.splice(i + 1, 0, { col: cols[0] ?? "", op: "=", value: "" }); draw(); };
      const del = document.createElement("button");
      del.className = "btn btn-ghost"; del.style.cssText = "width:26px;padding:0;justify-content:center"; del.title = "Remove"; del.innerHTML = icon("close", 12);
      del.onclick = () => { if (rules.length > 1) rules.splice(i, 1); else rules[0] = { col: cols[0] ?? "", op: "=", value: "" }; draw(); };
      row.append(val, add, del);
      el.append(row);
    });
  }

  /** Add a condition (e.g. from a cell's right-click menu), open the bar and apply. */
  function addRule(r: FilterRule) {
    raw = false;
    // An untouched placeholder rule (nothing typed yet) is replaced rather than kept alongside.
    if (rules.length === 1 && !rules[0].value && rules[0].op === "=") rules = [r];
    else rules.push({ ...r, or: false });
    if (el.style.display === "none") el.style.display = "block";
    draw();
    submit();
  }

  return {
    addRule,
    el,
    get open() { return el.style.display !== "none"; },
    toggle() {
      const show = el.style.display === "none";
      el.style.display = show ? "block" : "none";
      if (show) { draw(); (el.querySelector("input:not(:disabled)") as HTMLInputElement | null)?.focus(); }
    },
    refresh() { if (el.style.display !== "none") draw(); },
  };
}
