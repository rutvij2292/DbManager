import type { PlanNode } from "./api";
import type { Hint } from "./lint";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** Render a plan as a nested tree; each node's bar shows its share of the heaviest metric available. */
export function renderPlan(root: PlanNode, hints: Hint[]): HTMLElement {
  const metric = (n: PlanNode) => n.time_ms ?? n.cost ?? n.est_rows ?? 0;
  let max = 0;
  const scan = (n: PlanNode) => { max = Math.max(max, metric(n)); n.children.forEach(scan); };
  scan(root);
  const unit = root.time_ms != null || findAny(root, (n) => n.time_ms != null) ? "ms" : root.cost != null ? "cost" : "rows";

  const el = document.createElement("div");
  el.className = "h-full overflow-auto p-3 text-[12px] flex gap-4";
  const tree = document.createElement("div");
  tree.className = "flex-1 min-w-0";
  const node = (n: PlanNode, depth: number): string => {
    const share = max > 0 ? metric(n) / max : 0;
    const hot = share > 0.6 ? "bg-red-500" : share > 0.25 ? "bg-amber-500" : "bg-blue-500";
    const stats = [
      n.actual_rows != null ? `${fmt(n.actual_rows)} rows` : n.est_rows != null ? `~${fmt(n.est_rows)} rows` : "",
      n.time_ms != null ? `${n.time_ms.toFixed(2)} ms` : n.cost != null ? `cost ${n.cost.toFixed(1)}` : "",
    ].filter(Boolean).join(" · ");
    return `<div class="${depth ? "ml-5 pl-3 border-l border-zinc-700" : ""} my-1.5">
      <div class="rounded border border-zinc-700 bg-zinc-800/70 px-2 py-1.5 inline-block min-w-64 max-w-full">
        <div class="flex gap-2 items-baseline"><b class="text-zinc-100">${esc(n.op)}</b>${n.relation ? `<span class="text-blue-300">${esc(n.relation)}</span>` : ""}<span class="ml-auto text-zinc-400 mono">${esc(stats)}</span></div>
        ${n.detail ? `<div class="text-zinc-400 mono text-[11px] break-words">${esc(n.detail)}</div>` : ""}
        <div class="h-1 mt-1 rounded bg-zinc-700"><div class="h-1 rounded ${hot}" style="width:${Math.max(2, share * 100)}%"></div></div>
      </div>
      ${n.children.map((c) => node(c, depth + 1)).join("")}
    </div>`;
  };
  tree.innerHTML = `<div class="text-zinc-500 mb-1">Bars show relative ${unit}</div>` + node(root, 0);
  el.append(tree, hintsPanel(hints));
  return el;
}

function findAny(n: PlanNode, f: (n: PlanNode) => boolean): boolean {
  return f(n) || n.children.some((c) => findAny(c, f));
}
const fmt = (x: number) => Math.round(x).toLocaleString();

export function hintsPanel(hints: Hint[]): HTMLElement {
  const p = document.createElement("div");
  p.className = "w-80 shrink-0 border-l border-zinc-800 pl-3 overflow-auto";
  p.innerHTML = `<div class="font-semibold mb-1 text-zinc-300">Optimizer suggestions</div>` + (hints.length
    ? hints.map((h) => `<div class="mb-2 flex gap-2"><span class="${h.level === "warn" ? "text-amber-400" : "text-sky-400"}">${h.level === "warn" ? "▲" : "●"}</span><span>${esc(h.msg)}</span></div>`).join("")
    : `<div class="text-zinc-500">Nothing to flag.</div>`);
  return p;
}
