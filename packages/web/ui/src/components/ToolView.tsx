import { useState, type ComponentType, type ReactNode } from 'react';
import {
  DiffBlock,
  DisclosureRow,
  IconApiOutlineRegular,
  IconBrowseOutlineRegular,
  IconChecklistOutlineRegular,
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconSearchOutlineRegular,
  IconUsersOutlineRegular,
  ReadBlock,
  SearchBlock,
  TerminalBlock,
  TextShimmer,
  WebBlock,
  type ReadBlockLine,
  type SearchFileGroup,
} from '../../vendor/primitives/index.ts';
import type { ToolItem } from '../lib/events.ts';
import { useApp } from '../lib/store.ts';
import { diffLabels, readLabels, searchLabels, terminalLabels, webLabels } from '../lib/labels.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import css from '../styles/dsh/tool-row.module.css';

type ToolIcon = ComponentType<{ size?: number; className?: string }>;

const TITLES: Record<string, string> = {
  bash: 'Terminal',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  grep: 'Search',
  glob: 'Glob',
  list_dir: 'List',
  web_fetch: 'Web fetch',
  todo_write: 'Todo',
  exit_plan_mode: 'Plan',
  subagent: 'Subagent',
  send_message: 'Send message',
  interrupt_agent: 'Interrupt agent',
  skill: 'Skill',
  goal: 'Goal',
};

const ICONS: Record<string, ToolIcon> = {
  bash: IconCodeOutlineRegular,
  read_file: IconBrowseOutlineRegular,
  write_file: IconEditOutlineRegular,
  edit_file: IconEditOutlineRegular,
  grep: IconSearchOutlineRegular,
  glob: IconSearchOutlineRegular,
  list_dir: IconSearchOutlineRegular,
  web_fetch: IconGlobeOutlineRegular,
  todo_write: IconChecklistOutlineRegular,
  subagent: IconUsersOutlineRegular,
  send_message: IconUsersOutlineRegular,
  interrupt_agent: IconUsersOutlineRegular,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function stringify(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return '[Unable to display value]';
  }
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function terminalModel(item: ToolItem): { command: string; output: string; exitCode?: number | null; signal?: string } {
  const args = record(item.call.arguments);
  const raw = item.result?.content ?? '';
  const lines = raw.split('\n');
  const status = lines[0] ?? '';
  const exit = /^exit code: (-?\d+)$/.exec(status);
  const output = exit === null && !/^(?:timed out|cancelled)$/.test(status) ? raw : lines.slice(1).join('\n');
  return {
    command: stringArg(args, 'command'),
    output,
    ...(exit === null ? {} : { exitCode: Number(exit[1]) }),
    ...(item.result === undefined || status === 'timed out' || status === 'cancelled' ? {} : {}),
  };
}

function readModel(item: ToolItem): { label: string; lines: ReadBlockLine[]; totalLines: number } {
  const args = record(item.call.arguments);
  const content = item.result?.content ?? '';
  const label = /<path>([\s\S]*?)<\/path>/.exec(content)?.[1] ?? stringArg(args, 'file_path');
  const body = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(content)?.[1] ?? content;
  const lines: ReadBlockLine[] = [];
  for (const line of body.split('\n')) {
    const match = /^(\d+): ?(.*)$/.exec(line);
    if (match !== null) lines.push({ number: Number(match[1]), text: match[2] ?? '' });
  }
  const total = /total (\d+) lines/.exec(body)?.[1] ?? /of (\d+)\.?/.exec(body)?.[1];
  return { label, lines, totalLines: total === undefined ? lines.length : Number(total) };
}

function grepModel(item: ToolItem): { files: SearchFileGroup[]; total: number } {
  const content = item.result?.content ?? '';
  if (content.trim() === '' || content.startsWith('No matches found')) return { files: [], total: 0 };
  const files: SearchFileGroup[] = [];
  let current: SearchFileGroup | undefined;
  for (const line of content.split('\n')) {
    if (line.startsWith('Found ') || line.startsWith('(The complete result')) continue;
    if (line.trim() === '') { current = undefined; continue; }
    const match = /^Line (\d+): ?(.*)$/.exec(line);
    if (match !== null) {
      if (current !== undefined) current.matches.push({ lineNumber: Number(match[1]), line: match[2] ?? '' });
      continue;
    }
    current = { path: line, matches: [] };
    files.push(current);
  }
  const summary = /Found (?:\d+ of )?(\d+)/.exec(content);
  const fallback = files.reduce((sum, file) => sum + file.matches.length, 0);
  return { files, total: summary === null ? fallback : Number(summary[1]) };
}

function pathModel(item: ToolItem): string[] {
  const content = item.result?.content ?? '';
  if (content.startsWith('No files found')) return [];
  const lines = content.split('\n');
  if (item.call.name === 'list_dir') lines.shift();
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('(') && !line.startsWith('…'));
}

function pathSummary(item: ToolItem): string {
  const args = record(item.call.arguments);
  return stringArg(args, 'file_path') || stringArg(args, 'path') || stringArg(args, 'pattern');
}

function summaryFor(item: ToolItem, t: Translate): string {
  const args = record(item.call.arguments);
  switch (item.call.name) {
    case 'bash': return firstLine(stringArg(args, 'command'));
    case 'read_file':
    case 'write_file':
    case 'edit_file': return stringArg(args, 'file_path');
    case 'grep': return stringArg(args, 'pattern');
    case 'glob': return stringArg(args, 'pattern');
    case 'list_dir': return stringArg(args, 'path') || '.';
    case 'web_fetch': return stringArg(args, 'url');
    case 'todo_write': return t('Update task list');
    case 'exit_plan_mode': return t('Submit plan for review');
    case 'subagent': return stringArg(args, 'agent') || stringArg(args, 'description') || t('Run subagent');
    case 'skill': return stringArg(args, 'name');
    default: return pathSummary(item);
  }
}

