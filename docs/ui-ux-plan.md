# Tabnix UI/UX implementation plan (from the v0.15.1 design audit)

Owner: lead UI dev. Executor: Sonnet, one task per focused session. Source audit: `scratchpad/ui-audit/design-audit.md` (findings D1–D20, screenshots `01…31`).
Line numbers below are for **v0.15.1** (`44a9598`). They will drift as phases land, so search for the quoted code rather than trusting the number.

Ground rules for every task:

- **RAM first.** No new dependencies, no frameworks, no per-row DOM, no new whole-tree re-renders. Prefer CSS. If a task seems to need more DOM, stop and ask.
- **Both themes.** Every colour comes from a token in `ui/src/style.css` (`:root` = light, `.dark` = dark). Never hard-code a hex in TS.
- **Cascade gotcha.** The component classes in `style.css` (`.btn`, `.field`, `.tree-row`, …) are *unlayered*, and Tailwind utilities live in `@layer utilities`. Unlayered rules always beat Tailwind utilities, whatever the specificity. So `class="btn px-2"` does **not** change the padding. To vary a component, add a modifier class in `style.css`.
- **Keep the design language** in audit §1 and §5: Kingfisher tokens, glass panels, engine/env identity, grid semantics, safety flows, copy voice, welcome screen.
- **Don't touch** `ui/src/profile.ts`, `ui/src/mock.ts` (unless a task says so), Rust code, or `DEFAULT_EDITOR_SIZE`.
- Mock: `cd ui && npx vite --port 5199`, then open http://localhost:5199/?mock. Connect "Shop – local" and open `orders` to get a table tab.

---

## 1. Audit verification

Legend: ✅ confirmed · ◐ partly right / needs a change · ✗ wrong.

| # | Verdict | Code reality (v0.15.1) and what changes in this plan |
|---|---|---|
| D1 toolbar clips | ✅ | `main.ts` `makeTab()` L282–323: a non-wrapping bar appended as `segWrap, filter, diagram, +Row, −Row, sep, commit, discard, info`. **Missed by the audit:** the query bar (`queryBar()` L1860) and the edit bar overflow the same way at about 620px. **Change:** keep the Diagram button but make it icon-only; removing it would drop the one-click "this table's relations" entry from the bar. **Container queries are safe:** Tauri 2 on macOS uses the system WKWebView, which is the installed Safari's WebKit. Tailwind v4 already needs Safari ≥16.4, so container queries (16.0) and `color-mix` (16.2) are within the existing baseline. `@starting-style` (17.5) is progressive enhancement only. |
| D2 commit cluster | ✅ | `refreshBar()` L324 toggles `display:none` in the middle of the bar. `commitAll` (L766) is reachable only through ⌘⌥S. `setMode()` L891 hides buttons by `data-label`, so labels must stay stable (see Task 2.2). |
| D3 two dialog systems | ✅ | `confirmSql()` L864 and `connections.ts` L24–73 use bespoke overlays. **Risk:** `modal()` closes on a backdrop click, which would throw away a half-typed connection form, so we add a `backdropClose:false` option. **Missed bug:** `confirmSql`'s ⌘↵ listener (L876) doesn't stop propagation, so the global handler *also* fires `run`/`reload`. On a dirty query tab that pops a second "Discard pending changes?" dialog. Fixed in 0.1. |
| D4 palette | ◐ | `palette()` L2036 lists `conn.objects` only. Reusing `ACTIONS` + `handlers` is right. **⌘/ conflicts** with CodeMirror's `Mod-/` toggleComment (the global handler fires too, because CM doesn't stop propagation). **Change:** no new fixed shortcut. Typing `>` in ⌘P lists every action with its key, and that is the cheat-sheet (see open question Q1). |
| D5 orphan header | ✅ | `Grid` constructor L73 draws the head band unconditionally. `openQueryTab()` L1340 removes the empty state. **Correction:** the "Recent queries" box *is* built for restored tabs (in `makeTab`). Removing the empty state is what loses it. When we keep the empty state on a tab that already holds SQL, we must **remove the Recent box**: clicking a recent entry replaces the whole editor text. We must also clear `t.shown`. |
| D6 ⌘↵ twice | ✅ | CM keymap L224–225 plus the global keydown L2123. CM calls `preventDefault` but not `stopPropagation`. **The audit's fix is wrong:** removing the bindings lets CM's `defaultKeymap` `Mod-Enter → insertBlankLine` run, which inserts a newline. A blanket `defaultPrevented` bail-out would also change ⌘L, ⌘I and ⌘F behaviour inside the editor. **Fix:** keep the two CM entries as no-op swallowers and let the global (rebindable) handler run the query. |
| D7 type/radius sprawl | ◐ | Counted: 12× `text-[13.5px]`, 13× `12.5px`, 2× `11.5`, 2× `10.5`, 1× `14.5`, plus 7 CSS declarations. **Change:** sweep the half sizes only. Keep the editor default of 13.5 (it's user content and a stored setting). Defer the grid header 34→32 and the compact `--row-h` (that's a new feature touching the virtualisation math). |
| D8 sidebar hierarchy | ◐ | **Wrong premise:** the sidebar *always* shows exactly one server and one database (`renderObjects()` L1462–1466). So "when exactly one server is open" is meaningless. Make the server card compact always. Level-2 rows are 28px, not 32px. (5), the env-pill inversion, is dropped as low value. |
| D9 dirty rows | ◐ | CSS L144–145 confirmed. **Correction:** don't unify `--edit-soft` with `--dirty-bg`. In dark, `--null` on `--dirty-bg` is 3.17:1, so edited cells holding `null` would fail AA. |
| D10 tabs | ✅ | `renderTabs()` L445 rebuilds every tab. `closeTab()` L427 discards edits silently. **Missed:** `closeDatabase()` / `disconnectServer()` also drop staged edits silently. `d.onauxclick` (L466) closes on *any* non-primary button, including right-click where WebKit fires auxclick. The overflow fade needs a JS class, because CSS can't detect overflow. |
| D11 danger buttons | ◐ | `confirmDanger` uses `.btn-careful` (`dbadmin.ts` L129). Restore on production uses `.btn-primary` (`backup.ts` L96). **Wrong value:** white on the proposed dark `#e0526a` is **3.76:1**, not 4.6. Dark uses `#ff8296` with text `#3b0d17` (7.07:1) instead, the same light-on-dark idiom as `--on-accent`. |
| D12 title-bar icons | ✅ | L143–145. `renderLog()` L545 marks "on" with `text-accent` only. |
| D13 feedback | ✅ | `toast()` `ui.ts` L20. Error panel `exec()` L657–666 and `showResult()` L1140. `commitChanges()` L747 has no success toast. |
| D14 contrast | ◐ | Recomputed with the WCAG formula. **The audit's light `--tok-comment:#6b7c8c` is 4.30:1, a fail.** Use `#627487` (4.81 on panel, 4.54 on the active line). The audit's light `--null:#5f7183` is 4.07:1 on a *selected* row; use `#566879` (4.65 on `--sel`). **Missed:** dark `--null` on `--sel` is 3.66:1; use `#90a3b1` (4.63). Light `--muted:#566879` is confirmed (5.75 panel / 4.72 raised). |
| D15 connection form | ✅ | `connections.ts`, `field` constant L20. Form logic depends on `name=` attributes and ids, which must be kept. |
| D16 add-row focus | ✅ | `Grid.addRow()` L213 never focuses `body` and never sets `activeCol`. **Change:** don't auto-open an editor; it would commit `NULL` on blur, and column 0 is often an auto-increment PK. Focus the grid and put the active cell on the first editable column. Typing then starts editing (that already works). |
| D17 structure | ◐ | Confirmed. Dropped: "sentence moves to the status bar on first open" (adds state, low value). |
| D18 small controls | ✅ | `filterbar.ts` L33–41 inline seg, `builder.ts` L43, log header L553 (`height:24px`), `countBtn` L191. |
| D19 motion | ◐ | The animation replays because `renderTabs()` recreates the selected tab on every activate (confirmed). **Risk:** adding `@starting-style` to `.glass-strong` would also animate the *active rail item* (`renderRail()` L491 uses `glass-strong`) on every tab switch. Use a dedicated `.dlg` class instead. |
| D20 launcher | ✅ | `showLauncher()` L1921 sorts by name. The pill slot swaps "connected" for the env pill (L1941). The recency sort is open question Q2. |

