import { z } from 'zod';
import type { Tool } from '../../domain/tool';

export const ASK_USER_TOOL_NAME = 'ask_user';

/** Foreground wait when the caller does not override it. Five minutes. */
export const ASK_USER_DEFAULT_TIMEOUT_SEC = 300;
/** Longest finite wait a call or the global setting may request. One day. */
export const ASK_USER_MAX_TIMEOUT_SEC = 86_400;

const LIMITS = {
  questions: 8,
  id: 80,
  question: 2_000,
  header: 80,
  options: 6,
  label: 120,
  description: 500,
  custom: 2_000,
} as const;

const optionSchema = z.object({
  label: z.string().describe('Short user-facing option label.'),
  description: z.string().describe('One sentence explaining the tradeoff or impact.').optional(),
}).strict();

const questionSchema = z.object({
  id: z.string().describe('Stable id for this question; echoed in the answer.'),
  question: z.string().describe('The specific question to ask the user.'),
  header: z.string().describe('Optional short heading, such as "Confirm" or "Choose".').optional(),
  options: z.array(optionSchema).describe(
    'Optional choices. Put a recommended choice first and append "(Recommended)" to its label.',
  ).optional(),
  multi_select: z.boolean().describe('Whether the user may select more than one option. Defaults to false.').optional(),
}).strict();

const Params = z.object({
  questions: z.array(questionSchema).describe('Questions to ask before continuing.'),
  timeout_sec: z.number().describe(
    'Wait seconds for the whole batch. Omit to use the configured default. '
    + 'Use -1 only when an answer is required before any further work.',
  ).optional(),
}).strict();

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  header?: string;
  options?: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface AskUserAnswerBatch {
  answers: AskUserAnswerItem[];
}

export interface AskUserPendingResult {
  pending: true;
  callId: string;
}

export type AskUserToolResult = AskUserAnswerBatch | AskUserPendingResult;

export interface AskUserRequest {
  questions: AskUserQuestion[];
  /** -1 waits until an answer or cancellation. A positive value is seconds. */
  timeoutSec: number;
  signal: AbortSignal;
  /** Request id reserved for this call, when the session persisted one. */
  requestId?: string;
}

/**
 * Model-facing meaning of a pending result. It travels inside the tool result
 * so a later reader can tell a timeout from a skipped answer.
 */
export const ASK_USER_PENDING_MESSAGE =
  'No answer arrived before the timeout. This is pending, not a skipped answer and not permission to proceed. '
  + 'Continue useful work that does not depend on the answer. The user can still answer; '
  + 'their reply arrives as a user message identified as answer_to_pending_question with this callId.';

const skippedGuidance =
  'An answer item with empty selected and no custom means the user skipped that question: '
  + 'continue without it, do not ask it again, and do not treat the skip as permission. '
  + 'A pending result is different: the wait expired and the question is still answerable. '
  + 'A timeout is never permission.';

const description =
  'Ask the user a short, direct question when you need a decision, a preference, or information you cannot discover. '
  + 'Use user-facing words. Do not ask about work you can investigate yourself. '
  + skippedGuidance;

function bounded(value: string, max: number, label: string): string {
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new Error(`${label} must be 1–${max} characters`);
  }
  return text;
}

/** Reject a batch the UI cannot render unambiguously. */
export function parseAskUserQuestions(value: unknown): AskUserQuestion[] {
  const parsed = Params.parse(value);
  if (parsed.questions.length === 0 || parsed.questions.length > LIMITS.questions) {
    throw new Error(`ask_user accepts 1–${LIMITS.questions} questions`);
  }
  const seen = new Set<string>();
  return parsed.questions.map((question) => {
    const id = bounded(question.id, LIMITS.id, 'question id');
    if (seen.has(id)) throw new Error(`question id ${JSON.stringify(id)} must be unique within this call`);
    seen.add(id);
    const options = question.options?.map((option) => {
      const label = bounded(option.label, LIMITS.label, 'option label');
      const descriptionText = option.description === undefined
        ? undefined
        : bounded(option.description, LIMITS.description, 'option description');
      return { label, ...(descriptionText === undefined ? {} : { description: descriptionText }) };
    });
    if (options !== undefined) {
      if (options.length === 0 || options.length > LIMITS.options) {
        throw new Error(`a question accepts 1–${LIMITS.options} options`);
      }
      const labels = new Set<string>();
      for (const option of options) {
        if (labels.has(option.label)) {
          throw new Error(`option label ${JSON.stringify(option.label)} must be unique within its question`);
        }
        labels.add(option.label);
      }
    }
    const header = question.header === undefined ? undefined : bounded(question.header, LIMITS.header, 'question header');
    return {
      id,
      question: bounded(question.question, LIMITS.question, 'question'),
      ...(header === undefined ? {} : { header }),
      ...(options === undefined ? {} : { options }),
      multiSelect: question.multi_select === true,
    };
  });
}

