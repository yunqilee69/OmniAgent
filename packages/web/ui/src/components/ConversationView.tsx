import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconCheckOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconCopyOutlineRegular,
  IconDatabaseOutlineRegular,
  IconLoadingOutlineRegular,
  IconThinkOutlineRegular,
  MarkdownText,
  StateDot,
  TextShimmer,
  Tooltip,
  UserMessageBubble,
  useClipboardCopy,
} from '../../vendor/primitives/index.ts';
import {
  groupTurns,
  userMessageCopyText,
  type DisplayTurn,
  type LiveTurnState,
  type MessageUsage,
  type TranscriptItem,
  type UserItem,
} from '../lib/events.ts';
import { useApp } from '../lib/store.ts';
import type { SessionEntry } from '../lib/store.ts';
import { markdownLabels } from '../lib/labels.ts';
import { formatTokens } from '../lib/session-readings.ts';
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

/** Whole seconds of a recorded span, never inventing a start the log did not keep. */
export function recordedSeconds(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  return Math.max(1, Math.round((endedAt - startedAt) / 1000));
}

function durationText(t: Translate, turn: DisplayTurn): string {
  if (turn.reason === 'interrupted') return t('Stopped');
  if (turn.reason === 'error') return t('Turn failed');
  const seconds = recordedSeconds(turn.startedAt, turn.endedAt);
  if (seconds === undefined) return t('Worked');
  return t('Worked for {duration}', { duration: elapsedClock(t, seconds) });
}

