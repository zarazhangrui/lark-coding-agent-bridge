import type {
  ApiMessageItem,
  LarkChannel,
  RawMessageEvent,
} from '@larksuite/channel';
import { normalize } from '@larksuite/channel';
import { log } from '../core/logger';
import { MAX_TOPIC_CURSOR_RECENT_IDS, type TopicCursor } from '../session/store';
import { expandInteractiveCard } from './interactive-card';

export interface QuotedContext {
  messageId: string;
  senderId: string;
  senderName?: string;
  /** Human vs bot, derived from the Feishu `sender.sender_type`. Undefined when
   * the source item didn't carry it (single-quote fetch path). */
  senderType?: 'user' | 'bot';
  /** ISO timestamp of the quoted message's creation. Empty when SDK can't
   * resolve it from the fetched item. */
  createdAt: string;
  /** Normalized human-readable content. For text/post this is plain text;
   * for merge_forward the SDK expands the tree into `<forwarded_messages>...
   * </forwarded_messages>` (capped at 50 items by the SDK). */
  content: string;
  rawContentType: string;
}

/**
 * Mutable status for callers that persist a replay cursor after a run. A
 * best-effort context read may return no rows after an upstream failure; in
 * that case the caller must not move its cursor past messages it never saw.
 */
export interface TopicContextFetchStatus {
  complete: boolean;
  /** Message ids observed in the bounded upstream read; bodies are discarded. */
  seenMessageIds?: string[];
}

const TOPIC_SEEN_ID_LIMIT = MAX_TOPIC_CURSOR_RECENT_IDS;

/**
 * Fetch and normalize the content of a message that the user is reply-quoting.
 *
 * Why this is non-trivial: `im.v1.message.get` returns a flat `ApiMessageItem`
 * list (parent + descendants for merge_forward), but the bot intake pipeline
 * deals in `NormalizedMessage`. We synthesize a `RawMessageEvent` from the
 * parent item and feed it through the SDK's `normalize` so merge_forward gets
 * the same `<forwarded_messages>` expansion path that live events do.
 *
 * `chatId` / `chatType` on the synthesized raw event don't have to be real —
 * normalize doesn't validate them, and downstream only uses the resulting
 * `content`. Same for mentions (we don't pass any).
 */
/**
 * Rewrite an interactive sub-message's body.content so the SDK's
 * `convertInteractive` → `walkCard` finds a text node and emits real card
 * content instead of the literal `[interactive card]` placeholder. We wrap
 * our expanded `<interactive_card>` block as a `plain_text` node — that's
 * one of the three tags walkCard treats as text-bearing
 * (plain_text / lark_md / markdown).
 *
 * This is the merge_forward fix: sub-messages bypass the parent-level
 * expansion because the SDK assembles `<forwarded_messages>` internally from
 * each sub's flattened form, so we have to inject expansion at the sub-fetch
 * layer.
 */
function preExpandInteractive(item: ApiMessageItem): ApiMessageItem {
  if (item.msg_type !== 'interactive') return item;
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return item;
  const expanded = expandInteractiveCard('[interactive card]', raw);
  // expandInteractiveCard returns the placeholder unchanged when there's
  // nothing to expand — skip rewriting in that case to avoid double wrapping.
  if (expanded === '[interactive card]') return item;
  const wrapper = JSON.stringify({ tag: 'plain_text', content: expanded });
  return { ...item, body: { ...item.body, content: wrapper } };
}