/** -1 waits forever. Anything else must be a whole number of seconds inside the cap. */
export function parseAskUserTimeout(value: unknown, fallback: number): number {
  const timeout = value === undefined ? fallback : value;
  if (timeout === -1) return -1;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > ASK_USER_MAX_TIMEOUT_SEC) {
    throw new Error(`timeout_sec must be -1 or an integer from 1 to ${ASK_USER_MAX_TIMEOUT_SEC}`);
  }
  return timeout;
}

/**
 * Check a submitted batch against the questions that were asked.
 * A skipped question is `{ id, selected: [] }` with no custom text.
 */
export function validateAskUserAnswers(
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswerItem[],
): AskUserAnswerItem[] {
  if (answers.length !== questions.length) {
    throw new Error(`the answer batch must name each of its ${questions.length} questions exactly once`);
  }
  const byId = new Map<string, AskUserQuestion>();
  for (const question of questions) byId.set(question.id, question);
  const seen = new Set<string>();
  return answers.map((answer) => {
    const id = typeof answer.id === 'string' ? answer.id.trim() : '';
    const question = byId.get(id);
    if (question === undefined || seen.has(id)) {
      throw new Error('each answer must name one asked question exactly once');
    }
    seen.add(id);
    if (!Array.isArray(answer.selected) || answer.selected.some((label) => typeof label !== 'string')) {
      throw new Error(`answer ${JSON.stringify(id)} has invalid selected labels`);
    }
    const selected = answer.selected.map((label) => label.trim()).filter((label) => label.length > 0);
    const allowed = new Set(question.options?.map((option) => option.label) ?? []);
    if (question.options === undefined) {
      if (selected.length > 0) throw new Error(`answer ${JSON.stringify(id)} has no options to select`);
    } else if (selected.some((label) => !allowed.has(label))) {
      throw new Error(`answer ${JSON.stringify(id)} selects an option that was not offered`);
    }
    const unique = [...new Set(selected)];
    if (!question.multiSelect && unique.length > 1) {
      throw new Error(`answer ${JSON.stringify(id)} selects more than one option`);
    }
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : '';
    if (answer.custom !== undefined && typeof answer.custom !== 'string') {
      throw new Error(`answer ${JSON.stringify(id)} has invalid custom text`);
    }
    if (custom.length > LIMITS.custom) throw new Error(`custom text must be at most ${LIMITS.custom} characters`);
    if (!question.multiSelect && unique.length > 0 && custom.length > 0) {
      throw new Error(`answer ${JSON.stringify(id)} cannot combine a selection with custom text`);
    }
    return {
      id,
      selected: unique,
      ...(custom.length > 0 ? { custom } : {}),
    };
  });
}

export function renderAskUserResult(result: AskUserToolResult): string {
  if ('pending' in result) {
    return JSON.stringify({ pending: true, callId: result.callId, message: ASK_USER_PENDING_MESSAGE });
  }
  return JSON.stringify({
    answers: result.answers.map((answer) => ({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })),
  });
}

/** Text of the user message that carries an answer after the tool already returned pending. */
export function renderLateAskUserAnswer(input: {
  callId: string;
  questions: readonly AskUserQuestion[];
  answers: readonly AskUserAnswerItem[];
}): string {
  return JSON.stringify({
    kind: 'answer_to_pending_question',
    tool: ASK_USER_TOOL_NAME,
    callId: input.callId,
    questions: input.questions,
    answers: input.answers,
  });
}

export interface AskUserToolOptions {
  /** Configured foreground wait used when a call omits timeout_sec. */
  defaultTimeoutSec?: number;
  ask(request: AskUserRequest): Promise<AskUserToolResult>;
  /** Tool call that owns this invocation, used when the wait expires. */
  callId?: () => string | undefined;
}

export function createAskUserTool(options: AskUserToolOptions): Tool {
  const fallback = options.defaultTimeoutSec ?? ASK_USER_DEFAULT_TIMEOUT_SEC;
  return {
    name: ASK_USER_TOOL_NAME,
    description,
    parameters: Params,
    mutating: false,
    async execute(args, ctx) {
      const questions = parseAskUserQuestions(args);
      const record = Params.parse(args);
      const timeoutSec = parseAskUserTimeout(record.timeout_sec, parseAskUserTimeout(fallback, ASK_USER_DEFAULT_TIMEOUT_SEC));
      ctx.signal.throwIfAborted();
      // The answer outlives the turn that asked. Cancelling the turn must not
      // cancel a question the user can still answer after a restart.
      const result = await options.ask({ questions, timeoutSec, signal: new AbortController().signal });
      const rendered = 'pending' in result && result.pending && result.callId === ''
        ? { ...result, callId: options.callId?.() ?? result.callId }
        : result;
      return { content: renderAskUserResult(rendered), ok: true };
    },
  };
}
