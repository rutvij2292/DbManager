//! Excel (.xlsx) writer. Worksheets use the crate's constant-memory mode, so rows go to a temp file
//! as they are written and a multi-million-row export doesn't grow the heap.
use dbcore::{DbError, Result, Value};
use rust_xlsxwriter::{Format, FormatAlign, Workbook, XlsxError};
use std::path::Path;

/// Rows per sheet in the .xlsx format (the header counts as one).
const SHEET_ROWS: u32 = 1_048_576;
/// Longest text an Excel cell can hold.
const CELL_CHARS: usize = 32_767;

fn err(e: XlsxError) -> DbError {
    DbError::msg(e)
}

pub struct XlsxWriter {
    book: Workbook,
    names: Vec<String>,
    header: bool,
    bold: Format,
    cell: Format,
    sheet: usize,
    row: u32,
}

impl XlsxWriter {
    pub fn new(names: Vec<String>, header: bool) -> Result<Self> {
        let mut w = XlsxWriter { book: Workbook::new(), names, header, bold: Format::new().set_bold().set_align(FormatAlign::Top), cell: Format::new().set_align(FormatAlign::Top), sheet: 0, row: 0 };
        w.add_sheet()?;
        Ok(w)
    }

    fn add_sheet(&mut self) -> Result<()> {
        let n = self.book.worksheets().len();
        let ws = self.book.add_worksheet_with_constant_memory().map_err(err)?;
        ws.set_name(if n == 0 { "Result".to_string() } else { format!("Result {}", n + 1) }).map_err(err)?;
        self.sheet = n;
        self.row = 0;
        if self.header {
            ws.set_freeze_panes(1, 0).map_err(err)?;
            for (c, name) in self.names.iter().enumerate() {
                ws.write_string_with_format(0, c as u16, clip(name), &self.bold).map_err(err)?;
            }
            self.row = 1;
        }
        Ok(())
    }

    pub fn write_row(&mut self, row: &[Value]) -> Result<()> {
        if self.row >= SHEET_ROWS {
            self.add_sheet()?;
        }
        let r = self.row;
        let cell = &self.cell;
        let ws = self.book.worksheet_from_index(self.sheet).map_err(err)?;
        for (c, v) in row.iter().enumerate().take(16_384) {
            let c = c as u16;
            match v {
                Value::Null => continue,
                Value::Bool(b) => ws.write_boolean_with_format(r, c, *b, cell).map(|_| ()),
                Value::I64(i) => ws.write_number_with_format(r, c, *i as f64, cell).map(|_| ()),
                Value::F64(f) if f.is_finite() => ws.write_number_with_format(r, c, *f, cell).map(|_| ()),
                Value::F64(f) => ws.write_string_with_format(r, c, f.to_string(), cell).map(|_| ()),
                Value::Text(t) => ws.write_string_with_format(r, c, clip(t), cell).map(|_| ()),
                Value::Bytes(b) => {
                    use std::fmt::Write as _;
                    let mut s = String::from("0x");
                    for x in b.iter().take(CELL_CHARS / 2 - 2) {
                        let _ = write!(s, "{x:02x}");
                    }
                    ws.write_string_with_format(r, c, s, cell).map(|_| ())
                }
            }
            .map_err(err)?;
        }
        self.row += 1;
        Ok(())
    }

    pub fn save(mut self, path: &Path) -> Result<()> {
        self.book.save(path).map_err(err)
    }
}

/// Cell text with the characters XML can't carry removed and Excel's length limit applied.
fn clip(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(CELL_CHARS).collect()
}

/// Write already-fetched rows (e.g. the user's selection) to `path`.
pub fn write_xlsx(path: &Path, columns: Vec<String>, rows: &[Vec<Value>]) -> Result<u64> {
    let mut w = XlsxWriter::new(columns, true)?;
    for r in rows {
        w.write_row(r)?;
    }
    w.save(path)?;
    Ok(rows.len() as u64)
}
