"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PUBLIC_BUSINESSES } from "@/lib/businesses";
import {
  rankQuotes,
  type Quote,
  type SourceQuote,
} from "@/lib/quote-schema";

type Turn = {
  speaker: "agent" | "business";
  text: string;
  turnIndex: number;
  hasAudio: boolean;
};

type CallState = {
  status: "queued" | "calling" | "done" | "error";
  transcript: Turn[];
  error?: string;
};

type StreamEvent =
  | { type: "queued"; businessId: string; providerName: string }
  | { type: "calling"; businessId: string }
  | { type: "turn"; businessId: string; turn: Turn }
  | { type: "done"; businessId: string; quote: Quote }
  | { type: "error"; businessId: string; message: string };

const DEFAULT_IDS = ["sanjeevani", "healthfirst", "citycare"];

function sourceFor(quote: Quote, fields: string[]) {
  return quote.sourceQuotes.find((source) =>
    fields.some((field) => source.field.toLowerCase().includes(field.toLowerCase()))
  );
}

function PriceCell({
  children,
  source,
  onReveal,
}: {
  children: ReactNode;
  source?: SourceQuote;
  onReveal: (source: SourceQuote) => void;
}) {
  return source ? (
    <button
      type="button"
      onClick={() => onReveal(source)}
      className="text-left text-cyan-300 underline decoration-cyan-800 underline-offset-4 hover:text-cyan-100"
    >
      {children}
    </button>
  ) : (
    <span>{children}</span>
  );
}

