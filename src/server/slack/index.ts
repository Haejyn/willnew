/**
 * Slack app (Socket Mode: the hub opens the connection, no public URL). `@slack/bolt` is imported only when Slack is
 * turned on, so `willnew serve` without `--slack` never loads it.
 *
 * Buttons and modals are acknowledged first (Slack wants an answer within 3 seconds) and handled afterwards.
 */
import { MODAL } from "./blocks.js";
import { SlackBridge, type BridgeOptions } from "./bridge.js";
import { webClient, type SlackClient } from "./client.js";
import { ThreadStore } from "./store.js";

export { SlackBridge } from "./bridge.js";
export type { SlackUser, SlackRequests, SlackRuns, SlackChannelInfo } from "./bridge.js";
export type { SlackClient } from "./client.js";

type Ack = (response?: unknown) => Promise<void>;
type Body = { user?: { id?: string }; trigger_id?: string };

/** The part of a Bolt App this file uses. Tests pass a fake that records the handlers. */
export interface SlackApp {
  client?: unknown;
  /** Bolt with deferInitialization: checks the bot token, throws on a bad one */
  init?(): Promise<void>;
  event(name: string, fn: (a: { event: any; context: { botUserId?: string } }) => Promise<void>): unknown;
  action(match: RegExp, fn: (a: { ack: Ack; body: Body; action: { action_id?: string; value?: string } }) => Promise<void>): unknown;
  view(callbackId: string, fn: (a: { ack: Ack; body: Body; view: { private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } } }) => Promise<void>): unknown;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface StartSlackOptions extends Omit<BridgeOptions, "client" | "store"> {
  botToken?: string;
  appToken?: string;
  /** Slack Web API calls; defaults to the Bolt app's client */
  client?: SlackClient;
  /** defaults to a Bolt App in Socket Mode */
  app?: SlackApp;
  /** thread ↔ request file; defaults to HOME/slack/threads.json */
  storePath?: string;
}

export async function startSlack(o: StartSlackOptions): Promise<{ bridge: SlackBridge; stop: () => Promise<void> }> {
  let app = o.app;
  if (!app) {
    if (!o.botToken || !o.appToken) throw new Error("Slack 을 켜려면 SLACK_BOT_TOKEN(xoxb-) 과 SLACK_APP_TOKEN(xapp-) 이 필요해요");
    const bolt = await import("@slack/bolt");
    const App = bolt.App ?? (bolt as unknown as { default: typeof bolt }).default.App;
    const LogLevel = bolt.LogLevel ?? (bolt as unknown as { default: typeof bolt }).default.LogLevel;
    app = new App({ token: o.botToken, appToken: o.appToken, socketMode: true, logLevel: LogLevel.WARN, deferInitialization: true }) as unknown as SlackApp;
  }
  await app.init?.();
  const client = o.client ?? webClient(app.client as Parameters<typeof webClient>[0]);
  const bridge = new SlackBridge({ ...o, client, store: new ThreadStore(o.storePath) });
  wire(app, bridge, o.log);
  await app.start();
  return {
    bridge,
    stop: async () => {
      bridge.close();
      await app.stop();
    },
  };
}

function wire(app: SlackApp, bridge: SlackBridge, log = (m: string) => console.error(m)) {
  const later = (p: Promise<unknown>) => void p.catch((e: Error) => log(`slack: ${e.message}`));
  app.event("app_mention", async ({ event, context }) => later(bridge.mention(event, context.botUserId)));
  app.event("message", async ({ event, context }) => later(bridge.message(event, context.botUserId)));
  app.action(/^wn_/, async ({ ack, body, action }) => {
    await ack();
    later(bridge.action({ actionId: action.action_id ?? "", value: action.value, user: body.user?.id ?? "", triggerId: body.trigger_id }));
  });
  app.view(MODAL, async ({ ack, body, view }) => {
    const input = { privateMetadata: view.private_metadata ?? "", text: view.state?.values?.text?.v?.value ?? "", user: body.user?.id ?? "" };
    const errors = bridge.validate(input);
    if (errors) return void (await ack({ response_action: "errors", errors }));
    await ack();
    later(bridge.submit(input));
  });
}