export async function fetchQuotedContext(
  channel: LarkChannel,
  messageId: string,
): Promise<QuotedContext | undefined> {
  let items: ApiMessageItem[];
  try {
    // Ask for the original card JSON (incl. v2 user_dsl) instead of the
    // default v1-canonical fallback that strips it.
    items = await channel.fetchRawMessage(messageId, {
      cardContentType: 'user_card_content',
    });
  } catch (err) {
    log.warn('quote', 'fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  const parent = items[0];
  if (!parent || !parent.message_id) return undefined;

  // Reuse the already-fetched items when the SDK re-asks for sub-messages of
  // this same id (merge_forward case). For nested merge_forwards inside, fetch
  // fresh — and let a fetch failure throw so it surfaces as a fetch_failed
  // forward rather than a silently-empty one (see fetchSubTreeItems).
  const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
    if (mid === parent.message_id) return items.map(preExpandInteractive);
    const subItems = await fetchSubTreeItems(channel, mid);
    return subItems.map(preExpandInteractive);
  };

  return normalizeItemToQuoted(channel, parent, fetchSubMessages);
}

function mapSenderType(raw: unknown): 'user' | 'bot' | undefined {
  if (raw === 'user') return 'user';
  if (raw === 'app' || raw === 'bot') return 'bot';
  return undefined;
}

/**
 * Normalize a single fetched message item (from `im.v1.message.get` or
 * `im.v1.message.list`) into a {@link QuotedContext}. Shared by the reply-quote
 * path and the topic-context path. `fetchSubMessages` resolves merge_forward
 * children — callers decide whether to reuse an already-fetched batch or fetch
 * fresh.
 */
async function normalizeItemToQuoted(
  channel: LarkChannel,
  parent: ApiMessageItem,
  fetchSubMessages: (mid: string) => Promise<ApiMessageItem[]>,
): Promise<QuotedContext | undefined> {
  if (!parent.message_id) return undefined;
  const senderOpenId = senderIdOf(parent);
  const fakeRaw: RawMessageEvent = {
    sender: { sender_id: { open_id: senderOpenId } },
    message: {
      message_id: parent.message_id,
      // chat_id / chat_type aren't actually used by normalize's converters,
      // but the field is required by the type. Empty strings are safe.
      chat_id: '',
      chat_type: 'group',
      message_type: parent.msg_type ?? 'text',
      content: parent.body?.content ?? '',
      create_time: parent.create_time !== undefined ? String(parent.create_time) : undefined,
      mentions: parent.mentions,
    },
  };

  const botIdentity = channel.botIdentity ?? { openId: '', name: '' };
  try {
    const normalized = await normalize(fakeRaw, {
      botIdentity,
      fetchSubMessages,
      // We want the raw content here, not the trimmed @bot mention form.
      stripBotMentions: false,
    });
    const createMs = parent.create_time
      ? Number.parseInt(String(parent.create_time), 10)
      : 0;
    return {
      messageId: parent.message_id,
      senderId: senderOpenId ?? '',
      senderName: normalized.senderName,
      senderType: mapSenderType(parent.sender?.sender_type),
      createdAt: Number.isFinite(createMs) && createMs > 0
        ? new Date(createMs).toISOString()
        : '',
      // For zero-text interactive cards the SDK gave us "[interactive card]"
      // — substitute the raw JSON so Claude can still see what was quoted.
      content: expandInteractiveCard(normalized.content, parent.body?.content),
      rawContentType: parent.msg_type ?? 'text',
    };
  } catch (err) {
    log.warn('quote', 'normalize-failed', {
      messageId: parent.message_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Fetch a Feishu topic's upstream messages (chronological) so the agent has the
 * conversation it's being pulled into. Feishu's `im.v1.message.list` with
 * `container_id_type=thread` returns every message in the topic — including the
 * root that may never have @-mentioned the bot. The caller supplies the last
 * successful-run cursor for subsequent turns; when absent this returns the
 * initial upstream context.
 *
 * `excludeIds` drops the triggering messages and any explicit reply-quotes so
 * they aren't duplicated. Pages are read newest-first until the cursor or a
 * bounded recent-message window is reached; filters are then applied and the
 * most recent `maxMessages` are retained. Returns `[]` on any error — context
 * is best-effort.
 */
export async function fetchTopicContext(
  channel: LarkChannel,
  threadId: string,
  opts: {
    maxMessages: number;
    excludeIds?: Set<string>;
    /** Only include messages strictly after this successful-run cursor. */
    after?: TopicCursor;
    /** Only include messages strictly before this triggering-message cursor. */
    before?: TopicCursor;
    /** The bot's own open_id, used to omit bot replies from context. */
    botOpenId?: string;
    /**
     * Ids already observed by the previous successful read. They are used to
     * suppress the bounded overlap rows while allowing a message that was
     * temporarily absent from Feishu's list to appear on a later read.
     */
    seenMessageIds?: ReadonlySet<string>;
    /**
     * Read one bounded page beyond the replay boundary. With an `after`
     * cursor and prior seen ids this is the delayed-message overlap; without
     * prior ids it still seeds metadata but keeps strict-after filtering. On
     * the first read it captures enough ids below `before` to keep that page
     * from being replayed as new history on the next turn.
     */
    overlapAfter?: boolean;
    /** Set to false when pagination cannot prove the requested boundary. */
    status?: TopicContextFetchStatus;
  },
): Promise<QuotedContext[]> {
  const collected: ApiMessageItem[] = [];
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  const seenMessageIds = new Set<string>();
  const exclude = opts.excludeIds ?? new Set<string>();
  const previouslySeen = opts.seenMessageIds ?? new Set<string>();
  const limit = Number.isFinite(opts.maxMessages)
    ? Math.max(0, Math.floor(opts.maxMessages))
    : 0;
  if (opts.status) opts.status.complete = true;
  const overlapAfter = Boolean(opts.after && opts.overlapAfter);
  // Reading the extra page is safe even for an old cursor that has no seen-id
  // metadata yet; only a cursor with prior ids may admit those older rows into
  // the prompt. This lets the first post-upgrade turn seed the metadata while
  // preserving the old strict-after behavior for that turn.
  const allowAfterOverlap = Boolean(overlapAfter && previouslySeen.size > 0);
  const captureInitialOverlap = Boolean(!opts.after && opts.before && opts.overlapAfter);
  const overlapRequested = overlapAfter || captureInitialOverlap;
  // A boundary page itself only proves that the cursor is present. Read one
  // more page before stopping so rows that Feishu indexed out of order can be
  // discovered later. The page is bounded by the API's fixed page size.
  let overlapPageRead = !overlapRequested;
  let boundaryPageSeen = false;
  const maxPages = 10;
  const deadlineAt = Date.now() + 15_000;
  let pagesRead = 0;
  // With an `after` cursor we must reach that boundary before stopping,
  // regardless of how many newer rows exist. Initial context stops once the
  // current triggering boundary is known and enough eligible rows are present.
  let descending = true;
  let directionKnown = false;
  try {
    do {
      if (pagesRead >= maxPages || Date.now() >= deadlineAt) {
        if (opts.status) opts.status.complete = false;
        log.warn('topic', 'context-fetch-budget-exceeded', {
          threadId,
          pagesRead,
          maxPages,
        });
        break;
      }
      pagesRead += 1;
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = (res as {
        data?: { items?: ApiMessageItem[]; messages?: ApiMessageItem[]; has_more?: boolean; page_token?: string };
      }).data;
      const items = data?.items ?? data?.messages ?? [];
      for (const item of items) {
        const messageId = item.message_id;
        if (!messageId || seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
        collected.push(item);
      }
      if (!directionKnown) {
        const first = collected.find((item) => createTimeOf(item) > 0);
        const second = first
          ? collected
              .slice(collected.indexOf(first) + 1)
              .find((item) => createTimeOf(item) > 0)
          : undefined;
        if (first && second && createTimeOf(first) !== createTimeOf(second)) {
          descending = createTimeOf(first) > createTimeOf(second);
          directionKnown = true;
        }
      }
      const boundaryReached = hasAllTopicBoundaries(collected, opts, descending);
      const enoughContext =
        limit === 0 || countTopicCandidates(collected, opts, descending) >= limit;
      const hasMore = data?.has_more === true;
      const nextPageToken = hasMore ? data.page_token : undefined;
      if (overlapRequested && boundaryReached) {
        if (boundaryPageSeen) overlapPageRead = true;
        boundaryPageSeen = true;
      }
      const shouldStop = opts.after
        ? boundaryReached && overlapPageRead
        : boundaryReached && enoughContext && overlapPageRead;
      const repeatedPageToken = Boolean(nextPageToken && seenPageTokens.has(nextPageToken));
      const malformedMore = hasMore && (!nextPageToken || repeatedPageToken);
      if (malformedMore) {
        // A malformed continuation is still a failed read even when the
        // current page happens to satisfy the content boundary. Advancing
        // would make an unseen row in the missing page unrecoverable.
        if (opts.status) opts.status.complete = false;
        pageToken = undefined;
      } else if (shouldStop) {
        pageToken = undefined;
      } else if (!hasMore) {
        // A naturally exhausted list is complete even when it contains fewer
        // than maxMessages. The max is a cap, not a requirement to scan past
        // the end of a short topic. It is incomplete only when a requested
        // after/before boundary was never reached.
        if ((opts.after || opts.before) && !boundaryReached && opts.status) {
          opts.status.complete = false;
        }
        pageToken = undefined;
      } else if (nextPageToken) {
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      } else {
        // `malformedMore` handles the reachable has_more-without-token case;
        // keep this guard for TypeScript's narrowing and future API shapes.
        if (opts.status) opts.status.complete = false;
        pageToken = undefined;
      }
    } while (pageToken);
  } catch (err) {
    if (opts.status) opts.status.complete = false;
    log.warn('topic', 'context-fetch-failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (opts.status) {
    opts.status.seenMessageIds = observedTopicMessageIds(collected, opts, descending);
  }

  const afterIndex = opts.after
    ? collected.findIndex((item) => item.message_id === opts.after?.messageId)
    : -1;
  const beforeIndex = opts.before
    ? collected.findIndex((item) => item.message_id === opts.before?.messageId)
    : -1;
  // Filter against actual API order first. Message ids are the stable
  // boundary when present; timestamp comparisons are only a fallback for a
  // deleted/expired cursor that the upstream list no longer returns.
  const filtered = collected
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      const messageId = item.message_id;
      if (
        !messageId ||
        exclude.has(messageId) ||
        previouslySeen.has(messageId) ||
        isDeletedMessage(item)
      ) {
        return false;
      }
      if (isBotSelfMessage(item, opts.botOpenId)) return false;
      if (opts.after) {
        if (afterIndex >= 0) {
          const afterBoundary = descending ? index < afterIndex : index > afterIndex;
          const cursorRow = index === afterIndex;
          const overlapRow = allowAfterOverlap && !cursorRow;
          if (cursorRow || (!afterBoundary && !overlapRow)) return false;
        } else if (!allowAfterOverlap && createTimeOf(item) < opts.after.createTime) {
          // The cursor id may have expired. Keep same-millisecond rows: the
          // provider's stable order is unavailable, so a duplicate is safer
          // than permanently dropping a message at the boundary.
          return false;
        }
      }
      if (opts.before) {
        if (beforeIndex >= 0) {
          const beforeBoundary = descending ? index > beforeIndex : index < beforeIndex;
          if (!beforeBoundary) return false;
        } else if (createTimeOf(item) > opts.before.createTime) {
          // Same-time rows remain eligible when the trigger id is missing;
          // their order cannot be reconstructed from timestamps alone.
          return false;
        }
      }
      return true;
    })
    // Descending pages are reversed into chronological order. For equal
    // create_time values, reverse collection order preserves the provider's
    // actual same-millisecond ordering; no message-id ordering is invented.
    .sort((a, b) => {
      const byTime = compareCreateTime(a.item, b.item);
      if (byTime !== 0) return byTime;
      return descending ? b.index - a.index : a.index - b.index;
    });
  const relevant = limit > 0 ? filtered.slice(-limit).map(({ item }) => item) : [];

  const out: QuotedContext[] = [];
  for (const item of relevant) {
    const fetchSubMessages = async (mid: string): Promise<ApiMessageItem[]> => {
      const source = mid === item.message_id ? [item] : await fetchSubTreeItems(channel, mid);
      return source.map(preExpandInteractive);
    };
    const quoted = await normalizeItemToQuoted(channel, item, fetchSubMessages);
    if (quoted) {
      out.push(quoted);
    } else if (opts.status) {
      // A selected message that failed normalization (for example a
      // merge_forward whose descendants could not be fetched) was not safely
      // represented in the prompt. Keep the replay cursor until a later run
      // can retry it instead of silently skipping it forever.
      opts.status.complete = false;
    }
  }
  return out;
}

/**
 * Persist ids only from the portion of the list at or before this triggering
 * message. A page can contain newer messages that are not part of the current
 * turn (notably with mocked/lagging list order); marking those as seen would
 * hide them from the next trigger.
 */
function observedTopicMessageIds(
  collected: ApiMessageItem[],
  opts: { before?: TopicCursor },
  descending: boolean,
): string[] {
  const beforeIndex = opts.before
    ? collected.findIndex((item) => item.message_id === opts.before?.messageId)
    : -1;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of collected.entries()) {
    const messageId = item.message_id;
    if (!messageId || seen.has(messageId)) continue;
    if (opts.before) {
      const atOrBefore =
        beforeIndex >= 0
          ? descending
            ? index >= beforeIndex
            : index <= beforeIndex
          : createTimeOf(item) <= opts.before.createTime;
      if (!atOrBefore) continue;
    }
    seen.add(messageId);
    ids.push(messageId);
    if (ids.length >= TOPIC_SEEN_ID_LIMIT) break;
  }
  return ids;
}

function hasAllTopicBoundaries(
  collected: ApiMessageItem[],
  opts: { after?: TopicCursor; before?: TopicCursor },
  descending: boolean,
): boolean {
  if (opts.after && !hasTopicBoundary(collected, { after: opts.after }, descending)) {
    return false;
  }
  if (opts.before && !hasTopicBoundary(collected, { before: opts.before }, descending)) {
    return false;
  }
  return true;
}

function hasTopicBoundary(
  collected: ApiMessageItem[],
  opts: { after?: TopicCursor; before?: TopicCursor },
  descending: boolean,
): boolean {
  if (opts.after) {
    if (collected.some((item) => item.message_id === opts.after?.messageId)) return true;
    // If the cursor message was deleted, stop once a page has crossed its
    // timestamp in the requested direction. Same-time rows remain available
    // for the fallback filter; they are never ordered by message id.
    return collected.some((item) =>
      descending
        ? createTimeOf(item) < opts.after!.createTime
        : createTimeOf(item) > opts.after!.createTime,
    );
  }
  if (opts.before) {
    if (collected.some((item) => item.message_id === opts.before?.messageId)) return true;
    return collected.some((item) =>
      descending
        ? createTimeOf(item) < opts.before!.createTime
        : createTimeOf(item) > opts.before!.createTime,
    );
  }
  return true;
}

function countTopicCandidates(
  collected: ApiMessageItem[],
  opts: {
    after?: TopicCursor;
    before?: TopicCursor;
    excludeIds?: Set<string>;
    botOpenId?: string;
    seenMessageIds?: ReadonlySet<string>;
  },
  descending: boolean,
): number {
  const afterIndex = opts.after
    ? collected.findIndex((item) => item.message_id === opts.after?.messageId)
    : -1;
  const beforeIndex = opts.before
    ? collected.findIndex((item) => item.message_id === opts.before?.messageId)
    : -1;
  const exclude = opts.excludeIds ?? new Set<string>();
  const previouslySeen = opts.seenMessageIds ?? new Set<string>();
  return collected.filter((item, index) => {
    if (
      !item.message_id ||
      exclude.has(item.message_id) ||
      previouslySeen.has(item.message_id) ||
      isDeletedMessage(item) ||
      isBotSelfMessage(item, opts.botOpenId)
    ) {
      return false;
    }
    if (opts.after) {
      if (afterIndex >= 0) {
        if (descending ? index >= afterIndex : index <= afterIndex) return false;
      } else if (createTimeOf(item) < opts.after.createTime) {
        return false;
      }
    }
    if (opts.before) {
      if (beforeIndex >= 0) {
        if (descending ? index <= beforeIndex : index >= beforeIndex) return false;
      } else if (createTimeOf(item) > opts.before.createTime) {
        return false;
      }
    }
    return true;
  }).length;
}

function createTimeOf(item: ApiMessageItem): number {
  const value = (item as { create_time?: unknown }).create_time;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function compareCreateTime(a: ApiMessageItem, b: ApiMessageItem): number {
  return createTimeOf(a) - createTimeOf(b);
}

function senderIdOf(item: ApiMessageItem): string | undefined {
  const sender = item.sender as
    | { id?: unknown; open_id?: unknown; sender_id?: { open_id?: unknown } }
    | undefined;
  if (typeof sender?.id === 'string') return sender.id;
  if (typeof sender?.open_id === 'string') return sender.open_id;
  if (typeof sender?.sender_id?.open_id === 'string') return sender.sender_id.open_id;
  return undefined;
}

function isBotSelfMessage(item: ApiMessageItem, botOpenId: string | undefined): boolean {
  const senderId = senderIdOf(item);
  const senderType = item.sender?.sender_type;
  if (botOpenId && senderId) return senderId === botOpenId;
  // A sender type of `app`/`bot` without an id cannot be distinguished from
  // this bridge, so omit it rather than feeding an agent's own reply back as
  // untrusted topic context.
  return senderType === 'app' || senderType === 'bot';
}

function isDeletedMessage(item: ApiMessageItem): boolean {
  const raw = item as {
    deleted?: unknown;
    status?: unknown;
    is_deleted?: unknown;
    delete_time?: unknown;
    msg_type?: unknown;
    message_type?: unknown;
  };
  return (
    raw.deleted === true ||
    raw.is_deleted === true ||
    raw.status === 'deleted' ||
    raw.status === 'DELETED' ||
    raw.msg_type === 'deleted' ||
    raw.message_type === 'deleted' ||
    (typeof raw.delete_time === 'string' && Number(raw.delete_time) > 0) ||
    (typeof raw.delete_time === 'number' && raw.delete_time > 0)
  );
}

/**
 * Fetch a nested sub-message's items for merge_forward expansion. Unlike a
 * best-effort context fetch, this RE-THROWS on failure: the SDK's
 * convertMergeForward turns a throw into the `<forwarded_messages
 * status="fetch_failed"/>` sentinel, so a transient fetch failure surfaces as
 * fetch_failed instead of being silently flattened to an empty forward — the
 * same distinction @larksuite/channel makes on the live-event path. Passed into
 * `normalize` as `fetchSubMessages`.
 */
async function fetchSubTreeItems(
  channel: LarkChannel,
  messageId: string,
): Promise<ApiMessageItem[]> {
  try {
    return await channel.fetchRawMessage(messageId, { cardContentType: 'user_card_content' });
  } catch (err) {
    log.warn('quote', 'sub-fetch-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Render one or more quoted contexts as an XML block intended to sit at the
 * top of the prompt body (after `<bridge_context>`, before the user's actual
 * question). Returns empty string when there are no quotes — keeps callers
 * concatenating without conditional checks.
 */
export function renderQuotedBlock(quotes: QuotedContext[]): string {
  if (quotes.length === 0) return '';
  const parts = quotes.map((q) => {
    const attrs = [
      `id="${q.messageId}"`,
      q.senderId ? `sender_id="${q.senderId}"` : '',
      q.senderName ? `sender_name="${q.senderName}"` : '',
      q.createdAt ? `created_at="${q.createdAt}"` : '',
      `type="${q.rawContentType}"`,
    ]
      .filter(Boolean)
      .join(' ');
    return `<quoted_message ${attrs}>\n${q.content}\n</quoted_message>`;
  });
  return parts.join('\n');
}
