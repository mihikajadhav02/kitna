import { z } from "zod";
import { nextClarification, type TranscriptTurn } from "@/lib/clarify";
import { emptyQuote, Quote, type Quote as QuoteType } from "@/lib/quote-schema";
import { storeTurnAudio } from "@/lib/call-store";

const RequestSchema = z.object({
  businessId: z.string().min(1),
  providerName: z.string().min(1).optional(),
  request: z.string().min(1),
  stream: z.boolean().optional(),
  callId: z.string().min(1).optional(),
  liveAudioBusinessId: z.string().min(1).optional(),
});

const BusinessResponseSchema = z.object({ audioBase64: z.string().min(1) });
const TranscriptionSchema = z.object({ text: z.string().min(1) });

type CallInput = z.infer<typeof RequestSchema>;
type CallResult = { quote: QuoteType; transcript: TranscriptTurn[] };
type TurnListener = (turn: TranscriptTurn) => void;

function testsOnly(request: string) {
  const tests: string[] = [];
  if (/\bcbc\b/i.test(request)) tests.push("a CBC");
  if (/lipid/i.test(request)) tests.push("a lipid profile");
  return tests.length > 0 ? tests.join(" and ") : "the requested diagnostic tests";
}

function cannotHelp(text: string) {
  return /call back|closed|only security|don'?t know.*price|cannot.*quote/i.test(text);
}

function addTurn(
  transcript: TranscriptTurn[],
  speaker: TranscriptTurn["speaker"],
  text: string,
  hasAudio: boolean,
  onTurn?: TurnListener
) {
  const turn = { speaker, text, hasAudio, turnIndex: transcript.length };
  transcript.push(turn);
  onTurn?.(turn);
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function transcribe(audioBase64: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const audio = new Blob([Buffer.from(audioBase64, "base64")], {
    type: "audio/mpeg",
  });
  const formData = new FormData();
  formData.append("model", "gpt-4o-mini-transcribe");
  formData.append("file", audio, "business-reply.mp3");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!response.ok) throw new Error("Transcription failed.");
  return TranscriptionSchema.parse(await response.json()).text;
}

async function synthesizeAgentLine(text: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: text,
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error("Agent speech generation failed.");
  return Buffer.from(await response.arrayBuffer());
}

async function runCall(
  {
    businessId,
    providerName = businessId,
    request: customerRequest,
    callId = crypto.randomUUID(),
    liveAudioBusinessId,
  }: CallInput,
  onTurn?: TurnListener,
  origin?: string
): Promise<CallResult> {
  if (!origin) throw new Error("Call origin is unavailable.");
  const transcript: TranscriptTurn[] = [];
  let nextMessage = `Hello, I'm an automated assistant calling on behalf of a customer. They need ${testsOnly(customerRequest)}.`;
  let quote = emptyQuote(
    businessId,
    providerName,
    "Call ended before a quote was extracted."
  );
  let modelCalls = 0;

  // At most five complete exchanges fit the 25-call model budget. Five is
  // sufficient for the opening plus the four required inclusion questions.
  while (transcript.filter((turn) => turn.speaker === "business").length < 6) {
    if (modelCalls + 5 > 25) break;

    const agentTurnIndex = transcript.length;
    const agentAudio =
      businessId === liveAudioBusinessId
        ? await synthesizeAgentLine(nextMessage)
        : undefined;
    if (agentAudio) {
      storeTurnAudio(callId, businessId, agentTurnIndex, agentAudio);
    }
    addTurn(transcript, "agent", nextMessage, Boolean(agentAudio), onTurn);
    const business = BusinessResponseSchema.parse(
      await postJson(
        `${origin}/api/business/${encodeURIComponent(businessId)}`,
        {
          history: transcript.map((turn) => ({
            role: turn.speaker === "agent" ? "user" : "assistant",
            content: turn.text,
          })),
        }
      )
    );
    modelCalls += 2;

    // Deliberately ignore business.text: agent knowledge comes only from
    // synthesized audio that is transcribed below.
    const businessAudio = Buffer.from(business.audioBase64, "base64");
    const businessText = await transcribe(business.audioBase64);
    modelCalls += 1;
    const businessTurnIndex = transcript.length;
    storeTurnAudio(callId, businessId, businessTurnIndex, businessAudio);
    addTurn(transcript, "business", businessText, true, onTurn);

    quote = Quote.parse(
      await postJson(`${origin}/api/extract`, {
        transcript,
        providerId: businessId,
        providerName,
      })
    );
    modelCalls += 1;

    if (cannotHelp(businessText)) break;

    const question = await nextClarification(transcript, quote);
    modelCalls += 1;
    if (!question) break;
    nextMessage = question;
  }

  return { quote, transcript };
}

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  try {
    const input = RequestSchema.parse(await request.json());

    if (!input.stream) {
      return Response.json(await runCall(input, undefined, new URL(request.url).origin));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await runCall(
            input,
            (turn) => controller.enqueue(encoder.encode(sse({ type: "turn", turn }))),
            new URL(request.url).origin
          );
          controller.enqueue(encoder.encode(sse({ type: "done", ...result })));
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              sse({
                type: "error",
                message: error instanceof Error ? error.message : "Call failed.",
              })
            )
          );
        } finally {
          controller.close();
        }
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
    console.error("Agent call failed:", error);
    return Response.json({ message: "Unable to complete the call." }, { status: 500 });
  }
}
