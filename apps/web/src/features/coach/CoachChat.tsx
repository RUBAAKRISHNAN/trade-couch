import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, KeyRound, Send, Sparkles, Square, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { useAccountContext } from '@/hooks/data';
import { api, ApiError, apiStream } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';

interface Msg {
  role: 'user' | 'model';
  text: string;
  error?: boolean;
}

const SUGGESTIONS = [
  'How am I doing overall?',
  'Where am I losing money, and why?',
  'What am I good at?',
  'What are the 3 most important things to improve this week?',
  'Explain my last trade',
];

/** Bold (**x**) inside a line, rendered as React nodes: no HTML injection. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/** A small, safe Markdown subset: paragraphs, headings (#), bullet (- / *) and numbered lists, bold. */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={blocks.length}
        className={cn('my-1 space-y-0.5 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}
      >
        {list.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    flush();
    if (heading)
      blocks.push(
        <p key={blocks.length} className="mt-2 font-semibold text-foreground">
          {inline(heading[1]!)}
        </p>,
      );
    else if (line.trim())
      blocks.push(
        <p key={blocks.length} className="my-1">
          {inline(line)}
        </p>,
      );
  }
  flush();
  return <>{blocks}</>;
}

export function CoachChat() {
  const authed = useAuth((s) => !!s.accessToken);
  const competitionId = useAccountContext();
  const status = useQuery({
    queryKey: ['coach', 'chat-status'],
    queryFn: () => api<{ enabled: boolean; model: string | null }>('/coach/chat/status'),
    enabled: authed,
    staleTime: 60_000,
  });
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // braces matter: newer browsers return a Promise from scrollIntoView, and an effect must return nothing
  // (or a cleanup function) — returning the Promise made React crash the whole page
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    // send the conversation so far (without failed replies), newest 19 turns + the question
    const history = messages.filter((m) => !m.error).slice(-19);
    const next: Msg[] = [...messages, { role: 'user', text: q }, { role: 'model', text: '' }];
    setMessages(next);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patch = (fn: (m: Msg) => Msg) => setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1]!)]);
    try {
      await apiStream(
        '/coach/chat',
        {
          messages: [...history, { role: 'user', text: q }].map(({ role, text }) => ({ role, text })),
          ...(competitionId ? { competitionId } : {}),
        },
        (e) => {
          if (typeof e.text === 'string') patch((m) => ({ ...m, text: m.text + e.text }));
          if (typeof e.error === 'string') patch((m) => ({ ...m, text: e.error as string, error: true }));
        },
        ctrl.signal,
      );
    } catch (e) {
      if (!ctrl.signal.aborted)
        patch((m) => ({
          ...m,
          error: true,
          text: e instanceof ApiError ? e.message : 'Could not reach the coach. Check your connection.',
        }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      patch((m) => (m.text ? m : { ...m, text: 'Stopped.', error: true }));
    }
  };

  if (status.data && !status.data.enabled)
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent" /> Ask your AI coach
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <KeyRound className="size-4 text-warn" /> The AI coach isn’t set up yet.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              Create a free API key at <span className="font-mono text-foreground">aistudio.google.com</span>{' '}
              → “Get API key”.
            </li>
            <li>
              Add it to the project’s <span className="font-mono text-foreground">.env</span> file as{' '}
              <span className="font-mono text-foreground">GEMINI_API_KEY=…</span>
            </li>
            <li>
              Restart the app (<span className="font-mono text-foreground">npm run dev</span>).
            </li>
          </ol>
        </CardContent>
      </Card>
    );

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" /> Ask your AI coach
        </CardTitle>
        {messages.length > 0 && !busy && (
          <Button variant="ghost" size="sm" onClick={() => setMessages([])}>
            New chat
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {messages.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              Ask about <strong className="text-foreground">your own trading</strong>: what you do well, where
              you lose money and what to improve. The coach reads your grades, habits and recent trades.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void ask(s)}
                  disabled={!status.data}
                  className="rounded-full border px-3 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="scroll-thin max-h-[480px] space-y-3 overflow-y-auto pr-1" aria-live="polite">
            {messages.map((m, i) => (
              <div key={i} className={cn('flex gap-2', m.role === 'user' && 'flex-row-reverse')}>
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full',
                    m.role === 'user' ? 'bg-panel-2' : 'bg-accent/15 text-accent',
                  )}
                  aria-hidden
                >
                  {m.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
                </span>
                <div
                  className={cn(
                    'max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed',
                    m.role === 'user' ? 'bg-accent/15' : 'bg-panel-2/70',
                    m.error && 'border border-warn/40 text-warn',
                  )}
                >
                  {m.role === 'user' ? (
                    m.text
                  ) : m.text ? (
                    <RichText text={m.text} />
                  ) : (
                    <span className="inline-flex gap-1" aria-label="Coach is thinking">
                      <span className="size-1.5 animate-bounce rounded-full bg-muted" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:120ms]" />
                      <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:240ms]" />
                    </span>
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <label htmlFor="coach-question" className="sr-only">
            Ask the coach a question
          </label>
          <textarea
            id="coach-question"
            rows={1}
            maxLength={2000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder="e.g. Why do I keep losing on BTC?"
            className="min-h-9 flex-1 resize-none rounded-md border bg-panel-2 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
            >
              <Square />
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim() || !status.data} aria-label="Send">
              <Send />
            </Button>
          )}
        </form>
        <p className="text-[11px] text-muted">
          Powered by Google Gemini{status.data?.model ? ` (${status.data.model.replace('gemini:', '')})` : ''}
          . Your trading statistics (not your name or email) are sent to Google to answer. Coaching on habits
          only — not investment advice.
        </p>
      </CardContent>
    </Card>
  );
}
