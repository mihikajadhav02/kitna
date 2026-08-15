import { z } from "zod";
import { PUBLIC_BUSINESSES } from "@/lib/businesses";
import { Quote as QuoteSchema, type Quote } from "@/lib/quote-schema";
import type { TranscriptTurn } from "@/lib/clarify";

const RequestSchema = z.object({
  businessIds: z.array(z.string().min(1)).min(1).max(5),
  request: z.string().min(1),
  callId: z.string().min(1).optional(),
  liveAudioBusinessId: z.string().min(1).optional(),
});

type StatusEvent =
  | { type: "queued"; businessId: string; providerName: string }
  | { type: "calling"; businessId: string }
  | { type: "turn"; businessId: string; turn: TranscriptTurn }
  | { type: "done"; businessId: string; quote: Quote }
  | { type: "error"; businessId: string; message: string };

const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), turn: z.object({
    speaker: z.enum(["agent", "business"]),
    text: z.string(),
    turnIndex: z.number().int().min(0),
    hasAudio: z.boolean(),
  }) }),
  z.object({
    type: z.literal("done"),
    quote: QuoteSchema,
    transcript: z.array(z.unknown()),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const encoder = new TextEncoder();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toSse(event: StatusEvent) {
  return encoder.encode(`event: status\ndata: ${JSON.stringify(event)}\n\n`);
}

async function forwardAgentEvents(
  response: Response,
  businessId: string,
  emit: (event: StatusEvent) => void
) {
  if (!response.ok || !response.body) {
    throw new Error(`Agent call failed with status ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";

    for (const event of events) {
      const line = event.split("\n").find((part) => part.startsWith("data: "));
      if (!line) continue;
      const agentEvent = AgentEventSchema.parse(JSON.parse(line.slice(6)));
      if (agentEvent.type === "turn") {
        emit({ type: "turn", businessId, turn: agentEvent.turn });
      } else if (agentEvent.type === "done") {
        emit({ type: "done", businessId, quote: agentEvent.quote });
      } else {
        emit({ type: "error", businessId, message: agentEvent.message });
      }
    }

    if (done) break;
  }
}

export async function POST(request: Request) {
  try {
    const {
      businessIds,
      request: customerRequest,
      callId = crypto.randomUUID(),
      liveAudioBusinessId,
    } = RequestSchema.parse(await request.json());
    const selected = [...new Set(businessIds)]
      .map((id) => PUBLIC_BUSINESSES.find((business) => business.id === id))
      .filter((business): business is (typeof PUBLIC_BUSINESSES)[number] => Boolean(business));

    if (selected.length === 0) {
      return Response.json({ message: "No valid providers selected." }, { status: 400 });
    }

    const origin = new URL(request.url).origin;
    const stream = new ReadableStream({
      start(controller) {
        const emit = (event: StatusEvent) => controller.enqueue(toSse(event));
        selected.forEach((business) =>
          emit({
            type: "queued",
            businessId: business.id,
            providerName: business.name,
          })
        );

        let nextIndex = 0;
        let nextStartAt = Date.now();

        const worker = async () => {
          while (true) {
            const index = nextIndex++;
            const business = selected[index];
            if (!business) return;

            const startAt = nextStartAt;
            nextStartAt += 1_500;
            await delay(Math.max(0, startAt - Date.now()));
            emit({ type: "calling", businessId: business.id });

            try {
              const agentResponse = await fetch(`${origin}/api/agent/call`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  businessId: business.id,
                  providerName: business.name,
                  request: customerRequest,
                  stream: true,
                  callId,
                  liveAudioBusinessId,
                }),
              });
              await forwardAgentEvents(agentResponse, business.id, emit);
            } catch (error) {
              emit({
                type: "error",
                businessId: business.id,
                message: error instanceof Error ? error.message : "Call failed.",
              });
            }
          }
        };

        Promise.all(
          Array.from({ length: Math.min(3, selected.length) }, () => worker())
        )
          .catch(() => undefined)
          .finally(() => controller.close());
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Orchestration failed:", error);
    return Response.json(
      { message: "Unable to start the calls." },
      { status: 500 }
    );
  }
}
