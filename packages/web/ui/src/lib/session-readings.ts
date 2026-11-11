/**
 * Display formatting for the composer readings. Every figure the dock shows
 * comes from the durable session metrics, so the formatters stay pure and the
 * locale seat owns rounding-free templates (K/M units, group separators).
 */
import type { Translate } from './i18n.ts';
import type { Locale } from './i18n.ts';

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
export function formatTokens(value: number, t: Translate): string {
  const scaled = (candidate: number): string =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return t('{value}K', { value: scaled(value / 1_000) });
  return t('{value}M', { value: scaled(value / 1_000_000) });
}

/** Exact integer token count with locale-owned digit grouping. */
export function formatExactTokens(value: number, locale: Locale): string {
  return value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
}

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0;
  let upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10);
  const tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * Display-ready cache-hit share without rounding a partial hit to 100%: the
 * metric is only honest if a 99.6% hit does not read as a full cache.
 */
export function formatCacheHitPercent(cacheReadTokens: number, promptTokens: number, decimalPlaces: 0 | 1 = 0): string | null {
  if (promptTokens <= 0) return null;
  const missedInputTokens = promptTokens - cacheReadTokens;
  if (missedInputTokens <= 0) return '100';
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
  if (roundedUnits < (decimalPlaces === 0 ? 100 : 1_000)) return displayPercentUnits(roundedUnits, decimalPlaces);
  let distinguishingPlaces = 1;
  let scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokens / 10);
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10;
    distinguishingPlaces += 1;
  }
  const denominatorOnes = promptTokens % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss;
      break;
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}

/** Decode throughput figure: whole tokens from ten up, one decimal below. */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
export function formatDuration(ms: number, t: Translate): string {
  const seconds = ms / 1_000;
  if (seconds < 60) return t('{seconds}s', { seconds: Math.round(seconds * 10) / 10 });
  const whole = Math.round(seconds);
  return t('{minutes}m{seconds}s', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
}
