import { COACH_FLAGS, type CoachFlag } from '@tradecore/shared';
import type { Pool } from '@tradecore/shared/node';

/**
 * AI COACH CHAT — answers questions about the user's OWN trading, using their real Trade Coach data.
 *
 * The model never sees the database: we build a compact, factual summary (grades, habits, weekly scores, recent
 * round trips, P&L) and send it with the conversation. No name or email is included. The system prompt pins the
 * model to process coaching: it explains what went well, where money was lost and what to improve, and refuses to
 * give buy/sell calls or price predictions.
 */

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

/** A streaming chat model. Gemini in production; a fake in tests. */
export interface ChatProvider {
  readonly name: string;
  stream(
    system: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    /** called when one model fails and the next is tried (for logs) */
    onFallback?: (model: string, error: unknown) => void,
  ): AsyncIterable<string>;
}

export const COACH_SYSTEM_PROMPT = `You are the Trade Coach inside TradeCore, a trading SIMULATOR that uses virtual money for learning.
You talk to one beginner trader about THEIR OWN trading, using only the data in <trader_data>.

How to answer:
- Simple, friendly English. Short paragraphs and bullet points. Use **bold** for key points. Under 250 words unless asked for more.
- Be specific: quote their real numbers (grades, scores, P&L in ₹, how often a habit happened, sizes, holding times).
- Cover what they asked. When they ask generally how they are doing, give: what they do well, where they lose money
  and why, and the 1–3 most important things to improve next, ordered by impact.
- Judge PROCESS, not luck: a disciplined loss is good trading; a lucky win without a stop is bad trading.
- Explain any trading term you use in a few words.
- If the data is thin (few trades), say so and suggest how to practise to get useful feedback.
- Trades marked "demo" are seeded example history, not trades they placed themselves; mention this if it matters.

Never:
- Recommend buying or selling any specific asset, give price targets, predict markets, or give real-money investment advice.
  If asked, say you only coach trading habits on virtual money, and redirect to their process.
- Invent data that is not in <trader_data>.`;

