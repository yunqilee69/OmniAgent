/**
 * Spreadsheet column labels (0 → A, 25 → Z, 26 → AA). Kept apart from the
 * viewer so the grid header is testable without React.
 * @param index - zero-based column index.
 * @returns the A1-style column name.
 */
export function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}