function detailBody(item: ToolItem, t: Translate): ReactNode {
  const args = record(item.call.arguments);
  const result = item.result;
  if (item.call.name === 'todo_write' && Array.isArray(args.todos)) {
    return (
      <div className={css.ioCard}>
        <div className={css.ioSection}>
          <span className={css.ioLabel}>{t('TODOS')}</span>
          <span className={css.ioText}>
            {args.todos.map((todo) => {
              const entry = record(todo);
              return `${entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[>]' : '[ ]'} ${String(entry.content ?? '')}`;
            }).join('\n')}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={css.ioCard}>
      <div className={css.ioSection}>
        <span className={css.ioLabel}>{t('IN')}</span>
        <span className={css.ioText}>{stringify(item.call.arguments)}</span>
      </div>
      {result !== undefined && (
        <>
          <span className={css.ioDivider} aria-hidden />
          <div className={css.ioSection}>
            <span className={css.ioLabel}>{t('OUT')}</span>
            <span className={css.ioText} data-error={!result.ok || undefined}>{result.content || t('(empty)')}</span>
          </div>
        </>
      )}
    </div>
  );
}

function toolBody(item: ToolItem, t: Translate): ReactNode | null {
  const result = item.result;
  const args = record(item.call.arguments);
  switch (item.call.name) {
    case 'bash': {
      const model = terminalModel(item);
      return (
        <TerminalBlock
          command={model.command}
          output={model.output}
          {...(model.exitCode === undefined ? {} : { exitCode: model.exitCode })}
          labels={terminalLabels(t)}
          maxLines={Infinity}
          className={css.terminalBody}
        />
      );
    }
    case 'read_file':
      if (result === undefined || !result.ok) return detailBody(item, t);
      return <ReadBlock {...readModel(item)} labels={readLabels(t)} maxLines={Infinity} className={css.readBody} />;
    case 'write_file': {
      if (result === undefined || !result.ok) return detailBody(item, t);
      return (
        <DiffBlock
          diffs={[{ path: stringArg(args, 'file_path'), oldText: '', newText: stringArg(args, 'content') }]}
          labels={diffLabels(t)}
          maxLines={Infinity}
          className={css.diffBody}
        />
      );
    }
    case 'edit_file': {
      if (result === undefined || !result.ok) return detailBody(item, t);
      return (
        <DiffBlock
          diffs={[{ path: stringArg(args, 'file_path'), oldText: stringArg(args, 'old_string'), newText: stringArg(args, 'new_string') }]}
          labels={diffLabels(t)}
          maxLines={Infinity}
          className={css.diffBody}
        />
      );
    }
    case 'grep': {
      if (result === undefined || !result.ok) return detailBody(item, t);
      const model = grepModel(item);
      return (
        <SearchBlock
          kind="matches"
          files={model.files}
          total={model.total}
          truncated={result.truncated}
          labels={searchLabels(t)}
          maxLines={Infinity}
          className={css.searchBody}
        />
      );
    }
    case 'glob':
    case 'list_dir': {
      if (result === undefined || !result.ok) return detailBody(item, t);
      const paths = pathModel(item);
      return (
        <SearchBlock
          kind="paths"
          paths={paths}
          total={paths.length}
          truncated={result.truncated}
          labels={searchLabels(t)}
          maxLines={Infinity}
          className={css.searchBody}
        />
      );
    }
    case 'web_fetch': {
      if (result === undefined || !result.ok) return detailBody(item, t);
      const status = /\(HTTP (\d+)\)/.exec(result.content);
      return (
        <WebBlock
          kind="fetch"
          url={stringArg(args, 'url')}
          statusCode={status === null ? 200 : Number(status[1])}
          truncated={result.truncated}
          labels={webLabels(t)}
          className={css.webBody}
        />
      );
    }
    default:
      return detailBody(item, t);
  }
}

function statusLabel(item: ToolItem, t: Translate): string {
  if (item.denied === true) return t('Denied');
  if (item.result === undefined) return t('Running');
  if (!item.result.ok) return t('Failed');
  return '';
}

export function ToolView({ item, live }: { item: ToolItem; live: boolean }): ReactNode {
  const t = translator(useApp().locale);
  const [expanded, setExpanded] = useState(false);
  const title = t(TITLES[item.call.name] ?? item.call.name);
  const Icon = ICONS[item.call.name] ?? IconApiOutlineRegular;
  const summary = summaryFor(item, t);
  const status = statusLabel(item, t);
  const running = live && item.result === undefined && item.denied !== true;
  const body = toolBody(item, t);
  const expandable = body !== null;
  const open = expanded && expandable;

  return (
    <div className={css.root} data-tool={item.call.name} data-state={item.denied === true ? 'error' : item.result === undefined ? 'running' : item.result.ok ? 'done' : 'error'}>
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        icon={<Icon />}
        title={title}
        running={running}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded((value) => !value); }}
        collapsedContent={summary !== '' ? (
          <>
            <span className={css.sep} aria-hidden />
            <span className={css.summary}><TextShimmer>{summary}</TextShimmer></span>
            {status !== '' && <span className={css.summarySuffix}>{status}</span>}
          </>
        ) : status !== '' ? <span className={css.summarySuffix}>{status}</span> : undefined}
      >
        {body}
      </DisclosureRow>
    </div>
  );
}
