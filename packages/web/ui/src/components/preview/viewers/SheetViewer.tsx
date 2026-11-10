/**
 * Spreadsheet preview: a delimited text body is parsed directly, a workbook is
 * unpacked through `office/xlsx.ts`. Both land in one grid with a sticky
 * header, row numbers, sheet tabs, and an explicit truncation notice.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewBar, PreviewBarLabel, PreviewChip } from '../PreviewChrome.tsx';
import { columnName } from '../office/columns.ts';
import { parseDelimited } from '../office/csv.ts';
import { readXlsx, type SheetTable } from '../office/xlsx.ts';
import { supportsZipPreview } from '../office/zip.ts';
import { extensionOf, filenameOf, formatBytes } from '../path.ts';
import type { ViewerProps } from '../types.ts';
import css from '../../../styles/preview.module.css';

const WORKBOOK_EXTENSIONS = new Set(['xlsx', 'xls', 'ods']);

interface SheetState {
  sheets: SheetTable[];
  delimiter: string;
  error: string | undefined;
}

export function SheetViewer({ path, text, bytes }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  const workbook = WORKBOOK_EXTENSIONS.has(extensionOf(path));
  const [state, setState] = useState<SheetState>({ sheets: [], delimiter: ',', error: undefined });
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
    if (text !== undefined) {
      const table = parseDelimited(text);
      setState({
        sheets: [{ name: filenameOf(path), rows: table.rows, truncated: table.truncated }],
        delimiter: table.delimiter,
        error: undefined,
      });
      return;
    }
    if (bytes === undefined) return;
    if (!supportsZipPreview()) {
      setState({ sheets: [], delimiter: ',', error: 'This browser cannot unpack Office files.' });
      return;
    }
    let cancelled = false;
    void readXlsx(bytes)
      .then(({ sheets }) => { if (!cancelled) setState({ sheets, delimiter: ',', error: undefined }); })
      .catch((error: Error) => { if (!cancelled) setState({ sheets: [], delimiter: ',', error: error.message }); });
    return () => { cancelled = true; };
  }, [text, bytes, path]);

  const sheet = state.sheets[active] ?? state.sheets[0];
  const columns = useMemo(() => {
    const width = Math.max(0, ...(sheet?.rows ?? []).map((row) => row.length));
    return Array.from({ length: width }, (_, index) => index);
  }, [sheet]);
  const rows = sheet?.rows ?? [];
  const delimiterName = state.delimiter === '\t' ? 'TSV' : state.delimiter === ';' ? 'CSV (;)' : state.delimiter === '|' ? 'PSV' : 'CSV';

  return (
    <>
      <PreviewBar>
        <PreviewBarLabel>{workbook ? t('Workbook') : delimiterName}</PreviewBarLabel>
        <PreviewChip>{t('{rows} rows × {columns} columns', { rows: rows.length, columns: columns.length })}</PreviewChip>
        {state.sheets.length > 1 && (
          <PreviewChip>{t('{count} sheets', { count: state.sheets.length })}</PreviewChip>
        )}
        <span className={css.toolbarSpacer} />
        {bytes !== undefined && <PreviewChip>{formatBytes(bytes.byteLength)}</PreviewChip>}
      </PreviewBar>
      {state.sheets.length > 1 && (
        <div className={css.toolbar} role="tablist">
          {state.sheets.map((entry, index) => (
            <button
              key={`${entry.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={css.textButton}
              onClick={() => { setActive(index); }}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {state.error !== undefined && <div className={css.status} role="alert">{t(state.error)}</div>}
      {state.error === undefined && rows.length === 0 && (
        <div className={css.status}>{t('This sheet is empty.')}</div>
      )}
      {state.error === undefined && rows.length > 0 && (
        <>
          {sheet?.truncated === true && <div className={css.notice}>{t('Showing the first rows of this sheet.')}</div>}
          <div className={css.sheetWrap}>
            <table className={css.sheet}>
              <thead>
                <tr>
                  <th scope="col" aria-label={t('Row number')} />
                  {columns.map((column) => (
                    <th key={column} scope="col">{columnName(column)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th scope="row" className={css.sheetRowNumber}>{rowIndex + 1}</th>
                    {columns.map((column) => (
                      <td key={column} title={row[column] ?? ''}>{row[column] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
