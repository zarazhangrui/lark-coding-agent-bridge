import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

/**
 * Create a private group chat with the bot (as creator) and one user. Returns
 * the new chat_id. Requires `im:chat` scope on the bot.
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description } = opts;
  const { chatId } = await channel.createChat({
    name,
    description,
    inviteUserIds: [inviteOpenId],
    userIdType: 'open_id',
  });
  return { chatId, name };
}

export function defaultChatName(agentName = 'Agent'): string {
  const d = new Date();
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${agentName} · ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