**Missed by the audit, fixed in Phase 0 because they are bugs or leaks:**

1. **Dialog leak (RAM).** `confirmDanger` (`dbadmin.ts` L133), `promptName` (L103) and `pickDatabase` (`dbpicker.ts` L24) each start a `MutationObserver` on `document.body` that is never disconnected. Every closed dialog stays alive, closure and DOM included, and its callback runs on every body mutation (toasts, menus) for the rest of the session.
2. **Shortcuts leak through dialogs.** The global handler runs while a `modal()` is open. ⌘S during a commit review opens a second review. ⌘C copies grid rows instead of the text selected in a dialog. ⌘N opens a second connection manager. And Esc to close a dialog *also cancels a running query* (L2124).
3. The `confirmSql` ⌘↵ propagation bug (see D3).

**Noted only, not in scope:** `activate()` → `renderTabs()` → `renderRail()` + `renderObjects()` + `renderLog()` rebuilds the whole sidebar on every tab switch. That's a perf/RAM item for a separate pass, so don't "fix" it inside these UI tasks.

---

## 2. Scope and order

| Phase | Version | Theme | Findings | Effort |
|---|---|---|---|---|
| 0 | **0.15.2** | Correctness and hygiene, no visual change | D5, D6, missed 1–3 | S |
| 1 | **0.16.0** | Tokens, buttons, type scale (foundation for everything after) | D14, D11, D18, D7 (reduced) | S–M |
| 2 | **0.16.1** | Toolbars that fit, plus a fixed changes cluster | D1, D2 (bar), D16 | S |
| 3 | **0.16.2** | Uncommitted changes visible everywhere | D9, D10 (dirty), D2 (status/menu), D3 (`confirmSql`), D13 (commit toast), close guards | M |
| 4 | **0.17.0** | Dialogs and feedback | D3/D15 (connection manager), D13, D12, D17 | M |
| 5 | **0.17.1** | Command palette | D4 | M |
| 6 | **0.17.2** | Sidebar density, tabs, motion, launcher | D8, D10 (styling), D19, D20 | M |

Why this order: Phase 0 fixes defects users already hit and adds the `modal()` API that later phases need. Phase 1 adds the tokens and button styles that phases 2–4 consume. Editing safety (2–3) has the highest daily value. Palette and polish come last. Every phase builds, tests and ships on its own.

**Dropped or deferred, with reasons:**

- Removing the per-tab Diagram button (D1.3): made icon-only instead, so the feature isn't lost.
- `⌘/` cheat-sheet (D4): conflicts with the editor's toggle-comment. The palette `>` mode replaces it.
- Editor default 13.5→13, grid header 32px, compact `--row-h` (D7/§3): user-visible content change, or a new feature.
- `--edit-soft: var(--dirty-bg)` (D9): fails AA for nulls in dark.
- The audit's dark `--danger-solid` and light `--tok-comment`/`--null` values (D11/D14): failed AA. Corrected values are used.
- Env pill inversion on hover (D8.5), and the structure sentence moved to the status bar (D17): low value, adds state.
- `@starting-style` on `.glass-strong` (D19): would animate the rail. Uses `.dlg` instead.
- Toast stacking: rejected, as the audit also says (single slot keeps the DOM constant).

---

## 3. Phases and tasks

### Phase 0 · v0.15.2 · Correctness and hygiene

#### Task 0.1: Run a query once per ⌘↵ (D6)
- **File:** `ui/src/main.ts`, `makeTab()`, CodeMirror `keymap.of([...])` (L223–228).
- **Change:** replace the first two entries with swallowers and add a comment:
  ```ts
  // ⌘↵ / ⌘⇧↵ are run by the global (rebindable) shortcut handler. These entries only stop CodeMirror's own
  // Mod-Enter (insertBlankLine) from also inserting a newline.
  { key: "Mod-Enter", run: () => true },
  { key: "Mod-Shift-Enter", run: () => true },
  ```
- **Don't** add a `defaultPrevented` check to the global handler. It would change ⌘L, ⌘F and ⌘I inside the editor.
- **Acceptance (mock):**
  - Type `SELECT * FROM orders` and press ⌘↵. The SQL log shows **one** entry, History (sidebar) shows **one** entry, and no blank line is inserted.
  - Type two statements and press ⌘⇧↵. You get 2 log entries, not 4.
  - The Run button still works.

#### Task 0.2: `modal()` gets an onClose hook, backdrop option and a modal marker; the dialog observers go away (missed 1, part of 2)
- **File `ui/src/ui.ts` `modal()`.** New signature: `modal(inner: string, width = 560, opts: { backdropClose?: boolean } = {})`.
  - Set `o.dataset.modal = ""`. Add class `dlg` to the inner `<div class="glass-strong …">`; it's used by Phase 6.
  - Add `onClose: undefined as (() => void) | undefined` to the returned `api`.
  - Make `close` idempotent: `let closed = false; const close = () => { if (closed) return; closed = true; o.remove(); window.removeEventListener("keydown", onKey, true); api.onClose?.(); };`. Declare `api` before `close` references it, or use a function declaration.
  - Escape: `if (e.key === "Escape" && !api.blockEsc?.()) { e.preventDefault(); e.stopPropagation(); close(); }`. This stops Esc from also cancelling a running query.
  - Backdrop: `if (opts.backdropClose !== false && e.target === o) close();`.
- **Remove the three leaking observers** and use the hook instead (`finish` is already guarded by `done`):
  - `ui/src/dbadmin.ts` `promptName`: delete the `new MutationObserver(...)` line and add `m.onClose = () => finish(null);`.
  - `ui/src/dbadmin.ts` `confirmDanger`: the same, with `m.onClose = () => finish(false);`.
  - `ui/src/dbpicker.ts`: the same, with `m.onClose = () => finish(null);`. Also delete the dead `origClose` lines (`const origClose = …; void origClose;`).
  - `ui/src/settings.ts` `showSettings`: replace the `obs` MutationObserver with `m.onClose = () => { window.removeEventListener("keydown", onKey, true); capturing = false; };`.
- **Edge cases:** `finish()` calls `m.close()`, which calls `onClose`, which calls `finish()` again. The `done` guard makes the second call a no-op. Keep the guard.
- **Acceptance:**
  - Each dialog resolves correctly on Cancel, Esc, backdrop click and confirm: drop table (typed), delete row, new database, ⌘K picker, Settings.
  - In Chrome devtools (mock), use Memory → "Detached elements" or a heap snapshot after opening and closing a confirm 10 times. No `glass-strong` detached trees should accumulate.
  - `npm test` passes; `dbadmin.test.mjs` covers the pure parts.

#### Task 0.3: Global shortcuts stay quiet while a dialog is open; `confirmSql` ⌘↵ no longer leaks (missed 2, 3)
- **File `ui/src/main.ts`, global keydown (L2123).** After `if (capturing) return;`, add:
  ```ts
  if (document.querySelector("[data-modal]")) return; // dialogs own the keyboard (their own listeners run first)
  ```
- **`confirmSql()` (L864), until Task 3.4 rewrites it:**
  - Set `o.dataset.modal = ""`.
  - In `key`: for Escape and ⌘↵, call `e.preventDefault(); e.stopPropagation();` before `done(...)`. `stopPropagation` in the window capture phase prevents the bubble-phase global handler from running.
