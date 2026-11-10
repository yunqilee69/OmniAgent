import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PlanPreview,
  PlanReviewCard,
  PlanReviewComposer,
  planTitle,
} from '../ui/src/components/PlanReview.tsx';
import type { PlanReviewRequest } from '../ui/src/lib/events.ts';
import { store } from '../ui/src/lib/store.ts';

const review: PlanReviewRequest = {
  requestId: 'plan-1',
  plan: '# 侧边栏预览方案\n\n## 现状\n\n| 位置 | 事实 |\n| --- | --- |\n| `a.ts` | 只读文本 |\n',
  pending: false,
  error: '',
  feedback: '',
};

function render(locale: 'zh' | 'en', element: Parameters<typeof renderToStaticMarkup>[0]): string {
  const snapshot = store.getSnapshot();
  const spy = vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...snapshot, locale });
  try {
    return renderToStaticMarkup(element);
  } finally {
    spy.mockRestore();
  }
}

describe('plan review surfaces', () => {
  it('takes the plan heading as the card title', () => {
    expect(planTitle(review.plan)).toBe('侧边栏预览方案');
    expect(planTitle('no heading')).toBe('');
  });

  it('renders an inline card that opens the plan instead of a blocking dialog', () => {
    const markup = render('zh', createElement(PlanReviewCard, { review, onOpen: () => undefined }));
    expect(markup).toContain('侧边栏预览方案');
    expect(markup).toContain('查看计划');
    expect(markup).toContain('查看计划后批准');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('aria-modal');
  });

  it('renders the full plan as markdown in the side panel', () => {
    const markup = render('zh', createElement(PlanPreview, {
      plan: { plan: review.plan, pending: false },
    }));
    expect(markup).toContain('<h1>侧边栏预览方案</h1>');
    expect(markup).toContain('<h2>现状</h2>');
    expect(markup).toContain('等待你的审阅');
  });

  it('drops the live status bar once the review settles', () => {
    const markup = render('zh', createElement(PlanPreview, { plan: { plan: review.plan } }));
    expect(markup).not.toContain('等待你的审阅');
    expect(markup).toContain('<h1>侧边栏预览方案</h1>');
  });

  it('turns the composer into feedback plus approve / keep planning', () => {
    const originalConsoleError = console.error;
    const consoleError = vi.spyOn(console, 'error').mockImplementation((message, ...args) => {
      if (typeof message !== 'string' || !message.includes('useLayoutEffect does nothing on the server')) {
        originalConsoleError(message, ...args);
      }
    });
    try {
      const markup = render('zh', createElement(PlanReviewComposer, {
        review,
        stopping: false,
        onOpenPreview: () => undefined,
      }));
      expect(markup).toContain('批准计划');
      expect(markup).toContain('继续规划');
      expect(markup).toContain('输入修改意见，让智能体继续规划');
      expect(markup).toContain('查看计划');
    } finally {
      consoleError.mockRestore();
    }
  });
});