/** A message timestamp reads as day and time; the year is never shown. */
function messageTime(date: Date, locale: Locale): string {
  return date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Exact input/output split behind a reply's token chip. The chip itself stays
 * compact; the split is what a reader checking a bill wants to see.
 */
export function usageDetail(usage: MessageUsage, locale: Locale, t: Translate): string {
  const exact = (value: number): string => value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  return `${t('Input tokens')} ${exact(usage.inputTokens)} · ${t('Output tokens')} ${exact(usage.outputTokens)}`;
}

/**
 * Token accounting for one reply: an icon and the compact total a reply spent,
 * with the input/output split on hover. Messages the provider reported nothing
 * for (and calls that resolved locally) simply have no chip.
 */
function UsageChip({ usage, locale, t }: { usage: MessageUsage; locale: Locale; t: Translate }): ReactNode {
  const total = usage.inputTokens + usage.outputTokens;
  if (total === 0) return null;
  return (
    <Tooltip label={usageDetail(usage, locale, t)} side="top" delayMs={400}>
      <span className={messageCss.usage} data-message-usage>
        <IconDatabaseOutlineRegular />
        {t('{count} tok', { count: formatTokens(total, t) })}
      </span>
    </Tooltip>
  );
}

export function MessageActions({ text, timestamp, usage, durationSeconds, locale, t }: {
  text: string;
  timestamp?: number;
  usage?: MessageUsage;
  /** Whole seconds a finished reply took, from its persisted turn bounds. */
  durationSeconds?: number;
  locale: Locale;
  t: Translate;
}): ReactNode {
  const { copied, failed, onCopy } = useClipboardCopy(text);
  const date = timestamp === undefined ? null : new Date(timestamp);
  const validDate = date !== null && Number.isFinite(date.getTime()) ? date : null;
  const label = copied ? t('Copied') : failed ? t('Could not copy message') : t('Copy message');
  return (
    <div className={messageCss.actions}>
      {usage !== undefined && <UsageChip usage={usage} locale={locale} t={t} />}
      {durationSeconds !== undefined && (
        <span className={messageCss.duration} data-reply-duration>{t('Took {duration}', { duration: elapsedClock(t, durationSeconds) })}</span>
      )}
      {validDate !== null && <time dateTime={validDate.toISOString()}>{messageTime(validDate, locale)}</time>}
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

/** Whole seconds under a minute, minutes and seconds from there on. */
export function elapsedClock(t: Translate, seconds: number): string {
  return seconds < 60
    ? t('{seconds}s', { seconds })
    : t('{minutes}m{seconds}s', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** The running turn's own start, once this tab has recorded one. */
function openTurnStart(turns: readonly DisplayTurn[]): number | undefined {
  const last = turns.at(-1);
  return last !== undefined && last.live && last.endedAt === undefined ? last.startedAt : undefined;
}

/**
 * Seconds the running status has counted. A turn this tab started records its
 * own start; a run followed from another tab may publish none, so the first
 * active frame stands in until a turn reports a real start.
 */
function useRunningSeconds(start: number | undefined, active: boolean): number | undefined {
  const [anchor, setAnchor] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) {
      setAnchor(undefined);
      return;
    }
    if (start !== undefined) {
      setAnchor(start);
      return;
    }
    setAnchor((current) => current ?? Date.now());
  }, [active, start]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [active]);
  return anchor === undefined ? undefined : Math.max(0, Math.floor((now - anchor) / 1000));
}

/** The status row under the transcript: what the agent is doing, and for how long. */
function RunningStatus({ run, startedAt, t }: { run: LiveTurnState; startedAt: number | undefined; t: Translate }): ReactNode {
  const seconds = useRunningSeconds(startedAt, run.stopping !== true && run.finishing !== true);
  return (
    <div className={chatCss.running} data-holding={run.finishing ? '' : undefined}>
      <span className={chatCss.runningDivider} aria-hidden />
      <div className={chatCss.runningContent} role="status">
        <span className={chatCss.runningIcon} aria-hidden>
          <IconLoadingOutlineRegular className={css.spin} />
        </span>
        <span className={chatCss.runningText}>
          <TextShimmer>
            {run.stopping === true ? t('Stopping…')
              : run.finishing === true ? t('Saving session…')
                : run.approval !== undefined ? t('Waiting for approval')
                  : t('Agent is working')}
          </TextShimmer>
          {seconds !== undefined && (
            <span className={chatCss.runningElapsed} data-running-elapsed>{`· ${elapsedClock(t, seconds)}`}</span>
          )}
        </span>
      </div>
    </div>
  );
}

function TurnView({ turn, processDisplay, locale, t }: { turn: DisplayTurn; processDisplay: 'collapsed' | 'expanded'; locale: Locale; t: Translate }): ReactNode {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (turn.live || processDisplay === 'expanded');
  const hasProcess = turn.process.length > 0;
  const toolLabel = turn.toolCount === 1 ? t('1 tool') : t('{count} tools', { count: turn.toolCount });
  const label = turn.live ? t('Working') : durationText(t, turn);
  const duration = !turn.live && turn.final !== undefined ? recordedSeconds(turn.startedAt, turn.endedAt) : undefined;
  return (
    <div className={css.turn} data-live={turn.live || undefined}>
      {turn.user !== undefined && (
        <div className={clsx(messageCss.userRow, messageCss.message)}>
          <div className={messageCss.userStack}>
            <UserContent user={turn.user} />
            <MessageActions text={userMessageCopyText(turn.user.text, turn.user.attachments)} timestamp={turn.user.timestamp} locale={locale} t={t} />
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
          <MessageActions
            text={turn.final.text}
            timestamp={turn.final.timestamp}
            usage={turn.final.usage}
            durationSeconds={duration}
            locale={locale}
            t={t}
          />
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
  const sessionId = app.sessionId;
  const scroll = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  /**
   * The reader is following the tail, so new content scrolls into view.
   * Starts true: opening a conversation lands on its newest message instead of
   * its first one, and only a reader who scrolls up actually stops following.
   */
  const following = useRef(true);
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

  const stickToBottom = (): void => {
    const element = scroll.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  };

  // A conversation opens on its newest message; switching sessions re-pins even
  // when the previous one was left scrolled up.
  useLayoutEffect(() => {
    following.current = true;
    setAwayFromBottom(false);
    stickToBottom();
  }, [sessionId]);

  useLayoutEffect(() => {
    if (following.current) stickToBottom();
  }, [turns.length, tail, live?.approval, live?.planReview]);

  // Content can also grow without a render here: decoded images, loaded fonts,
  // highlighted code. While the reader follows the tail, those growths must not
  // push the newest message out of view.
  useEffect(() => {
    const element = scroll.current;
    const inner = column.current;
    if (element === null || inner === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) stickToBottom();
    });
    observer.observe(inner);
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    const onScroll = (): void => {
      const atBottom = nearBottom();
      following.current = atBottom;
      setAwayFromBottom(!atBottom);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); };
  }, []);

  return (
    <MarkdownDelegateProvider openFile={onOpenFile}>
    <div className={chatCss.root} data-chat-following-tail={awayFromBottom ? undefined : ''}>
      <div className={chatCss.scroll} ref={scroll} data-conversation-scroll="">
        <div className={chatCss.column} ref={column}>
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
            <RunningStatus run={entry.run} startedAt={openTurnStart(turns)} t={t} />
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
              following.current = true;
              setAwayFromBottom(false);
              stickToBottom();
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