- **`ui/src/connections.ts` overlay (L25), until Task 4.1:** set `overlay.dataset.modal = ""`.
- **Don't touch** the palette (`#palette`). It handles its own keys in capture and isn't a `modal()`.
- **Acceptance (mock):**
  - Edit a cell in a query result, press ⌘S, then ⌘↵. It commits once, and no "Discard pending changes?" dialog follows.
  - With the commit review open, ⌘S does nothing.
  - Open Connections (⌘O) and press ⌘N: no second manager opens.
  - Run a slow query, open Settings, press Esc: Settings closes and the query keeps running.

#### Task 0.4: No orphan header band; restored query tabs keep their empty state (D5)
- **`ui/src/grid.ts` `setResult()`:** right after `this.summary = s;`, add `this.head.style.display = s ? "" : "none";`. The head keeps its `flex` class, so `""` restores flex.
- **`ui/src/main.ts` `makeTab()`:** on the Recent-queries `box`, set `box.dataset.recent = ""`.
- **`ui/src/main.ts` `openQueryTab()`:** replace `t.empty?.remove(); t.empty = undefined;` with:
  ```ts
  // Keep the "Results appear here" state, but not the Recent list: clicking one would replace this tab's text.
  t.empty?.querySelector("[data-recent]")?.remove();
  t.shown = undefined; // nothing was shown, so closing this tab must not forget any recent session
  ```
- **Don't** change `exec()` / `execAll()`. They already remove the empty state on the first run.
- **Acceptance (mock):**
  - History → click an entry. The new tab shows the illustration with no Recent list, and there is no grey 34px band (compare `04-query-tab-empty-dark.png`).
  - Run `SELECT 1`: the header appears.
  - Run an `UPDATE …` with no result set: there is no empty header band.

**Phase 0 release:** v0.15.2. LOG line: "Fixes: ⌘↵ ran a statement twice; shortcuts no longer fire behind dialogs; closed dialogs no longer stay in memory; restored query tabs keep their empty state."

---

### Phase 1 · v0.16.0 · Tokens, buttons, type scale

#### Task 1.1: Token changes (D14 corrected, new tokens)
- **File `ui/src/style.css`.**
  - `:root` (light):
    - change `--muted:#5d6e80` → `#566879`, `--null:#6a7b8c` → `#566879`, `--tok-comment:#7a8a99` → `#627487`
    - add `--dirty-stripe:var(--warn); --dirty-row:color-mix(in srgb, var(--warn) 10%, transparent); --danger-solid:#c0354f; --on-danger:#ffffff; --r-xs:4px; --r-xl:16px; --r-pill:999px;`
  - `.dark`:
    - change `--null:#7d909f` → `#90a3b1`
    - add `--dirty-row:color-mix(in srgb, var(--warn) 12%, transparent); --danger-solid:#ff8296; --on-danger:#3b0d17;`
  - Leave `--tok-op`, `--dirty-bg`, `--edit-soft` and every env, engine and accent token unchanged.
- **Expected contrast** (spot-check with any WCAG checker):
  - light: muted/panel 5.75, muted/raised 4.72, null/stripe ≥4.7, null/sel 4.65, comment/panel 4.81
  - dark: null/sel 4.63, null/edit-soft 5.10
  - on-danger/danger-solid: light 5.44, dark 7.07
- **Acceptance:** light and dark screenshots of the table tab and a query tab with comments. Nothing should look different apart from slightly darker muted text and nulls.

#### Task 1.2: Button states, `.btn-danger`, `.btn-sm`, `.field-sm` (D11, D18 CSS)
- **File `ui/src/style.css`.** Add these after the `.btn-careful` rules:
  ```css
  .btn-danger { background: var(--danger-solid); color: var(--on-danger); box-shadow: inset 0 1px 0 rgb(255 255 255/.14); }
  .btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger-solid) 88%, #000); }
  .dark .btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger-solid) 88%, #fff); }
  .btn-danger:focus-visible, .btn-careful:focus-visible { outline-color: var(--danger); }
  .btn-primary:disabled, .btn-careful:disabled, .btn-danger:disabled { opacity: 1; background: var(--raised); color: var(--muted); box-shadow: none; }
  .btn-sm { height: 26px; padding: 0 9px; gap: 6px; font-size: 13px; }
  .field-sm { height: 26px; padding: 0 8px; font-size: 13px; }
  ```
  - Keep `.btn:disabled { opacity:.45 }` for plain and ghost buttons.
- **Use `.btn-danger`:**
  - `ui/src/dbadmin.ts` `confirmDanger`: the `#yes` button class becomes `btn btn-danger`.
  - `ui/src/backup.ts` `showRestore`: `#go` becomes `btn ${prod ? "btn-danger" : "btn-primary"}`.
  - The delete-connection confirm already goes through `confirmDanger`.
- **Don't change** the toolbar Commit on production. It stays `.btn-careful` (outline).
- **Acceptance:**
  - Drop table: the disabled Drop button is clearly grey, then solid red once the name is typed, with a red focus ring and no blue ring.
  - Restore on a production profile: grey until the box is ticked, then solid red.
  - Structure tab: the disabled "Review & commit" is grey.
  - Check both themes.

#### Task 1.3: Small-control adoption (D18 usage)
- **`ui/src/main.ts`:**
  - `renderLog()`, the `mk` helper: `b.className = "btn btn-ghost btn-sm"` (delete `b.style.height`).
  - `makeTab()` `countBtn`: `className = "btn btn-ghost btn-sm shrink-0"`, with `style.cssText = "display:none"`.
- **`ui/src/filterbar.ts`:**
  - The Rules/SQL toggle: the container class becomes `seg ml-2`. Each button gets no class, no inline style, and `b.setAttribute("aria-pressed", String(on))`.
  - The Clear and Apply buttons get `btn-sm`.
  - Selects and inputs get `field field-sm`.
- **`ui/src/builder.ts` L43:** the button class becomes `"btn btn-sm " + cls`.
- **Acceptance:**
  - ⌘F filter bar: Rules/SQL looks like the Data/Structure segmented control.
  - The log header buttons are 26px.
  - Builder (⌘B) buttons look like app buttons.

#### Task 1.4: Remove half-pixel type sizes; tokenise the leftover radii (D7 reduced)
- **Mapping, in all of `ui/src/*.ts` and `style.css`:** `13.5px→13px`, `12.5px→12px`, `11.5px→11px`, `10.5px→11px`, `14.5px→14px`. That covers both Tailwind arbitrary values (`text-[13.5px]`) and CSS/inline `font-size`.
- **Exceptions (keep 13.5):** the `var(--editor-size, 13.5px)` fallbacks in `style.css` (`.cm-gutters`, `.cm-content`) and `DEFAULT_EDITOR_SIZE` in `settings.ts`.
- **Radii in `style.css`:**
  - `.card` `14px` → `var(--r-xl)`
  - `.srv-card` `10px` → `var(--r-lg)`
  - `.kbd` `4px` → `var(--r-xs)`
  - `.tree-row` `8px` → `var(--r-md)`
  - `.seg` `8px` → `var(--r-md)`; `.seg > button` `6px` → `var(--r-sm)`
  - `.pill` `999px` → `var(--r-pill)`
  - Leave the grip, scrollbar and SVG radii.
- **Acceptance:**
  - `grep -rnE "(13|12|11|10|14)\.5px" ui/src` lists only the editor-size lines.
  - Light and dark screenshots at 1440 show no clipped text in buttons, tabs, pills or the status bar.

**Phase 1 release:** v0.16.0. RAM: CSS and class names only; `memprofile` isn't required (state this in LOG).

---

### Phase 2 · v0.16.1 · Toolbars that fit, plus a fixed changes cluster

