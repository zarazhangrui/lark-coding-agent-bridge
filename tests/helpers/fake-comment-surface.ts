import { CommentSurface } from '@larksuite/channel';

/**
 * Wrap a fake `rawClient` in the real {@link CommentSurface} so comment tests
 * keep mocking the low-level Feishu endpoints (wiki.getNode,
 * drive.v1.fileComment.*, request) while exercising the SDK's actual
 * get→list and in-thread→top-level fallback logic — the same surface the
 * bridge now calls via `channel.comments`.
 */
export function makeFakeCommentSurface(rawClient: unknown): CommentSurface {
  return new CommentSurface(rawClient as never, {} as never);
}
