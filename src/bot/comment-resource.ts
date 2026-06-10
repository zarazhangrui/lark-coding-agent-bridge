import { createHash } from 'node:crypto';
import type { CommentEvent, LarkChannel } from '@larksuite/channel';

export interface ResolvedCommentTarget {
  fileToken: string;
  fileType: 'doc' | 'docx' | 'sheet' | 'file';
}

export function commentTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function commentDocumentScopeId(fileToken: string): string {
  return `comment-doc:${commentTokenDigest(fileToken)}`;
}

export function commentScopeId(fileToken: string, commentId: string): string {
  return `comment:${commentTokenDigest(`${fileToken}:${commentId}`)}`;
}

export async function resolveCommentTarget(
  channel: LarkChannel,
  evt: CommentEvent,
): Promise<ResolvedCommentTarget | null> {
  // Wiki-node resolution + unsupported-type filtering live in the SDK's
  // CommentSurface now; it returns the underlying obj_token (or passthrough)
  // and null for unsupported file types.
  return channel.comments.resolveTarget(evt.fileToken, evt.fileType);
}