#### Task 2.1: Container query collapses toolbar labels (D1)
- **`ui/src/style.css`.** Add:
  ```css
  #main { container: main / inline-size; }
  .tbar { overflow: hidden; }
  .tbar > .pill { min-width: 0; flex-shrink: 1; overflow: hidden; white-space: nowrap; }
  @container main (max-width: 820px) {
    .tbar .btn:not(.keep-label) > span:not(.kbd) { display: none; }
    .tbar .btn:not(.keep-label) { padding: 0 8px; }
    .tbar .btn .kbd, .tbar .hint { display: none; }
  }
  ```
- **`ui/src/main.ts`:** add class `tbar` to the table bar (`bar.className`), the `queryBar()` bar and `tab.editBar`. Add `keep-label` to the query bar's **Run** button. Every toolbar button already has an icon.
- **Edge cases:**
  - `.seg` buttons (Data/Structure) have no `.btn` class, so they keep their labels. That's intended.
  - `setMode()` writes inline `style.display` on `.hint` elements. Inline `""` doesn't override the container rule, which is fine.
  - The 820px threshold is the width of `#main`, not the window.
- **Acceptance:** screenshots at 1000×680 with the default sidebar, and at 1440 with the sidebar dragged to 520px. The table bar shows icon-only Filter/Diagram/Add/Delete with Commit/Discard fully visible after an edit. The query bar shows "Run" plus icon-only buttons. At 1440 with the default sidebar, the labels are back.

#### Task 2.2: Table bar order, icon-only Diagram, fixed changes cluster, better hint (D1, D2, D16 copy)
- **File `ui/src/main.ts` `makeTab()`, table branch.**
- **Imports:** add `comboOf, prettyCombo` to the `./settings` import.
- **New order:** `bar.append(segWrap, ...(sqlLike ? [filterBtn, diagBtn] : []), addRow, delRow, sep, info, changes)`.
- **`diagBtn`:** build it with an empty label: `btn("", "Show this table's relations (⌘⇧D)", …, "diagram", "btn btn-ghost")`. Then set `diagBtn.dataset.label = "Diagram"`, `style.cssText = "width:30px;padding:0;justify-content:center"` and `aria-label = "Diagram"`.
- **Labels:**
  - `addRow` visible text is `"Add row"`, title `Insert row (${prettyCombo(comboOf("addRow"))})`.
  - `delRow` visible text is `"Delete row"`, title `Delete selected rows (${prettyCombo(comboOf("deleteRow"))})`.
  - **Keep** `dataset.label = "+ Row"` / `"− Row"`, because `setMode()` keys on them.
- **`info`:** class `hint text-muted truncate flex-1 min-w-0 ml-2`.
- **`changes` cluster:** a `div`, class `data-only flex items-center gap-1.5 shrink-0`, containing:
  1. `pill`: `<span class="pill"><span style="width:6px;height:6px;border-radius:3px;background:var(--dirty-stripe)"></span><span></span></span>`
  2. the existing `commit` button with class `keep-label`. Its inner HTML is `icon("commit",14) + "<span>Commit</span>" + kbd(prettyCombo(comboOf("commit")))`, where `kbd(x)` = `<span class="kbd" style="color:inherit;border-color:currentColor;opacity:.7;background:transparent">${x}</span>`
  3. the existing `discard` button with class `keep-label`
  4. `idle`: `<span class="text-muted text-[12px]">No changes</span>`
- **`refreshBar()`** becomes:
  - `n = grid.pendingCount`
  - `pill`, `commit` and `discard` show only when `n`
  - the pill text is `${n} change${n===1?"":"s"}`
  - `commit.className = "btn keep-label " + (prod ? "btn-careful" : "btn-primary")`, with `prod` as today
  - `idle` shows only when `!n && grid.editable && tab.cols`
  - `info.textContent`:
    - `!tab.cols` → `""`
    - editable → ``Double-click, Enter or type to edit · ${prettyCombo(comboOf("addRow"))} adds a row``
    - otherwise the read-only reason: readonly connection → `"Read-only connection"`; the object is a view → `"Read-only: views can't be edited here"`; else → `"Read-only: this table has no primary key"`
  - Get the object via `tab.conn.objects.find(x => x.name === tab.table)`.
- **`setMode()`:**
  - Change `querySelectorAll(".hint")` to `querySelectorAll(".hint, .data-only")`.
  - Remove `"Commit", "Discard"` from `dataOnly`. The cluster now hides as a whole in Structure mode.
- **`paintEditBar()`** (query results): same idea. `info` stays flex-1. When `n`, append the same pill, then Commit (`keep-label`, kbd) and Discard (`keep-label`).
- **Don't** change `commitChanges`, `discardChanges` or the shortcuts.
- **Acceptance (mock, `orders`):**
  - At rest: "No changes" sits at the right and the hint is on the left.
  - Edit a cell: the pill "● 1 change", Commit ⌘S and Discard appear at the right edge without moving Filter or Add row.
  - Structure tab: the cluster is hidden.
  - A production profile shows the outlined rose Commit.
  - A query result edit bar shows the same cluster.
  - Rebind addRow in Settings: the hint text shows the new key after a reload.

#### Task 2.3: Add row focuses the grid (D16)
- **`ui/src/grid.ts` `addRow()`.** After `this.body.scrollTop = this.body.scrollHeight;`:
  ```ts
  this.activeCol = Math.max(0, this.editCols ? this.editCols.indexOf(true) : 0);
  this.render();
  this.body.focus({ preventScroll: true }); // Delete, arrows and typing now act on the new row
  ```
- **Don't** call `startEdit`.
- **Acceptance:**
  - Click Add row: the new row is outlined on its first cell. Type `x` and the cell editor opens with "x".
  - Click Add row, then press Delete: the new row disappears with no confirmation.
  - ⌘I does the same as the button.

**Phase 2 release:** v0.16.1. RAM: one cluster element per table tab; there's no per-row DOM.

---

### Phase 3 · v0.16.2 · Uncommitted changes visible everywhere

#### Task 3.1: Sidebar dirty rows get a stripe and a count (D9)
- **`ui/src/style.css`:** replace the two `.tree-row[data-dirty…]` rules with:
  ```css
  .tree-row[data-dirty="true"] { background: var(--dirty-row); box-shadow: inset 3px 0 0 var(--dirty-stripe); }
  .tree-row[data-dirty="true"][aria-current="true"], .tree-row[data-dirty="true"][data-selected="true"] { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--dirty-stripe); }
  .dirty-n { flex: none; height: 18px; line-height: 18px; padding: 0 6px; border-radius: var(--r-pill); font-size: 11px; font-weight: 600; color: var(--ink); background: color-mix(in srgb, var(--warn) 22%, transparent); }
  ```
- **`ui/src/main.ts`:** add one helper next to `syncDirtyRows`:
  ```ts
  function paintDirty(row: HTMLElement, n: number | undefined) {
    let badge = row.querySelector<HTMLElement>(".dirty-n");
    if (n) { row.dataset.dirty = "true"; row.title = `${n} uncommitted change${n === 1 ? "" : "s"}`; if (!badge) { badge = document.createElement("span"); badge.className = "dirty-n group-hover:hidden"; row.insertBefore(badge, row.querySelector(".group-hover\\:flex")); } badge.textContent = String(n); }
    else { if (row.dataset.dirty) row.title = "Double-click to open"; delete row.dataset.dirty; badge?.remove(); }
  }
  ```
  - Use it in `syncDirtyRows()` (the replacement for the inline if/else).
  - Use it at the end of `treeRow()` when `o.dirty` (delete the old `if (o.dirty) d.dataset.dirty…` and the title line).
  - The badge goes before the hover-actions box, if any.
