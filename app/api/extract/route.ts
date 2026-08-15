import { z } from "zod";
import { computeAllIn, emptyQuote, Quote } from "@/lib/quote-schema";

const TranscriptTurnSchema = z.object({
  speaker: z.enum(["agent", "business"]),
  text: z.string(),
  turnIndex: z.number().int().min(0),
});

const RequestSchema = z.object({
  transcript: z.array(TranscriptTurnSchema),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
});

const ChatResponseSchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string().nullable() }) })
  ).min(1),
});

const ExtractedFieldsSchema = Quote.pick({
  status: true,
  basePrice: true,
  unit: true,
  inclusions: true,
  extras: true,
  conditions: true,
  turnaroundHours: true,
  availability: true,
  confidence: true,
  sourceQuotes: true,
  unansweredQuestions: true,
});

export async function POST(request: Request) {
  let providerId = "unknown";
  let providerName = "Unknown provider";

  try {
    const body = RequestSchema.parse(await request.json());
    providerId = body.providerId;
    providerName = body.providerName;
    const { transcript } = body;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract only facts explicitly stated or left unanswered in this diagnostic-lab transcript. Return one JSON object and no other text. Never invent a number, inclusion, or condition. Only set basePrice when the business explicitly gave one firm price; otherwise use null and status "no_quote" or "unreachable".

Return exactly these fields and types:
- status: "quoted" | "partial" | "no_quote" | "unreachable"
- basePrice: number | null
- unit: "total" | "per_test" | "per_visit" | "per_item" | null
- inclusions: { homeCollection: boolean | null, gst: boolean | null, reportDelivery: boolean | null, consumables: boolean | null }
- extras: Array<{ label: string, amount: number | null }>
- conditions: string[]
- turnaroundHours: number | null
- availability: string | null
- confidence: number from 0 through 1
- sourceQuotes: Array<{ field: string, verbatim: string, turnIndex: integer }>
- unansweredQuestions: string[]

Record GST only in inclusions.gst. Do not add GST to extras: the server computes stated GST from inclusions.gst. Every sourceQuotes.verbatim must be copied exactly from a business transcript line, and turnIndex must be that line's original index. Do not return providerId, providerName, currency, allInPrice, allInAssumptions, or failureReason; the server supplies those.`,
          },
          {
            role: "user",
            content: JSON.stringify({ transcript }),
          },
        ],
      }),
    });

    if (!response.ok) throw new Error("Quote extraction request failed.");

    const completion = ChatResponseSchema.parse(await response.json());
    const content = completion.choices[0].message.content;
    if (!content) throw new Error("Quote extraction returned no result.");
    console.info("[extract] raw model output:", content);

    let extracted: z.infer<typeof ExtractedFieldsSchema>;
    try {
      extracted = ExtractedFieldsSchema.parse(JSON.parse(content));
    } catch (error) {
      console.error("[extract] zod error:", error);
      throw error;
    }

    const explicitGstExtra = transcript.some(
      (turn) =>
        turn.speaker === "business" &&
        /\bgst\b.*\b(extra|18\s*%)/i.test(turn.text)
    );
    const normalized = {
      ...extracted,
      inclusions: {
        ...extracted.inclusions,
        gst: explicitGstExtra ? false : extracted.inclusions.gst,
      },
      extras: extracted.extras.filter((extra) => !/\bgst\b/i.test(extra.label)),
    };
    const quote = Quote.parse({
      ...normalized,
      providerId,
      providerName,
      currency: "INR",
      allInPrice: null,
      allInAssumptions: [],
      failureReason:
        extracted.basePrice === null &&
        (extracted.status === "no_quote" || extracted.status === "unreachable")
          ? "Provider did not give a firm price."
          : null,
    });
    const { allInPrice, assumptions } = computeAllIn(quote);
    console.info("[extract] GST / all-in assumptions:", {
      gst: quote.inclusions.gst,
      allInAssumptions: assumptions,
    });
    return Response.json(
      Quote.parse({
        ...quote,
        allInPrice,
        allInAssumptions: assumptions,
      })
    );
  } catch (error) {
    console.error("[extract] fallback:", error);
    return Response.json(
      emptyQuote(providerId, providerName, "Quote extraction failed.")
    );
  }
}
