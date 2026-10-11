import type { CardActionResponse } from '@larksuite/channel';

export function cardFeedback(content: string, type: 'success' | 'info' | 'warning' | 'error' = 'info'): CardActionResponse {
  return { toast: { type, content } };
}

/** A slow REST update must not make the platform callback itself time out. */
export async function respondToCardAction(
  work: () => Promise<void | CardActionResponse>,
  onError: (error: unknown) => void,
): Promise<void | CardActionResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Keep observing completion (and rejection) even after the receipt is sent.
  const result = Promise.resolve().then(work).catch((error) => {
    onError(error);
    return cardFeedback('本次操作未完成，请查看原卡片状态后重试。', 'error');
  });
  try {
    return await Promise.race([
      result,
      new Promise<CardActionResponse>((resolve) => {
        timer = setTimeout(() => resolve(cardFeedback('已收到点击，正在处理。请查看原卡片状态。')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