- **Acceptance (both themes):**
  - Edit 2 cells in `orders`: the sidebar row gets an amber stripe, a faint tint and a "2" badge.
  - When `orders` is also the active row, the stripe is amber over the accent-soft fill.
  - ⌘-click it into a multi-selection: the fill is accent-soft with the amber stripe and no outline.
  - Discard: everything is removed.

#### Task 3.2: Dirty dot on tabs (D10.1)
- **`ui/src/main.ts` `renderTabs()`:**
  - `d.dataset.tab = String(t.id)`. If `t.grid.pendingCount`, set `d.dataset.dirty = "true"`.
  - Before the close button, append `<span class="tab-dot" aria-hidden="true"></span>`.
  - Give the close button the extra class `tab-x`.
- **`syncDirtyRows()`:** also run
  ```ts
  document.querySelectorAll<HTMLElement>("#tabs [data-tab]").forEach((el) => { const t = tabs.find((x) => x.id === +el.dataset.tab!); if (t?.grid.pendingCount) el.dataset.dirty = "true"; else delete el.dataset.dirty; });
  ```
- **Query tabs:** in `makeTab()`, change `grid.onChange = () => paintEditBar(tab);` to `grid.onChange = () => { paintEditBar(tab); syncDirtyRows(); };`.
- **CSS:**
  ```css
  .tab-dot { display: none; width: 6px; height: 6px; margin: 0 7px; border-radius: 3px; background: var(--dirty-stripe); flex: none; }
  .tab[data-dirty="true"] .tab-dot { display: block; }
  .tab[data-dirty="true"]:not(:hover) .tab-x { display: none; }
  .tab[data-dirty="true"]:hover .tab-dot { display: none; }
  ```
- **Acceptance:** edit a cell and the tab shows an amber dot instead of ×. Hover shows ×. Commit or Discard removes the dot. The same works for an editable query result.

#### Task 3.3: Status-bar pill, and "Commit all" in menus (D2)
- **`Tab` interface:** add `pendingPill?: HTMLButtonElement`.
- **`makeTab()`:** after `statusBar.append(status)`, add a `button` with class `pill shrink-0`, `style.display = "none"`, `title = "Commit all tables in this database (" + prettyCombo(comboOf("commitAll")) + ")"`, `onclick = () => commitAll()`. Insert it before `countBtn` and store it as `tab.pendingPill`.
- **`syncDirtyRows()`:** compute `dirty = dirtyTables(conn)`, `total = sum of values`, `k = dirty.size`. For `active?.pendingPill`:
  - set its display to `k ? "" : "none"`
  - set its innerHTML to the dot span plus `${total} uncommitted · ${k} table${k===1?"":"s"}`
- **`activate()`:** call `syncDirtyRows()` at the end, so the pill of a newly shown tab is fresh.
- **`dbMenu()`:** when `dirtyTables(c).size`, insert this after the Diagram item:
  `{ label: `Commit all (${n} table${n===1?"":"s"})…`, hint: prettyCombo(comboOf("commitAll")), action: () => { conn = c; commitAll(); } }`
- **`renderObjects()`, database row (level 1) actions:** when `dirty.size`, prepend the action `{ ic: "commit", title: `Commit all (${dirty.size})`, fn: () => { conn = c; commitAll(); } }`.
- **Edge case:** `dirtyTables` counts table tabs only. That matches what `commitAll` commits, so don't add query-result edits to the pill.
- **Acceptance:**
  - Edit two tables: every tab of this DB shows "● 3 uncommitted · 2 tables". Clicking it opens the review.
  - Right-click the DB row and "Commit all (2 tables)…" is there.
  - After committing, the pill hides.

#### Task 3.4: Commit review through `modal()` (D3, part 1)
- **`ui/src/main.ts`:** rewrite `confirmSql(stmts: string[], opts: { title?: string; careful?: boolean } = {})`.
  - `count = stmts.filter(s => !s.startsWith("--")).length`.
  - Markup, width 640:
    ```html
    <div class="px-5 pt-4 pb-2"><div class="text-[16px] font-semibold">${esc(opts.title ?? "Review changes")}</div><div class="text-soft mt-0.5">${subtitle}</div></div>
    <pre id="sql" class="mono text-[12px] mx-5 mb-3 p-3 rounded-lg bg-canvas overflow-auto select-text whitespace-pre-wrap" style="max-height:52vh"></pre>
    <div class="px-5 py-3 border-t border-line flex items-center gap-2"><span class="text-muted text-[12px] mr-auto">⌘↵ commit · Esc cancel</span><button id="no" class="btn">Cancel</button><button id="yes" class="btn keep-label ${opts.careful ? "btn-careful" : "btn-primary"}">${icon("commit", 14)}<span>Commit</span></button></div>
    ```
  - `subtitle`:
    - single table: `${count} statement${s} · one transaction`
    - with `opts.title` (commit all): `${count} statements · one transaction per table`
  - Set the text via `m.q("#sql").textContent = stmts.join("\n")`.
  - `m.onClose = () => finish(false)`.
  - Add a capture keydown listener that, for ⌘/Ctrl+Enter, calls `preventDefault(); stopPropagation(); finish(true)`. Remove the listener in `finish`.
  - Focus `#yes`.
- **Callers:**
  - `commitChanges`: `confirmSql(stmts, { careful: t.conn.env === "production" })`
  - `commitAll`: `{ title: `Commit ${plan.length} table${…}`, careful: c.env === "production" }`
  - structure apply in `setMode`: `{ title: "Review structure changes", careful: conn.env === "production" }`
- **Delete** the Phase 0 interim code in the old `confirmSql`.
- **Acceptance:**
  - The review looks like `14-confirm-drop-typed-dark.png` chrome (glass, 16px radius, blurred backdrop).
  - Production shows a rose outlined Commit.
  - ⌘↵ commits once, Esc and backdrop cancel, and the structure commit still works.

#### Task 3.5: Commit toasts (D13, part)
- **`commitChanges()`:** capture `const n = t.grid.pendingCount` before applying. After success, call `toast(`Committed ${n} change${n===1?"":"s"} to ${target.table}`, "ok")`.
- **Structure apply callback in `setMode`:** after success, call `toast(`Updated the structure of ${name}`, "ok")`.

#### Task 3.6: Don't lose edits on close (D10.2, missed)
- **`ui/src/main.ts`:** add
  ```ts
  /** Ask before closing tabs that hold staged edits. Resolves true when it is fine to go ahead. */
  async function okToDropEdits(list: Tab[], what: string): Promise<boolean> {
    const n = list.reduce((a, t) => a + t.grid.pendingCount, 0);
    if (!n) return true;
    return confirmDanger({ title: `${what}?`, body: `${n} uncommitted change${n === 1 ? "" : "s"} will be thrown away.`, confirmLabel: "Discard and close" });
  }
  ```
- **Use it at the user entry points only:**
  - the tab × (`x.onclick`) and middle-click: `d.onauxclick = (e) => { if (e.button === 1) …; }`. Also add `d.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); }` so there's no autoscroll.
  - `handlers.closeTab`
  - `dbMenu` "Close this database", plus the sidebar DB-row close action (`tabs.filter(t => t.conn === c)`)
  - `serverMenu` "Disconnect", plus the server-card disconnect action (all tabs of `s.conns`)
  - Pattern: `okToDropEdits([t], `Close ${t.title}`).then((ok) => ok && closeTab(t))`.
- **Don't** add it inside `closeTab()`, `closeDatabase()` or `disconnectServer()`. Those are also called after drop-table/drop-database (already confirmed) and by `profile.ts`.
- **Acceptance:**
  - Edit a cell and press ⌘W: you're asked, and Cancel keeps the tab and its edits.
  - Middle-click a dirty tab: you're asked. Right-click a tab: it does **not** close.
  - Close the DB from the menu with edits: you're asked once.