export default function CallPage() {
  const [config, setConfig] = useState({
    callId: "local",
    ids: DEFAULT_IDS,
    request: "",
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ids = params
      .getAll("ids")
      .filter((id) => PUBLIC_BUSINESSES.some((business) => business.id === id));
    setConfig({
      callId: window.location.pathname.split("/").pop() ?? "local",
      ids: ids.length > 0 ? ids : DEFAULT_IDS,
      request:
        params.get("request") ??
        "Price for a CBC and a lipid profile for one adult, with home sample collection if possible.",
    });
  }, []);

  const providers = useMemo(
    () =>
      config.ids
        .map((id) => PUBLIC_BUSINESSES.find((business) => business.id === id))
        .filter((business): business is (typeof PUBLIC_BUSINESSES)[number] => Boolean(business)),
    [config.ids]
  );
  const [callStates, setCallStates] = useState<Record<string, CallState>>({});
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [liveAudioBusinessId, setLiveAudioBusinessId] = useState("healthfirst");
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState<{ businessId: string; turnIndex: number } | null>(null);
  const [autoQueue, setAutoQueue] = useState<{ businessId: string; turnIndex: number }[]>([]);
  const [selectedSource, setSelectedSource] = useState<{
    businessId: string;
    providerName: string;
    source: SourceQuote;
  } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveAudioRef = useRef(liveAudioBusinessId);
  const mutedRef = useRef(muted);

  useEffect(() => {
    liveAudioRef.current = liveAudioBusinessId;
  }, [liveAudioBusinessId]);
  useEffect(() => {
    mutedRef.current = muted;
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  const playTurn = useCallback((businessId: string, turnIndex: number) => {
    audioRef.current?.pause();
    const audio = new Audio(
      `/api/audio/${encodeURIComponent(config.callId)}/${encodeURIComponent(businessId)}/${turnIndex}`
    );
    audioRef.current = audio;
    audio.muted = mutedRef.current;
    setPlaying({ businessId, turnIndex });
    audio.onended = () => setPlaying(null);
    audio.onerror = () => setPlaying(null);
    void audio.play().catch(() => setPlaying(null));
  }, [config.callId]);

  useEffect(() => {
    if (playing || autoQueue.length === 0) return;
    const [next, ...rest] = autoQueue;
    setAutoQueue(rest);
    playTurn(next.businessId, next.turnIndex);
  }, [autoQueue, playing, playTurn]);

  useEffect(() => {
    if (config.callId === "local") return;
    const controller = new AbortController();
    const decoder = new TextDecoder();
    let buffered = "";

    async function start() {
      try {
        const response = await fetch("/api/orchestrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            businessIds: config.ids,
            request: config.request,
            callId: config.callId,
            liveAudioBusinessId: liveAudioRef.current,
          }),
        });
        if (!response.ok || !response.body) throw new Error("Unable to start calls.");

        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          const messages = buffered.split("\n\n");
          buffered = messages.pop() ?? "";

          for (const message of messages) {
            const data = message
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6);
            if (!data) continue;
            const event = JSON.parse(data) as StreamEvent;

            if (event.type === "queued") {
              setCallStates((current) => ({
                ...current,
                [event.businessId]: { status: "queued", transcript: [] },
              }));
            } else if (event.type === "calling") {
              setCallStates((current) => ({
                ...current,
                [event.businessId]: {
                  ...current[event.businessId],
                  status: "calling",
                  transcript: current[event.businessId]?.transcript ?? [],
                },
              }));
            } else if (event.type === "turn") {
              setCallStates((current) => ({
                ...current,
                [event.businessId]: {
                  status: "calling",
                  transcript: [...(current[event.businessId]?.transcript ?? []), event.turn],
                },
              }));
              if (
                event.businessId === liveAudioRef.current &&
                event.turn.hasAudio
              ) {
                setAutoQueue((current) => [
                  ...current,
                  { businessId: event.businessId, turnIndex: event.turn.turnIndex },
                ]);
              }
            } else if (event.type === "done") {
              setQuotes((current) => ({ ...current, [event.businessId]: event.quote }));
              setCallStates((current) => ({
                ...current,
                [event.businessId]: {
                  ...current[event.businessId],
                  status: "done",
                  transcript: current[event.businessId]?.transcript ?? [],
                },
              }));
            } else {
              setCallStates((current) => ({
                ...current,
                [event.businessId]: {
                  status: "error",
                  transcript: current[event.businessId]?.transcript ?? [],
                  error: event.message,
                },
              }));
            }
          }
          if (done) break;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCallStates(() =>
          Object.fromEntries(
            config.ids.map((id) => [
              id,
              {
                status: "error" as const,
                transcript: [],
                error: error instanceof Error ? error.message : "Call failed.",
              },
            ])
          )
        );
      }
    }

    start();
    return () => {
      controller.abort();
      audioRef.current?.pause();
    };
  }, [config]);

  const rankedQuotes = rankQuotes(Object.values(quotes));
  const allExpanded = providers.length > 0 && providers.every((provider) => expanded.has(provider.id));
  const sourceTurn = selectedSource
    ? callStates[selectedSource.businessId]?.transcript.find(
        (turn) => turn.turnIndex === selectedSource.source.turnIndex
      )
    : undefined;

  return (
    <main className="min-h-screen bg-[#0b0f14] px-6 py-8 text-zinc-100 sm:px-10">
      <div className="mx-auto max-w-7xl">
        <p className="font-mono text-sm tracking-[0.24em] text-cyan-400">QUOTIENT / LIVE CALL RUN</p>
        <h1 className="mt-3 text-3xl font-semibold sm:text-5xl">Lab comparison</h1>

        <div className="mt-6 flex flex-wrap items-center gap-3 border border-zinc-800 bg-[#10161d] p-4">
          <label className="font-mono text-sm text-cyan-400">
            Listen to this call
            <select
              value={liveAudioBusinessId}
              onChange={(event) => {
                audioRef.current?.pause();
                setPlaying(null);
                setAutoQueue([]);
                setLiveAudioBusinessId(event.target.value);
              }}
              className="ml-3 border border-zinc-700 bg-[#0b0f14] px-3 py-2 text-zinc-100"
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setMuted((value) => !value)}
            className="border border-zinc-700 px-3 py-2 font-mono text-sm text-cyan-300"
          >
            {muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            onClick={() =>
              setExpanded(allExpanded ? new Set() : new Set(providers.map((provider) => provider.id)))
            }
            className="border border-zinc-700 px-3 py-2 font-mono text-sm text-cyan-300"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>

        <section className="mt-4 grid gap-3 md:grid-cols-3">
          {providers.map((provider) => {
            const state = callStates[provider.id] ?? { status: "queued" as const, transcript: [] };
            const latest = state.transcript.at(-1);
            const isExpanded = expanded.has(provider.id);
            return (
              <article
                key={provider.id}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(provider.id)) {
                      next.delete(provider.id);
                    } else {
                      next.add(provider.id);
                    }
                    return next;
                  })
                }
                className="cursor-pointer border border-zinc-800 bg-[#10161d] p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-lg font-semibold">{provider.name}</h2>
                  <span className="font-mono text-xs uppercase text-cyan-400">{state.status}</span>
                </div>
                <p className="mt-1 font-mono text-xs text-zinc-500">{provider.area}</p>
                {!isExpanded ? (
                  <div className="mt-4 flex min-h-12 gap-2 text-sm leading-5 text-zinc-300">
                    {latest?.hasAudio && (
                      <button
                        type="button"
                        aria-label={`Play latest turn from ${provider.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          playTurn(provider.id, latest.turnIndex);
                        }}
                        className="text-cyan-400"
                      >
                        {playing?.businessId === provider.id &&
                        playing.turnIndex === latest.turnIndex
                          ? "🔊"
                          : "▶"}
                      </button>
                    )}
                    <p>{state.error ?? (latest ? `${latest.speaker}: ${latest.text}` : "Waiting to call…")}</p>
                  </div>
                ) : (
                  <div className="mt-4 space-y-3 border-t border-zinc-800 pt-3">
                    {state.transcript.map((turn) => (
                      <div key={turn.turnIndex} className={turn.speaker === "agent" ? "text-cyan-200" : "text-zinc-200"}>
                        <p className="font-mono text-xs uppercase text-zinc-500">
                          turn {turn.turnIndex} · {turn.speaker === "agent" ? "agent question" : "provider reply"}
                        </p>
                        <div className="mt-1 flex gap-2">
                          {turn.hasAudio && (
                            <button
                              type="button"
                              aria-label={`Play turn ${turn.turnIndex}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                playTurn(provider.id, turn.turnIndex);
                              }}
                              className="text-cyan-400"
                            >
                              {playing?.businessId === provider.id && playing.turnIndex === turn.turnIndex ? "🔊" : "▶"}
                            </button>
                          )}
                          <p className="text-sm leading-5">{turn.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </section>

        <section className="mt-8 overflow-x-auto border border-zinc-800 bg-[#10161d]">
          <table className="w-full min-w-[780px] text-left">
            <thead className="border-b border-zinc-800 font-mono text-xs uppercase tracking-wider text-cyan-400">
              <tr><th className="p-4">Provider</th><th className="p-4">Base price</th><th className="p-4">Extras</th><th className="p-4">All-in price</th><th className="p-4">Turnaround</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rankedQuotes.map((quote) => {
                const failure = ["no_quote", "unreachable"].includes(quote.status) ? quote.failureReason ?? "No quote received." : null;
                const reveal = (source: SourceQuote) => setSelectedSource({ businessId: quote.providerId, providerName: quote.providerName, source });
                const baseSource = sourceFor(quote, ["baseprice", "cost", "price"]);
                const extrasSource = sourceFor(quote, ["extra", "homecollection", "gst"]);
                const turnaroundSource = sourceFor(quote, ["turnaround", "report"]);
                return (
                  <tr key={quote.providerId} className="align-top">
                    <td className="p-4 text-lg font-semibold">{quote.providerName}{failure && <p className="mt-1 text-sm font-normal text-amber-300">{failure}</p>}</td>
                    <td className="p-4">{failure ? "—" : <PriceCell source={baseSource} onReveal={reveal}>{quote.basePrice === null ? "—" : `₹${quote.basePrice}`}</PriceCell>}</td>
                    <td className="p-4">{quote.extras.length === 0 ? "—" : <PriceCell source={extrasSource} onReveal={reveal}>{quote.extras.map((extra) => extra.amount === null ? `${extra.label}: unknown` : `${extra.label}: ₹${extra.amount}`).join(", ")}</PriceCell>}</td>
                    <td className="p-4">{failure ? "—" : quote.allInPrice === null ? <PriceCell source={baseSource ?? extrasSource} onReveal={reveal}><span className="text-amber-300">incomplete — {quote.allInAssumptions.join(" ")}</span></PriceCell> : <PriceCell source={baseSource ?? extrasSource} onReveal={reveal}>₹{quote.allInPrice}</PriceCell>}</td>
                    <td className="p-4"><PriceCell source={turnaroundSource} onReveal={reveal}>{quote.turnaroundHours === null ? "—" : `${quote.turnaroundHours}h`}</PriceCell></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rankedQuotes.length === 0 && <p className="p-6 text-zinc-400">Quotes will appear here as calls finish.</p>}
        </section>

        {selectedSource && (
          <aside className="mt-5 border border-cyan-900 bg-[#10161d] p-4">
            <p className="font-mono text-xs uppercase tracking-wider text-cyan-400">Source / {selectedSource.providerName} / turn {selectedSource.source.turnIndex}</p>
            <div className="mt-2 flex items-start gap-3">
              {sourceTurn?.hasAudio && <button type="button" onClick={() => playTurn(selectedSource.businessId, sourceTurn.turnIndex)} className="text-cyan-400">{playing?.businessId === selectedSource.businessId && playing.turnIndex === sourceTurn.turnIndex ? "🔊" : "▶"}</button>}
              <p className="text-lg">“{selectedSource.source.verbatim}”</p>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
