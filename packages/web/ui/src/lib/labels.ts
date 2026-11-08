import type {
  DiffBlockLabels,
  MarkdownLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  TerminalBlockLabels,
  WebBlockLabels,
} from '../../vendor/primitives/index.ts';
import type { Translate } from './i18n.ts';

function codeToolbar(t: Translate) {
  return {
    codeLabel: t('Code'),
    wrapLabel: t('Wrap lines'),
    unwrapLabel: t('Unwrap lines'),
  };
}

export function markdownLabels(t: Translate): MarkdownLabels {
  return {
    code: {
      copyLabel: t('Copy'),
      copiedLabel: t('Copied'),
      toolbarLabels: codeToolbar(t),
    },
    footnotes: t('Footnotes'),
  };
}

export function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    commandLine: (line) => t('Command line {line}', { line }),
    signal: (signal) => t('Signal {signal}', { signal }),
    exitCode: (exitCode) => t('Exit {code}', { code: exitCode }),
    noExitCode: t('No exit code'),
    running: t('Running'),
    failed: t('Failed'),
    done: t('Done'),
    copy: t('Copy'),
    copied: t('Copied'),
    noOutput: t('No output'),
    collapseAria: t('Collapse output'),
    collapse: t('Collapse'),
    expandAria: (hidden) => t('Show {count} more lines', { count: hidden }),
    expand: (hidden) => t('Show {count} more lines', { count: hidden }),
  };
}

export function readLabels(t: Translate): ReadBlockLabels {
  return {
    ...codeToolbar(t),
    window: (shown, total) => t('Showing {shown} of {total} lines', { shown, total }),
    copy: t('Copy'),
    copied: t('Copied'),
    collapseAria: t('Collapse file'),
    expandAria: (hidden) => t('Show {count} more lines', { count: hidden }),
    collapse: t('Collapse'),
    expand: (hidden) => t('Show {count} more lines', { count: hidden }),
  };
}

export function diffLabels(t: Translate): DiffBlockLabels {
  return {
    ...codeToolbar(t),
    copy: t('Copy'),
    copied: t('Copied'),
    collapseAria: t('Collapse diff'),
    expandAria: (hidden) => t('Show {count} more lines', { count: hidden }),
    collapse: t('Collapse'),
    expand: (hidden) => t('Show {count} more lines', { count: hidden }),
  };
}

export function searchLabels(t: Translate): SearchBlockLabels {
  return {
    pathsSummary: (shown, total, truncated) => truncated
      ? t('Showing {shown} of {total} paths', { shown, total })
      : t('Showing {shown} paths', { shown }),
    matchesSummary: (shown, total, files, truncated) => truncated
      ? t('Showing {shown} of {total} matches in {files} files', { shown, total, files })
      : t('Showing {shown} matches in {files} files', { shown, files }),
    copy: t('Copy'),
    copied: t('Copied'),
    noResults: t('No results'),
    collapseAria: t('Collapse results'),
    expandAria: (hidden) => t('Show {count} more lines', { count: hidden }),
    collapse: t('Collapse'),
    expand: (hidden) => t('Show {count} more lines', { count: hidden }),
  };
}

export function webLabels(t: Translate): WebBlockLabels {
  return {
    noResults: t('No results'),
    sourcesTruncated: t('Sources truncated'),
    http: t('HTTP'),
    contentTruncated: t('Content truncated'),
    markdown: markdownLabels(t),
  };
}