**Phase 3 release:** v0.16.2. RAM: a pill button per tab and a badge per dirty sidebar row. Run the `tabs20` scenario of `memprofile.sh` (it opens 20 tabs).

---

### Phase 4 · v0.17.0 · Dialogs and feedback

#### Task 4.1: Connection manager on `modal()`, with sections (D3, part 2, and D15)
- **File `ui/src/connections.ts`.**
- **Overlay:** replace the overlay with `const m = modal(html, 800, { backdropClose: false })`, use `const q = m.q`, and drop the custom `onKey` and Escape handling. `close` becomes `m.close`.
- **Body:** `<div class="flex" style="height:min(620px,80vh)">`
  - **Left list:** `w-[240px] border-r border-line flex flex-col`, with `#list` scrolling.
    - "New connection" is `btn btn-ghost m-2` with `icon("plus",14)`.
  - **Right side:** a `form#form` with class `flex-1 flex flex-col min-w-0`. It holds a scrolling body (`flex-1 overflow-auto px-5 py-4 flex flex-col gap-3`) and a footer (`px-5 py-3 border-t border-line flex items-center gap-2`).
- **Fields:**
  - Replace the `field` constant with `"field w-full"`.
  - Each label becomes `<label class="flex flex-col gap-1"><span class="text-[12px] text-soft">Name</span><input …></label>`.
  - Keep **all** `name=` attributes and ids: `#list #new #form #tagbox #tagchips #taginput #tagsug #net #ssh #file #browse #msg #del #close #test #save`.
- **Sections:** captions use `<div class="text-[11px] font-semibold uppercase tracking-wide text-muted pt-1">…</div>`.
  - **General:** Name, Tags, Environment + Safety on one row.
  - **Connection:** Type.
  - Inside `#net`, **Server:** Host/Port, User/Password, Database/SSL, then the SSH checkbox, then `#ssh`.
  - Inside `#file`, **File:** path plus Browse (`btn`).
- **Footer:**
  - `#del`: `btn btn-ghost text-danger mr-auto`, hidden (`style.visibility`) when `current` is null
  - `#close`: `btn btn-ghost`
  - `#test`: `btn btn-ghost`
  - `#save`: `btn`
  - submit: `btn btn-primary`, labelled "Connect"
  - `#msg` moves into the footer, left of the buttons (`text-[12px] truncate`).
- **List rows** (`refresh()`): the row is `flex items-center gap-2.5 px-2.5 h-11 rounded-lg mx-1.5`, selected `bg-accent-soft`, with:
  - `engineBadge(p.kind, 22)`
  - two lines: the name (13px, truncate) and the muted host or file (12px, mono, truncate)
  - for non-local, `box-shadow: inset 3px 0 0 ${envColor(p.environment)}`
  - Import `engineBadge, envColor` from `./icons`.
  - Escape the host with `esc`.
- **Edge cases:**
  - The `tagInput.onkeydown` `stopPropagation` stays.
  - Esc while typing a tag closes the dialog (`modal` is a capture listener). That's acceptable and the same as today.
  - Double-click on a list row still submits.
- **Acceptance (mock):** compare with `02-connection-form-dark.png`.
  - Sections, consistent fields and focus rings.
  - The list shows badges, hosts and env edges.
  - Clicking the backdrop doesn't close the dialog; Esc and Close do.
  - Test, Save, Connect and Delete (with confirm) all work.
  - SQLite shows the File section only, and the SSH toggle reveals its fields.

#### Task 4.2: Toasts with an icon, a dismiss button and a live region (D13)
- **`ui/src/icons.ts`:** add
  - `info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.5M8 5.2v.1"/>'`
  - `more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>'`
- **`ui/src/ui.ts` `toast()`:**
  - Import `icon` from `./icons`.
  - The single `#toast` element gets `flex items-center gap-2.5`.
  - On each call:
    - the first child is an icon span: ok → `icon("commit",14)` in `var(--ok)`; error → `icon("warn",14)` in `var(--danger)`; info → `icon("info",14)` in `var(--accent)`
    - then a text span (set via `textContent`)
    - for errors only, a close `button.btn.btn-ghost.btn-sm` with `icon("close",12)` and `aria-label="Dismiss"`, which hides the toast
  - `role` is `"alert"` for errors and `"status"` otherwise.
  - Duration: ok/info 5000ms, error 8000ms.
  - Keep the single slot (replace the children, never append new toasts).
  - Keep the 3px left border colour.
- **Acceptance:** copy a row (ok), use ⌘⇧S on an empty tab (info), and try a protected drop (error, with ×). The toast stays on screen long enough to read.

#### Task 4.3: Readable error panel with Copy (D13)
- **`ui/src/main.ts`:** add a helper `errorPanel(title: string, message: string, ms?: number): HTMLElement` that returns a `div.h-full.overflow-auto.p-5` with:
  - a header row `flex items-center gap-2 mb-2`:
    - `<span class="text-danger font-medium">${title}</span>`
    - `ms` text when given (`text-muted text-[12px]`)
    - a flex-1 spacer
    - a Copy button (`btn btn-ghost btn-sm`, with `navigator.clipboard?.writeText(message)` then `toast("Error copied","ok")`)
  - a `pre.mono.text-[13px].whitespace-pre-wrap.break-words.select-text` whose first line is in a `span.text-danger`, with the rest as a plain text node in `--ink`
- **Use it in:**
  - `exec()` catch: title `"Query failed"`, message `String(e).replace(/^Error:\s*/, "")`
  - `showResult()` error branch: title `"This statement failed"`, message `r.error`
- **Keep** the non-error branch of `showResult` as it is.
- **Acceptance (mock):** run `SELEC 1`. The header row shows "Query failed" plus Copy, the first line is red and the rest is ink. Run-all with a failing statement gives the same.

#### Task 4.4: Title-bar overflow menu and SQL-log pressed state (D12)
- **`ui/src/main.ts` app HTML (L143–145):** the right cluster becomes `${iconBtn("more","more","Back up, restore, import…")}<span class="w-px h-4 bg-line-strong mx-1"></span>${iconBtn("export",…)}${iconBtn("sqllog-btn",…)}${iconBtn("newtab",…)}`.
- **Remove** the `$("backup")`, `$("restore")` and `$("import")` onclick lines. Add:
  ```ts
  $("more").onclick = () => {
    const r = $("more").getBoundingClientRect(), can = !!conn && BACKUP_KINDS.includes(conn.kind);
    contextMenu(r.left, r.bottom + 4, [
      { label: "Back up…", hint: prettyCombo(comboOf("backup")), disabled: !can, action: backupActive },
      { label: "Restore…", hint: prettyCombo(comboOf("restore")), disabled: !can, action: restoreActive },
      { divider: true, label: "" },
      { label: "Import a file…", hint: prettyCombo(comboOf("import")), disabled: !conn, action: importActive },
    ]);
  };
  ```
- **`renderLog()`:** replace the `classList.toggle("text-accent", …)` with `setAttribute("aria-pressed", String(logOpen))`.
- **CSS:** `.btn-ghost[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }`.
- **Acceptance:** "…" opens a menu with the three items and their shortcuts, disabled with no connection. ⌘⌥B/R/I still work. The SQL button has a tinted pressed state while the log is open.

#### Task 4.5: Structure view polish (D17)
- **`ui/src/structure.ts`:**
  - section `mb-6` → `mb-4`
  - section header `h-9` → `h-8`
  - add class `struct-cell` to the `cell` constant
- **CSS:** `.struct-cell:not(:hover):not(:focus) { border-bottom-color: var(--line); }`. It's unlayered, so it wins over `border-transparent`, and the `:not` keeps the hover/focus colours.
- **Acceptance:** the Structure tab shows faint underlines on the editable cells. The disabled "Review & commit" is grey (from 1.2).

**Phase 4 release:** v0.17.0. RAM: the dialogs are transient and the toast DOM stays constant. No `memprofile` run is needed beyond a quick `cold` scenario.

