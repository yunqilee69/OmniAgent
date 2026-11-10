import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconCheckOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconCopyOutlineRegular,
  IconLoadingOutlineRegular,
  IconThinkOutlineRegular,
  MarkdownText,
  StateDot,
  TextShimmer,
  Tooltip,
  UserMessageBubble,
  useClipboardCopy,
} from '../../vendor/primitives/index.ts';
import { groupTurns, userMessageCopyText, type DisplayTurn, type TranscriptItem, type UserItem } from '../lib/events.ts';
import { useApp } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import { markdownLabels } from '../lib/labels.ts';
import { MarkdownDelegateProvider } from '../../vendor/primitives/index.ts';
import { translator, type Locale, type Translate } from '../lib/i18n.ts';
import { ToolView } from './ToolView.tsx';
import { PlanReviewCard } from './PlanReview.tsx';
import css from '../styles/app.module.css';
import chatCss from '../styles/dsh/chat-view.module.css';
import messageCss from '../styles/dsh/message-item.module.css';
import assistantCss from '../styles/dsh/assistant-markdown.module.css';
import reasoningCss from '../styles/dsh/reasoning-row.module.css';
import turnProcessCss from '../styles/dsh/turn-process.module.css';
import groupCss from '../styles/dsh/chat-group.module.css';

function firstLine(text: string): string {
  const line = text.trimStart().split('\n', 1)[0] ?? '';
  return line.replaceAll('**', '');
}

