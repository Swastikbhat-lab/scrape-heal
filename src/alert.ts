/**
 * Fleet alerting — the day a target breaks, a human should know without
 * reading a scheduler's exit code.
 *
 * Zero new dependencies: a plain fetch per channel. Slack and Discord take
 * incoming-webhook URLs (the shape differs slightly); `webhook` is a generic
 * JSON endpoint that receives the raw message. Alerting is best-effort by
 * design — a failed channel is logged, never fatal to the loop.
 */

export interface AlertChannel {
  /** Slack incoming-webhook URL. */
  slack?: string;
  /** Discord incoming-webhook URL. */
  discord?: string;
  /** Generic webhook — receives the message object as JSON. */
  webhook?: string;
  /** Per-target cooldown: at most one alert per this many minutes, so a
   *  target that stays broken doesn't ping the channel every cycle.
   *  Default 60; 0 disables throttling (alert every red cycle). */
  cooldownMinutes?: number;

  /** Also alert on healthy cycles whose data changed (see `watch` in the
   *  config — thresholds decide which changes are worth it). Default off. */
  onChange?: boolean;
  /** Cooldown for change alerts, minutes. Default 60; 0 alerts every
   *  qualifying change. Tracked separately from `cooldownMinutes`, so a
   *  price-drop ping never suppresses a red-cycle alert or vice versa. */
  changeCooldownMinutes?: number;
}

export interface AlertMessage {
  /** The target that went red (URL, or '(rows source)'). */
  target: string;
  cycle: number;
  /** The one-line summary — same text a cron scheduler would see. */
  summary: string;
  at: string;
  /** Evidence captured on this red cycle — screenshot/DOM paths relative to
   *  the state dir, plus the HTTP status that caused it. The generic webhook
   *  receives the whole record; Slack/Discord get it as a text line. */
  evidence?: import('./evidence.js').CycleEvidence;
}

const TIMEOUT_MS = 5_000;

function humanText(m: AlertMessage): string {
  let text = `🚨 scrape-heal — ${m.target} went red on cycle ${m.cycle}\n${m.summary}\n(${m.at})`;
  if (m.evidence) {
    const parts: string[] = [];
    if (m.evidence.status !== undefined) parts.push(`HTTP ${m.evidence.status}`);
    if (m.evidence.screenshot) parts.push(`screenshot: ${m.evidence.screenshot}`);
    if (m.evidence.dom) parts.push(`dom: ${m.evidence.dom}`);
    if (parts.length) text += `\nevidence → ${parts.join(' · ')}`;
  }
  return text;
}

async function post(url: string, payload: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/**
 * Deliver an alert to every configured channel. Throws only if *all* channels
 * fail (callers log that); individual failures are aggregated into one error
 * so one dead webhook can't silently swallow the rest.
 */
export async function sendAlert(channels: AlertChannel, msg: AlertMessage): Promise<void> {
  const jobs: Promise<Response>[] = [];
  if (channels.slack) jobs.push(post(channels.slack, { text: humanText(msg) }));
  if (channels.discord) jobs.push(post(channels.discord, { content: humanText(msg) }));
  if (channels.webhook) jobs.push(post(channels.webhook, msg));

  if (!jobs.length) return;
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
  if (failed.length) {
    const why = failed.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : `HTTP ${r.value.status}`));
    throw new Error(`${failed.length} alert channel(s) failed: ${why.join('; ')}`);
  }
}