---

### Phase 5 · v0.17.1 · Command palette (D4)

#### Task 5.1: Pure ranking module and tests
- **New file `ui/src/palette-rank.ts`:**
  ```ts
  export interface PalObj { name: string; kind: string; schema?: string | null }
  export interface PalAction { id: string; label: string; group: string; combo: string }
  /** Objects and actions for the ⌘P query. ">" prefix = actions only. */
  export function paletteResults(query: string, objects: PalObj[], actions: PalAction[], max = { objects: 50, actions: 6 }): { objects: PalObj[]; actions: PalAction[] }
  ```
- **Rules:**
  - `q = query.trim().toLowerCase()`. The action with `id === "palette"` is never returned.
  - **Commands mode** (`q` starts with `>`): `rest = q.slice(1).trim()`. Objects are `[]`. Actions are all actions (ACTIONS order) when `rest` is empty; otherwise the actions where `wordMatch(label, rest)`. Uncapped.
  - **Default mode:**
    - Objects: those whose name includes `q`. Rank: exact (case-insensitive) first, then prefix, then other substring, keeping the original order within a rank. Capped at `max.objects`. Empty `q` returns the first `max.objects`.
    - Actions: `[]` when `q` is empty; otherwise `wordMatch`, capped at `max.actions`.
  - `wordMatch(label, t)`: true when `label.toLowerCase().startsWith(t)` **or** a word of the label (split on `/[^a-z0-9]+/`) starts with `t`. So "commit" matches "Commit changes" but not "Discard uncommitted changes".
- **`ui/package.json` `test` script:** add `esbuild src/palette-rank.ts --format=esm --outfile=.test-build/palette-rank.mjs --log-level=error &&` before `node --test`.
- **New file `ui/test/palette.test.mjs`** (use the style of `selection.test.mjs`), with these cases:
  1. Empty query: all objects (≤ max), no actions.
  2. `"ord"` with objects `[customer_orders, orders, ord]`: order is `ord, orders, customer_orders`.
  3. `">"`: every action except `palette`, in input order, with no objects.
  4. `">commit"`: `Commit changes` and `Commit all tables…` but not `Discard uncommitted changes`.
  5. `"theme"` with no object match: no objects, and an action list containing the theme action.
  6. Case-insensitive: `"ORD"` behaves like `"ord"`.
  7. Respects `max.objects`.
  8. `"> "` (space after `>`) behaves like `">"`.

#### Task 5.2: Palette UI with sections, actions and a footer
- **`ui/src/main.ts`:**
  - Import `paletteResults` and `ACTIONS`.
  - The `#pinput` placeholder becomes `"Open a table, or type > for actions"`.
  - Add a footer inside the palette panel after `#plist`: `<div class="px-4 h-8 flex items-center gap-4 text-[12px] text-muted border-t border-line"><span>↑↓ navigate</span><span>↵ open</span><span>&gt; actions</span><span>esc close</span></div>`.
- **`palette()` `draw()`:**
  - Call `res = paletteResults(inp.value, conn?.objects ?? [], ACTIONS.map(a => ({ ...a, combo: comboOf(a.id) })))`.
  - Build a flat `items: ({ t: "o"; o: ObjectRef } | { t: "a"; a: PalAction })[]` with objects first.
  - Render a non-selectable header before each non-empty section: `<div class="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Tables &amp; views</div>` / `Actions`.
  - Action rows: `icon("sparkle",14)` + label + `<span class="ml-auto kbd">${prettyCombo(a.combo)}</span>`. In the selected row, give the kbd `color:inherit;border-color:currentColor;background:transparent`.
  - `idx` indexes `items` only, never the headers; `scrollIntoView` targets the selected row element.
- **`choose(item)`:**
  - object → `close(); openTable(o.name)` (as today)
  - action → `close(); handlers[a.id]?.(new KeyboardEvent("keydown"))`. `handlers` is defined later in the module, which is fine at runtime.
- **Also:**
  - The rail settings button title becomes `Settings and keyboard shortcuts (${prettyCombo(comboOf("settings"))})`.
  - The sidebar `⌘P` / `⌘O` kbd labels render from `prettyCombo(comboOf("palette"))` / `("openConnections")`.
- **Edge cases:**
  - With no connection, the objects list is empty and actions still work.
  - A handler returning `false` (not applicable) does nothing, as with the keys.
  - `deleteRow`'s handler reads `e.target`; a synthetic event has `target` null, so it proceeds. That's correct.
- **Acceptance (mock):**
  - ⌘P lists tables. Typing `>` lists all 30 actions with keys. `>them` + ↵ toggles the theme. `ord` + ↵ opens `orders`. Typing `diag` shows "Database diagram" under Actions.
  - Tests: `npm test` includes `palette.test.mjs`, and it passes.

**Phase 5 release:** v0.17.1. RAM: no new resident data (`ACTIONS` is already loaded). The list is capped at 50+6 rows, or 30 in `>` mode.

---

### Phase 6 · v0.17.2 · Sidebar density, tabs, motion, launcher

#### Task 6.1: Sidebar hierarchy and density (D8)
- **`ui/src/main.ts` `addDatabase()`:** after `collapsed.delete("d:" + c.id)`, add `for (const k of ROUTINE_KINDS) collapsed.add(`g:${c.id}:${k}`);`. Searching still forces groups open (existing `q ? true : …`).
- **`treeRow()`, non-zero levels:**
  - heights `{1: 30, 2: 24, 3: 26}[o.level]`, left padding `{1: 6, 2: 14, 3: 28}[o.level]`
  - For level 2: render no icon. The label class becomes `text-[11px] font-semibold uppercase tracking-wide text-muted`, and the count `text-[11px]`.
- **`treeRow()` level 0 (server card):** badge size 28 → 22 (in the `renderObjects` call: `engineBadge(s.kind, 22)`), and the name class becomes `font-semibold text-[13px]`.
- **CSS:**
  - `#objects { font-size: 13px; }`
  - `.srv-card { min-height: 38px; margin: 2px 0 4px; }`
  - Keep the env stripes and pill.
- **Don't** change `renderObjects()`'s structure, the selection logic or `data-name`.
- **Acceptance:**
  - In `31-sidebar-hover-light.png`'s scenario, Functions/Procedures/Triggers/Events start collapsed with counts, and the table list is visible without scrolling.
  - Double-click, multi-select, dirty stripes (3.1) and hover actions still work.

#### Task 6.2: Tabs: idle background, one-time animation, overflow fade (D10.3–4, D19)
- **CSS:**
  - In the `.tab[aria-selected="true"]` rule, remove `animation: …`.
  - Add `.tab.tab-new { animation: tab-in .24s var(--ease-spring); }`.
  - Add `.tab:not([aria-selected="true"]) { background: color-mix(in srgb, var(--panel) 35%, transparent); }` **before** the existing `.tab:hover` rule, so hover still wins.
  - Add `#tabs.fade-end { -webkit-mask-image: linear-gradient(90deg,#000 calc(100% - 24px),transparent); mask-image: linear-gradient(90deg,#000 calc(100% - 24px),transparent); }`.
- **`ui/src/main.ts`:**
  - Add `const freshTabs = new Set<number>();`.
  - In `makeTab()`, call `freshTabs.add(tab.id)` before `activate(tab)`.
  - In `renderTabs()`: `if (freshTabs.delete(t.id)) d.classList.add("tab-new")`, and for the selected tab `requestAnimationFrame(() => d.scrollIntoView({ inline: "nearest", block: "nearest" }))`.
  - Add the fade helper:
    ```ts
    const fadeTabs = () => { const el = $("tabs"); el.classList.toggle("fade-end", el.scrollLeft + el.clientWidth < el.scrollWidth - 1); };
    ```
    Call it at the end of `renderTabs()`. Once at startup, add `$("tabs").addEventListener("scroll", fadeTabs, { passive: true }); new ResizeObserver(fadeTabs).observe($("tabs"));`.