const fmtInr = (paise: number | null | undefined) =>
  paise === null || paise === undefined
    ? 'n/a'
    : `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Everything the model needs, as compact text. Only trading statistics: no names, emails or ids. */
export async function buildTraderContext(pool: Pool, accountId: number): Promise<string> {
  const [acct, holdings, weeks, flags, grades, trips] = await Promise.all([
    pool.query(
      `SELECT a.cash_paise, a.starting_cash_paise, a.competition_id, c.name AS competition
       FROM accounts a LEFT JOIN competitions c ON c.id = a.competition_id WHERE a.id = $1`,
      [accountId],
    ),
    pool.query(
      `SELECT h.symbol, h.qty_units, i.qty_scale, h.cost_basis_paise, h.realized_pnl_paise,
              (h.qty_units * COALESCE(mp.ref_price_paise, mp.last_price_paise, 0) / i.qty_scale) AS value_paise
       FROM holdings h JOIN instruments i ON i.symbol = h.symbol LEFT JOIN market_prices mp ON mp.symbol = h.symbol
       WHERE h.account_id = $1 AND (h.qty_units > 0 OR h.realized_pnl_paise <> 0)`,
      [accountId],
    ),
    pool.query(
      `SELECT week_start, skill_score, trades, win_rate::float AS win_rate, avg_win_paise, avg_loss_paise,
              max_drawdown_paise, habits, goal
       FROM weekly_skill WHERE account_id = $1 ORDER BY week_start DESC LIMIT 4`,
      [accountId],
    ),
    pool.query<{ flag: string; n: number }>(
      `SELECT f AS flag, count(*)::int AS n FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id,
              unnest(c.flags) f
       WHERE r.account_id = $1 AND r.closed_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`,
      [accountId],
    ),
    pool.query<{ grade: string; n: number; pnl: number }>(
      `SELECT c.grade, count(*)::int AS n, COALESCE(sum(r.pnl_paise), 0)::bigint AS pnl
       FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id WHERE r.account_id = $1 GROUP BY 1 ORDER BY 1`,
      [accountId],
    ),
    pool.query(
      `SELECT r.symbol, r.pnl_paise, r.opened_at, r.closed_at, r.source, r.plan_stop_paise, r.plan_target_paise, r.had_stop_order,
              r.entry_avg_paise, r.exit_avg_paise, c.grade, c.score, c.flags, c.details
       FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
       WHERE r.account_id = $1 ORDER BY r.closed_at DESC LIMIT 20`,
      [accountId],
    ),
  ]);

  const a = acct.rows[0];
  const marketValue = holdings.rows.reduce((s, h) => s + Number(h.value_paise), 0);
  const equity = a ? a.cash_paise + marketValue : 0;
  const lines: string[] = [];
  lines.push(`Wallet: ${a?.competition ? `competition "${a.competition}"` : 'main practice wallet'}`);
  if (a)
    lines.push(
      `Started with ${fmtInr(a.starting_cash_paise)}; equity now ${fmtInr(equity)} (${(((equity - a.starting_cash_paise) / a.starting_cash_paise) * 100).toFixed(2)}% total return); cash ${fmtInr(a.cash_paise)}.`,
    );
  if (holdings.rows.length) {
    lines.push('Holdings:');
    for (const h of holdings.rows)
      lines.push(
        `- ${h.symbol}: ${h.qty_units / h.qty_scale} units worth ${fmtInr(Number(h.value_paise))} (cost ${fmtInr(h.cost_basis_paise)}), realised P&L ${fmtInr(h.realized_pnl_paise)}`,
      );
  }

  const totalTrips = grades.rows.reduce((s, g) => s + g.n, 0);
  lines.push(`Graded round trips (buy → sell back to zero): ${totalTrips}.`);
  if (grades.rows.length)
    lines.push(
      `By grade (count, total P&L): ${grades.rows.map((g) => `${g.grade}: ${g.n} trips, ${fmtInr(Number(g.pnl))}`).join('; ')}.`,
    );

  if (flags.rows.length) {
    lines.push('Habits in the last 30 days (how many trips showed each):');
    for (const f of flags.rows) {
      const info = COACH_FLAGS[f.flag as CoachFlag];
      if (info) lines.push(`- ${info.good ? 'GOOD' : 'PROBLEM'} · ${info.label}: ${f.n} — ${info.explain}`);
    }
  }

  if (weeks.rows.length) {
    lines.push('Weekly Skill Score (newest first; 0–100, process not profit):');
    for (const w of weeks.rows)
      lines.push(
        `- week of ${new Date(w.week_start).toISOString().slice(0, 10)}: score ${w.skill_score}, ${w.trades} trips, win rate ${w.win_rate === null ? 'n/a' : Math.round(w.win_rate * 100) + '%'}, avg win ${fmtInr(w.avg_win_paise)}, avg loss ${fmtInr(w.avg_loss_paise)}, max drawdown ${fmtInr(w.max_drawdown_paise)}, habits [${(w.habits as string[]).join(', ')}], goal "${w.goal}"`,
      );
  }

  if (trips.rows.length) {
    lines.push('Most recent round trips (newest first):');
    for (const t of trips.rows) {
      const d = t.details as {
        sizePct?: number;
        riskPct?: number | null;
        holdMinutes?: number;
        plannedRR?: number | null;
      };
      lines.push(
        `- ${t.symbol}${t.source === 'seed' ? ' (demo)' : ''} closed ${new Date(t.closed_at).toISOString().slice(0, 16).replace('T', ' ')} UTC: grade ${t.grade} (${t.score}/100), P&L ${fmtInr(t.pnl_paise)}, entry ${fmtInr(t.entry_avg_paise)} → exit ${fmtInr(t.exit_avg_paise)}, size ${d.sizePct ?? '?'}% of money, stop: ${t.plan_stop_paise ? `planned at ${fmtInr(t.plan_stop_paise)}` : 'no planned stop price'}${t.had_stop_order ? ', a stop-loss order was placed' : ', no stop-loss order'}, risk to the planned stop ${d.riskPct != null ? `${d.riskPct}% of money` : 'n/a'}, planned R:R ${d.plannedRR ?? 'none'}, held ${d.holdMinutes ?? '?'} min, flags [${(t.flags as string[]).join(', ')}]`,
      );
    }
  } else lines.push('No finished trades yet.');

  return lines.join('\n');
}

/** The full prompt pieces for one chat turn: the trader's data is attached to the first user message. */
export function buildChatRequest(context: string, messages: ChatMessage[]): ChatMessage[] {
  const [first, ...rest] = messages;
  if (!first) return [];
  return [{ role: first.role, text: `<trader_data>\n${context}\n</trader_data>\n\n${first.text}` }, ...rest];
}

// ───────────────────────────── Gemini ─────────────────────────────

/**
 * Parses a Server-Sent Events body from Gemini's streamGenerateContent?alt=sse into text deltas.
 * Each event is `data: {GenerateContentResponse}`; the text is candidates[0].content.parts[*].text.
 */
export async function* parseGeminiSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const event = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('');
      if (!data || data === '[DONE]') continue;
      const json = JSON.parse(data) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
      };
      if (json.promptFeedback?.blockReason)
        throw new Error(`Gemini blocked the request (${json.promptFeedback.blockReason})`);
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text) yield text;
    }
    if (done) break;
  }
}

/**
 * Gemini over REST with streaming. Tries the models in order: if one doesn't start answering within
 * `headerTimeoutMs`, or fails before sending any text with a retryable status (overloaded, quota, not available),
 * the next model is tried. Once text has been sent, there's no switching (the user would see two answers).
 */
export class GeminiProvider implements ChatProvider {
  readonly name: string;
  private readonly models: string[];
  /** the model that answered last (for logs / status) */
  lastModel: string | undefined;

  constructor(
    private apiKey: string,
    models: string | string[],
    private fetchImpl: typeof fetch = fetch,
    private opts: { headerTimeoutMs?: number; maxOutputTokens?: number } = {},
  ) {
    this.models = (Array.isArray(models) ? models : [models]).filter(Boolean);
    if (!this.models.length) throw new Error('GeminiProvider needs at least one model');
    this.name = `gemini:${this.models[0]}`;
  }

  private async open(model: string, system: string, messages: ChatMessage[], signal?: AbortSignal) {
    // abort if the caller goes away, or if the model hasn't even sent response headers in time
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => ctrl.abort(new GeminiError(504, `no response from ${model}`)),
      this.opts.headerTimeoutMs ?? 20_000,
    );
    try {
      const res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          // the key goes in a header, not the URL, so it never ends up in request logs
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
            // newer models spend part of this budget on internal "thinking", so leave plenty of room
            generationConfig: { temperature: 0.4, maxOutputTokens: this.opts.maxOutputTokens ?? 4096 },
          }),
          signal: ctrl.signal,
        },
      );
      if (!res.ok || !res.body) {
        let detail = '';
        try {
          detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
          /* not JSON */
        }
        throw new GeminiError(res.status, detail);
      }
      return res.body;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof GeminiError ? ctrl.signal.reason : e;
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async *stream(
    system: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    onFallback?: (model: string, error: unknown) => void,
  ): AsyncIterable<string> {
    let lastError: unknown;
    for (const model of this.models) {
      let body: ReadableStream<Uint8Array>;
      try {
        body = await this.open(model, system, messages, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        lastError = e;
        // bad key / bad request won't get better with another model
        if (e instanceof GeminiError && (e.status === 400 || e.status === 401 || e.status === 403)) throw e;
        onFallback?.(model, e);
        continue;
      }
      this.lastModel = model;
      yield* parseGeminiSse(body);
      return;
    }
    throw lastError instanceof Error ? lastError : new GeminiError(503, 'no model available');
  }
}

export class GeminiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Gemini API error ${status}${detail ? `: ${detail}` : ''}`);
  }
}
