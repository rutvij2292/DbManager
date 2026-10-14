//! Database backup and restore without external tools (no pg_dump / mysqldump needed).
//! A backup is a plain SQL script: structure first, then data, then indexes and foreign keys,
//! then views. Restore reads any such script, including `COPY … FROM stdin` blocks and
//! MySQL `DELIMITER` lines, so dumps from other tools load too.
mod backup;
mod restore;
mod script;

pub use backup::{backup, BackupOptions, BackupProgress, BackupReport, TableRef};
pub use restore::{restore, RestoreOptions, RestoreProgress, RestoreReport};
pub use script::{Item, ScriptReader};