function durationText(t: Translate, turn: DisplayTurn, locale: Locale): string {
  if (turn.reason === 'interrupted') return t('Stopped');
  if (turn.reason === 'error') return t('Turn failed');
  if (turn.startedAt === undefined) return t('Worked');
  const end = turn.endedAt ?? Date.now();
  const seconds = Math.max(1, Math.round((end - turn.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const duration = locale === 'zh'
    ? `${minutes > 0 ? `${minutes} 分 ` : ''}${rest} 秒`
    : `${minutes > 0 ? `${minutes}m ` : ''}${rest}s`;
  return t('Worked for {duration}', { duration: duration });
}

export function MessageActions({ text, timestamp, t }: { text: string; timestamp?: number; t: Translate }): ReactNode {
  const { copied, failed, onCopy } = useClipboardCopy(text);
  const date = timestamp === undefined ? null : new Date(timestamp);
  const validDate = date !== null && Number.isFinite(date.getTime()) ? date : null;
  const label = copied ? t('Copied') : failed ? t('Could not copy message') : t('Copy message');
  return (
    <div className={messageCss.actions}>
      {validDate !== null && <time dateTime={validDate.toISOString()}>{validDate.toLocaleString()}</time>}
      {text !== '' && <Tooltip label={label} side="top" delayMs={400}>
        <button type="button" className={messageCss.action} aria-label={label} onClick={onCopy}>
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </Tooltip>}
      {failed && <span role="status">{t('Could not copy message')}</span>}
    </div>
  );
}

export function UserContent({ user }: { user: UserItem }): ReactNode {
  const attachments = user.attachments ?? [];
  return (
    <UserMessageBubble>
      {attachments.length > 0 && (
        <div className={css.userAttachments}>
          {attachments.map((attachment, index) => attachment.kind === 'image' && attachment.data !== undefined ? (
            <img
              key={`${attachment.name}-${index}`}
              className={css.userImage}
              src={`data:${attachment.mimeType ?? attachment.mediaType};base64,${attachment.data}`}
              alt={attachment.name}
            />
          ) : (
            <span key={`${attachment.name}-${index}`} className={css.userFile}>
              {attachment.name}
            </span>
          ))}
        </div>
      )}
      {user.text !== '' && <span>{user.text}</span>}
    </UserMessageBubble>
  );
}

function ReasoningView({ text, running, t }: { text: string; running: boolean; t: Translate }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const summary = firstLine(text);
  return (
    <div className={reasoningCss.root} data-variant="think" data-state={running ? 'running' : 'ok'} data-expanded={expanded || undefined} data-preview={!expanded && summary !== '' ? '' : undefined}>
      <DisclosureRow
        rowClassName={reasoningCss.row}
        leadingClassName={reasoningCss.leading}
        titleClassName={reasoningCss.title}
        icon={<IconThinkOutlineRegular />}
        title={t('Thinking')}
        running={running}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded((value) => !value); }}
        collapsedContent={(
          <>
            <span className={reasoningCss.separator} aria-hidden />
            <span className={reasoningCss.summary} data-streaming={running || undefined}>
              <span className={reasoningCss.summaryText}><TextShimmer>{summary}</TextShimmer></span>
            </span>
          </>
        )}
      >
        <div className={reasoningCss.thinkBody}>
          <div className={assistantCss.root}>
            <div className={assistantCss.body}>
              <MarkdownText text={text} labels={markdownLabels(t)} variant="compact" />
            </div>
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
}

function CompactionView({ item, t }: { item: Extract<TranscriptItem, { kind: 'compaction' }>; t: Translate }): ReactNode {
  const changed = item.beforeTokens > 0 || item.afterTokens > 0;
  return (
    <div className={messageCss.compactionRow}>
      <button type="button" className={messageCss.compactionButton} disabled>
        <span className={messageCss.compactionLeading} aria-hidden>
          <span className={messageCss.compactionContextIcon}><IconContextInjectionOutlineRegular /></span>
        </span>
        <span className={messageCss.compactionTitle}>{t('Context compacted')}</span>
        {changed && (
          <>
            <span className={messageCss.compactionSep} aria-hidden />
            <span className={messageCss.compactionSummary}>
              {item.beforeTokens.toLocaleString()} → {item.afterTokens.toLocaleString()} tokens
            </span>
          </>
        )}
      </button>
    </div>
  );
}

function ProcessItem({ item, live, t }: { item: TranscriptItem; live: boolean; t: Translate }): ReactNode {
  switch (item.kind) {
    case 'tool':
      return <ToolView item={item} live={live} />;
    case 'reasoning':
      return <ReasoningView text={item.text} running={live && item.streaming} t={t} />;
    case 'assistant':
      return (
        <div className={clsx(assistantCss.root, messageCss.message)}>
          <div className={assistantCss.body}>
            <MarkdownText text={item.text} labels={markdownLabels(t)} />
          </div>
        </div>
      );
    case 'compaction':
      return <CompactionView item={item} t={t} />;
    case 'notice':
      return <NoticeView item={item} t={t} />;
    case 'user':
      return null;
  }
}

function NoticeView({ item, t }: { item: Extract<TranscriptItem, { kind: 'notice' }>; t: Translate }): ReactNode {
  return (
    <div className={messageCss.turnErrorRow} role="status">
      <StateDot state={item.tone === 'error' ? 'error' : 'warning'} className={messageCss.turnErrorDot} />
      <div className={messageCss.turnErrorCopy}>
        <span className={messageCss.turnErrorTitle}>{item.tone === 'error' ? t('Turn failed') : t('Notice')}</span>
        <span className={messageCss.turnErrorMessage}>{item.text}</span>
      </div>
    </div>
  );
}

function TurnView({ turn, processDisplay, locale, t }: { turn: DisplayTurn; processDisplay: 'collapsed' | 'expanded'; locale: Locale; t: Translate }): ReactNode {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (turn.live || processDisplay === 'expanded');
  const hasProcess = turn.process.length > 0;
  const toolLabel = turn.toolCount === 1 ? t('1 tool') : t('{count} tools', { count: turn.toolCount });
  const label = turn.live ? t('Working') : durationText(t, turn, locale);
  return (
    <div className={css.turn} data-live={turn.live || undefined}>
      {turn.user !== undefined && (
        <div className={clsx(messageCss.userRow, messageCss.message)}>
          <div className={messageCss.userStack}>
            <UserContent user={turn.user} />
            <MessageActions text={userMessageCopyText(turn.user.text, turn.user.attachments)} timestamp={turn.user.timestamp} t={t} />
          </div>
        </div>
      )}
      {hasProcess ? (
        <button
          type="button"
          className={turnProcessCss.root}
          data-open={open || undefined}
          aria-expanded={open}
          onClick={() => { setOverride(!open); }}
        >
          <span className={turnProcessCss.label}>
            {label}
            {turn.toolCount > 0 && ` · ${toolLabel}`}
          </span>
          <IconChevronDownOutlineRegular className={turnProcessCss.chevron} />
        </button>
      ) : turn.final !== undefined && !turn.live ? (
        <button type="button" className={turnProcessCss.root} disabled>
          <span className={turnProcessCss.label}>{label}</span>
        </button>
      ) : null}
      {hasProcess && open && (
        <div className={groupCss.content}>
          {turn.process.map((item) => <ProcessItem key={item.id} item={item} live={turn.live === true} t={t} />)}
        </div>
      )}
      {turn.final !== undefined && (
        <div className={clsx(assistantCss.root, css.response, messageCss.message)}>
          <div className={assistantCss.body}>
            <MarkdownText
              text={turn.final.text}
              streaming={turn.final.streaming}
              labels={markdownLabels(t)}
              textInteractionSource
            />
            {turn.reason === 'interrupted' && !turn.live && <span className={assistantCss.stopped}>{t('Stopped')}</span>}
          </div>
          <MessageActions text={turn.final.text} timestamp={turn.final.timestamp} t={t} />
        </div>
      )}
      {turn.extras.map((item) => item.kind === 'notice' ? <NoticeView key={item.id} item={item} t={t} /> : null)}
    </div>
  );
}

export function ConversationView({ entry, processDisplay, onOpenPlan, onOpenFile }: {
  entry: SessionEntry;
  processDisplay: 'collapsed' | 'expanded';
  onOpenPlan?: () => void;
  /** Open a workspace file named by a Markdown link (`src/a.ts:12`) in the preview panel. */
  onOpenFile?: ((path: string, options?: { line?: number }) => void) | undefined;
}): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const scroll = useRef<HTMLDivElement | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const running = entry.run !== undefined || entry.running;
  const source = entry.run ?? entry;
  const turns = groupTurns(source.transcript, source.turns, running);
  const live = entry.run;
  const lastText = source.transcript.at(-1);
  const tail = lastText?.kind === 'assistant' ? lastText.text.length : 0;

  const nearBottom = (): boolean => {
    const element = scroll.current;
    if (element === null) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  useLayoutEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    if (nearBottom()) element.scrollTop = element.scrollHeight;
  }, [turns.length, tail, live?.approval, live?.planReview]);

  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    const onScroll = (): void => { setAwayFromBottom(!nearBottom()); };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); };
  }, []);

  return (
    <MarkdownDelegateProvider openFile={onOpenFile}>
    <div className={chatCss.root} data-chat-following-tail={awayFromBottom ? undefined : ''}>
      <div className={chatCss.scroll} ref={scroll}>
        <div className={chatCss.column}>
          {turns.length === 0 && (
            <div className={css.conversationEmpty}>
              <span className={css.emptyMark} aria-hidden>◈</span>
              <strong>{entry.agent?.id === 'creator' ? t('Creator mode') : t('Ready when you are')}</strong>
              <p>
                {entry.agent?.id === 'creator'
                  ? t('Describe what you want to create. Creator mode can add scheduled tasks and write new agent definitions.')
                  : t('Send a message to begin this session.')}
              </p>
            </div>
          )}
          {turns.map((turn) => (
            <TurnView key={turn.index} turn={turn} processDisplay={processDisplay} locale={app.locale} t={t} />
          ))}
          {live?.planReview !== undefined && (
            <PlanReviewCard review={live.planReview} onOpen={() => { onOpenPlan?.(); }} />
          )}
          {entry.run !== undefined && entry.run.planReview === undefined && (
            <div className={chatCss.running} data-holding={entry.run.finishing ? '' : undefined}>
              <span className={chatCss.runningDivider} aria-hidden />
              <div className={chatCss.runningContent} role="status">
                <span className={chatCss.runningIcon} aria-hidden>
                  <IconLoadingOutlineRegular className={css.spin} />
                </span>
                <span className={chatCss.runningText}>
                  <TextShimmer>
                    {entry.run.stopping === true ? t('Stopping…')
                      : entry.run.finishing === true ? t('Saving session…')
                        : entry.run.approval !== undefined ? t('Waiting for approval')
                          : t('Agent is working')}
                  </TextShimmer>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      {awayFromBottom && (
        <div className={chatCss.toBottomSlot}>
          <button
            type="button"
            className={chatCss.toBottom}
            aria-label={t('Scroll to latest')}
            onClick={() => {
              const element = scroll.current;
              if (element !== null) element.scrollTop = element.scrollHeight;
            }}
          >
            <IconChevronDownOutlineRegular />
          </button>
        </div>
      )}
    </div>
    </MarkdownDelegateProvider>
  );
}
