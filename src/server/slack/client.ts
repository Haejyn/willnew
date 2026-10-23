/**
 * The few Slack Web API calls willnew makes, behind one small interface. The bridge only talks to this, so tests pass a
 * fake and the real one wraps Bolt's WebClient. Type-only import: nothing from @slack loads unless Slack is turned on.
 */
import type { App } from "@slack/bolt";

export type Block = Record<string, unknown>;

export interface SlackMessage {
  /** notification and fallback text */
  text: string;
  blocks?: Block[];
}

export interface SlackFile {
  /** local file path */
  path: string;
  filename: string;
  title: string;
}

export interface SlackClient {
  post(m: SlackMessage & { channel: string; thread_ts?: string }): Promise<{ ts: string }>;
  update(m: SlackMessage & { channel: string; ts: string }): Promise<void>;
  /** only `user` sees it, in the thread when thread_ts is given */
  ephemeral(m: SlackMessage & { channel: string; user: string; thread_ts?: string }): Promise<void>;
  openModal(triggerId: string, view: Block): Promise<void>;
  /** files.uploadV2 into the thread */
  upload(a: { channel: string; thread_ts: string; comment?: string; files: SlackFile[] }): Promise<void>;
}

type WebClient = App["client"];

export function webClient(c: WebClient): SlackClient {
  return {
    async post(m) {
      const r = await c.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: m.text, blocks: m.blocks as never, unfurl_links: false });
      return { ts: String(r.ts ?? "") };
    },
    async update(m) {
      await c.chat.update({ channel: m.channel, ts: m.ts, text: m.text, blocks: (m.blocks ?? []) as never });
    },
    async ephemeral(m) {
      await c.chat.postEphemeral({ channel: m.channel, user: m.user, thread_ts: m.thread_ts, text: m.text, blocks: m.blocks as never });
    },
    async openModal(triggerId, view) {
      await c.views.open({ trigger_id: triggerId, view: view as never });
    },
    async upload(a) {
      await c.files.uploadV2({
        channel_id: a.channel, thread_ts: a.thread_ts, initial_comment: a.comment,
        file_uploads: a.files.map((f) => ({ file: f.path, filename: f.filename, title: f.title })),
      } as never);
    },
  };
}