- **Acceptance:**
  - Switching tabs doesn't bounce; a new tab animates once.
  - Unselected tabs read as tabs in light mode.
  - With 10 tabs at 1000px, the right edge fades, and the fade disappears when scrolled to the end.

#### Task 6.3: Entry motion for dialogs and menus, and inactive-window dimming (D19)
- **CSS:**
  ```css
  .dlg, #ctx, #palette > div { transition: opacity .12s var(--ease-out), transform .12s var(--ease-out); }
  @starting-style { .dlg, #ctx, #palette > div { opacity: 0; transform: scale(.98); } }
  .inactive { --sel: var(--raised2); --accent-soft: var(--raised); }
  ```
  - `.dlg` was added in Task 0.2. Do **not** target `.glass-strong`.
  - Put `.inactive` at the very end of the file, so it comes after `.dark`.
- **`ui/src/main.ts`, startup:**
  `addEventListener("blur", () => document.documentElement.classList.add("inactive")); addEventListener("focus", () => document.documentElement.classList.remove("inactive"));`
- **Acceptance:**
  - Menus and dialogs fade/scale in. Under System Settings → Reduce motion there's no animation (the existing rule).
  - Clicking another app dims the grid selection and the sidebar active row; coming back restores them.
  - On WebKit older than 17.5 there's just no animation.

#### Task 6.4: Launcher cards: rest affordance, connected plus env, recency (D20)
- **New pure module `ui/src/recent.ts`:**
  ```ts
  export type Used = Record<string, number>;
  export function touchRecent(used: Used, id: string, now: number, keep = 200): Used // returns a new object, newest `keep` ids
  export function sortByRecent<T extends { id: string; name: string }>(list: T[], used: Used): T[] // used desc, then name localeCompare
  ```
- **`package.json` test script:** add an esbuild line for `recent.ts`.
- **New file `ui/test/recent.test.mjs`** with these cases:
  1. Never-used profiles sort by name.
  2. Used ones come first, newest first.
  3. `touchRecent` doesn't mutate its input.
  4. `touchRecent` prunes to `keep`.
  5. Ties fall back to name.
- **`ui/src/main.ts`:**
  - Storage key `tabnix.lastUsed`: one JSON map, read with a try/catch fallback to `{}`.
  - `connectProfile()`: after success, call `localStorage.setItem("tabnix.lastUsed", JSON.stringify(touchRecent(read(), p.id, Date.now())))`.
  - `showLauncher()`: `sorted = sortByRecent(profiles, read())` (subject to open question Q2). The tag list stays alphabetical.
- **Card:**
  - The name line gets a 6px `var(--ok)` dot with `title="Connected"` when `live`.
  - The right slot (width 96 → 128) shows the env pill (non-local) **and** `icon("chevron",16)` in `--muted` at rest. Both get `group-hover:opacity-0`.
  - Remove the "connected" pill branch.
- **Acceptance:**
  - Cards show a chevron at rest.
  - A connected production card shows both the green dot and "production".
  - After connecting B then A, the order is A, B, then the rest alphabetically.

**Phase 6 release:** v0.17.2. RAM: run `memprofile.sh cold connected tabs20`. The sidebar rows get *smaller*; the only new listeners are one ResizeObserver and two window listeners.

---

## 4. Cross-cutting

### Verification checklist (every phase, before the version bump)
1. `cd ui && npx tsc --noEmit` passes clean.
2. `cd ui && npm test` passes, including any new test files from this phase.
3. `cd ui && npx vite build` passes, and the gzip size of `dist/assets/index-*.js` stays within +3 KB of the previous phase (note both numbers in LOG).
4. Screenshots in the mock, **light and dark**, at **1440×900** and **1000×680**:
   - welcome
   - a table tab: clean, then dirty
   - a query tab with a result
   - each dialog the phase touched
   Compare them with the audit screenshots of the same name.
5. **Keyboard-only pass:**
   - ⌘P → open a table
   - arrows in the grid, Enter to edit, Tab to move
   - ⌘S → ⌘↵ commits
   - Esc closes dialogs (and doesn't cancel a running query)
   - ⌘W on a dirty tab asks first
   - ⌘1–9, ⌘T, ⌘J, ⌘⌥B/R/I/E
6. Regression spot-checks:
   - sidebar multi-select bulk menu
   - drop a table with typed confirm
   - restore on production
   - filter bar apply
   - Structure commit
   - run-all result switcher

### RAM guard
- **Before Phase 0**, record a baseline from main. `bench/mem-baseline.json` is stale (see the v0.12 LOG note):
  ```sh
  scripts/memprofile.sh && cp bench/mem-latest.json /tmp/mem-v0.15.1.json
  ```
- **After each phase that adds DOM or listeners (0, 2, 3, 6):** run `scripts/memprofile.sh --no-build cold connected tabs20` after a build, then compare `total_MB` with the saved file.
  - Budget: ≤ +5 MB or +3% per scenario. The script's own `BUDGET_PCT=10`/`BUDGET_MB=15` is too loose for UI-only changes.
  - When the numbers are good, refresh the baseline with `--update`.
- **Phases 1, 4 and 5** are CSS, transient dialogs or capped lists. State "no resident change" in LOG and run `cold` only.
- **Red flags to reject in review:**
  - anything appended per grid row
  - a `MutationObserver` or `setInterval` that never stops
  - a new `renderObjects()`/`renderTabs()` call on keystrokes or cell edits (the dirty sync must stay DOM-patch only)

### Rollback
- One commit per phase/version, so `git revert <sha>` undoes exactly one phase.
- Ordering dependencies:
  - Phase 0 (`modal` opts, `onClose`, `.dlg`) is used by Phases 3, 4 and 6.
  - Phase 1 tokens and classes are used by Phases 2–4.
  - Reverting Phase 0 or 1 means reverting everything after it, or keeping the API.
- localStorage keys added: `tabnix.lastUsed` (Phase 6) only. It's harmless if left behind on rollback.

### Release convention (this repo)
1. Bump the version in **all five places**:
   - `src-tauri/Cargo.toml` (`version =`)
   - `ui/package.json`
   - `ui/package-lock.json` (two places: top-level `"version"` and `packages[""].version`)
   - `src-tauri/tauri.conf.json`
   - `Cargo.lock` (the `name = "tabnix"` entry; run `cargo check -p tabnix` or edit the line)
2. Append a LOG.md bullet in the existing style: `- **v0.16.0.** …`. Say what changed, which tests were added, and the verification level. "Browser-mock verified only" is the honest default unless the Tauri app was run.
3. Commit the code and the version bump together, with the message `v0.16.0: <short summary>` plus the attribution lines in effect for the session. Only commit when the owner has asked for commits.
4. To ship: `scripts/build-dmg.sh` builds the **Apple Silicon (arm64) only** DMG into `dist/`. It deletes `target/` afterwards; use `KEEP_TARGET=1` to keep it.

---

## 5. Open questions for the product owner (Sonnet uses the default if unanswered)

1. **Shortcut for the keyboard cheat-sheet?** ⌘/ clashes with toggle-comment in the editor. **Default:** no new shortcut; ⌘P then `>` lists every action with its key.
2. **Launcher order:** most recently used first, or alphabetical as today? **Default:** recent first (then by name), within each tag group. Tag chips stay alphabetical.
3. **Closing a tab with staged edits:** ask, or silently keep the edits in memory until the database closes? **Default:** ask ("Discard and close"). That's the simplest and needs no extra state.
4. **Denser sidebar** (table rows 30→26px, 13px text, routine groups collapsed by default): OK? **Default:** yes. Phase 6.1 can ship without it by dropping just that task.
