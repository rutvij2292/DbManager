# Lattice — project log

A personal-use, macOS-first, TablePlus-style database client in Rust (Tauri v2 + TypeScript/Tailwind).

## 2026-10-14
- Project named **Lattice**. Architecture reviewed by Fable (async-trait `Driver`/`Connection`, paged results kept in Rust, workspace of per-driver crates).
- `rea-agents` evaluated and not used: TablePlus is a native app (not Electron), and I'm not decompiling it. Behavior and shortcuts are recreated from the public UI and docs; all code is original.
- Step 1: workspace, `dbcore`, `driver-sqlite` (with test).
