import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowUp, KeyRound, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { create } from 'zustand';
import { useAccountContext } from '@/hooks/data';
import { api, ApiError, apiStream } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

interface Msg {
  role: 'user' | 'model';
  text: string;
  error?: boolean;
}

const SUGGESTIONS = [
  { label: 'How am I doing?', q: 'How am I doing overall?' },
  { label: 'Where do I lose money?', q: 'Where am I losing money, and why?' },
  { label: 'What am I good at?', q: 'What am I good at?' },
  { label: 'Top 3 things to improve', q: 'What are the 3 most important things to improve this week?' },
  { label: 'Explain my last trade', q: 'Explain my last trade' },
];

/** The conversation lives outside the panel, so closing it or changing page doesn't lose it. */
interface ChatState {
  messages: Msg[];
  busy: boolean;
  abort: AbortController | null;
  set: (p: Partial<Omit<ChatState, 'set'>>) => void;
  patchLast: (fn: (m: Msg) => Msg) => void;
}
const useChat = create<ChatState>((set) => ({
  messages: [],
  busy: false,
  abort: null,
  set: (p) => set(p),
  patchLast: (fn) =>
    set((s) => ({ messages: [...s.messages.slice(0, -1), fn(s.messages[s.messages.length - 1]!)] })),
}));

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

/** A small, safe Markdown subset: paragraphs, headings (#), bullet (- / *) and numbered lists, rules, bold. */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={blocks.length}
        className={cn(
          'my-1.5 space-y-1 pl-5 marker:text-accent',
          list.ordered ? 'list-decimal' : 'list-disc',
        )}
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
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={blocks.length} className="my-2 border-border" />);
      continue;
    }
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
        <p key={blocks.length} className="mt-3 mb-1 text-[13px] font-semibold text-foreground">
          {inline(heading[1]!)}
        </p>,
      );
    else if (line.trim())
      blocks.push(
        <p key={blocks.length} className="my-1.5">
          {inline(line)}
        </p>,
      );
  }
  flush();
  return <>{blocks}</>;
}

function useChatStatus() {
  const authed = useAuth((s) => !!s.accessToken);
  return useQuery({
    queryKey: ['coach', 'chat-status'],
    queryFn: () => api<{ enabled: boolean; model: string | null }>('/coach/chat/status'),
    enabled: authed,
    staleTime: 60_000,
  });
}

function Thinking() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="Coach is thinking">
      <span className="size-1.5 animate-bounce rounded-full bg-accent" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:120ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:240ms]" />
    </span>
  );
}

/** The chat itself: fills its container, messages scroll, the composer stays at the bottom. */
export function CoachChat() {
  const competitionId = useAccountContext();
  const status = useChatStatus();
  const { messages, busy } = useChat();
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // braces matter: newer browsers return a Promise from scrollIntoView, and an effect must return nothing
  // (or a cleanup function) — returning the Promise made React crash the whole page
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const ask = async (question: string) => {
    const q = question.trim();
    const st = useChat.getState();
    if (!q || st.busy) return;
    const history = st.messages.filter((m) => !m.error).slice(-19);
    const ctrl = new AbortController();
    st.set({
      messages: [...st.messages, { role: 'user', text: q }, { role: 'model', text: '' }],
      busy: true,
      abort: ctrl,
    });
    setInput('');
    const { patchLast } = useChat.getState();
    try {
      await apiStream(
        '/coach/chat',
        {
          messages: [...history, { role: 'user', text: q }].map(({ role, text }) => ({ role, text })),
          ...(competitionId ? { competitionId } : {}),
        },
        (e) => {
          if (typeof e.text === 'string') patchLast((m) => ({ ...m, text: m.text + e.text }));
          if (typeof e.error === 'string') patchLast((m) => ({ ...m, text: e.error as string, error: true }));
        },
        ctrl.signal,
      );
    } catch (e) {
      if (!ctrl.signal.aborted)
        patchLast((m) => ({
          ...m,
          error: true,
          text: e instanceof ApiError ? e.message : 'Could not reach the coach. Check your connection.',
        }));
    } finally {
      useChat.getState().set({ busy: false, abort: null });
      patchLast((m) => (m.text ? m : { ...m, text: 'Stopped.', error: true }));
    }
  };

  if (status.data && !status.data.enabled)
    return (
      <div className="space-y-3 p-5 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <KeyRound className="size-4 text-warn" /> AI coach isn’t set up yet
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>
            Get a free key at <span className="font-mono text-foreground">aistudio.google.com</span>
          </li>
          <li>
            Add <span className="font-mono text-foreground">GEMINI_API_KEY=…</span> to{' '}
            <span className="font-mono">.env</span>
          </li>
          <li>
            Restart with <span className="font-mono text-foreground">npm run dev</span>
          </li>
        </ol>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-center gap-5">
            <div className="text-center">
              <span className="bg-brand mx-auto grid size-12 place-items-center rounded-2xl text-white shadow-[0_8px_30px_-8px_var(--accent)]">
                <Sparkles className="size-6" />
              </span>
              <p className="mt-3 text-base font-semibold">Hi! I’m your trading coach.</p>
              <p className="mt-1 text-sm text-muted">I read your trades and tell you what to improve.</p>
            </div>
            <div className="grid gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  disabled={!status.data}
                  onClick={() => void ask(s.q)}
                  className="rounded-xl border bg-panel-2/60 px-4 py-2.5 text-left text-sm transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:opacity-50"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="bg-brand max-w-[85%] rounded-2xl rounded-br-md px-4 py-2 text-sm text-white">
                  {m.text}
                </p>
              </div>
            ) : (
              <div key={i} className="flex gap-2.5">
                <span
                  className="bg-brand mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-white"
                  aria-hidden
                >
                  <Sparkles className="size-3.5" />
                </span>
                <div
                  className={cn(
                    'min-w-0 flex-1 text-sm leading-relaxed text-foreground/90',
                    m.error && 'rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-warn',
                  )}
                >
                  {m.text ? <RichText text={m.text} /> : <Thinking />}
                </div>
              </div>
            ),
          )
        )}
        <div ref={endRef} />
      </div>

      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border bg-panel-2/70 p-1.5 focus-within:border-accent/60">
          <label htmlFor="coach-question" className="sr-only">
            Ask the coach a question
          </label>
          <textarea
            id="coach-question"
            ref={inputRef}
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
            placeholder="Ask about your trading…"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => useChat.getState().abort?.abort()}
              aria-label="Stop"
              className="grid size-9 place-items-center rounded-xl border hover:bg-panel-2"
            >
              <Square className="size-4" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !status.data}
              aria-label="Send"
              className="bg-brand grid size-9 place-items-center rounded-xl text-white transition-opacity disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <p className="mt-2 px-1 text-center text-[11px] text-muted">
          Gemini reads your trade stats (not your name). Habits coaching only — not investment advice.
        </p>
      </form>
    </div>
  );
}

/** The slide-in panel, opened from the "AI Coach" button in the top bar. */
export function CoachSheet() {
  const { coachOpen, setCoachOpen } = useUi();
  const hasMessages = useChat((s) => s.messages.length > 0);
  const busy = useChat((s) => s.busy);
  return (
    <DialogPrimitive.Root open={coachOpen} onOpenChange={setCoachOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="coach-sheet fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-panel shadow-2xl sm:w-[440px]"
        >
          <div className="flex items-center gap-3 border-b px-5 py-3.5">
            <span className="bg-brand grid size-8 place-items-center rounded-xl text-white">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-sm font-semibold">AI Coach</DialogPrimitive.Title>
              <p className="text-[11px] text-muted">Powered by Google Gemini</p>
            </div>
            {hasMessages && !busy && (
              <button
                type="button"
                onClick={() => useChat.getState().set({ messages: [] })}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-foreground"
              >
                <RotateCcw className="size-3.5" /> New chat
              </button>
            )}
            <DialogPrimitive.Close
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <CoachChat />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
