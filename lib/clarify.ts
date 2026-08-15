import { z } from "zod";
import type { Quote } from "@/lib/quote-schema";

export type TranscriptTurn = {
  speaker: "agent" | "business";
  text: string;
  turnIndex: number;
  hasAudio: boolean;
};

const ClarificationSchema = z.object({
  question: z.string().min(1).nullable(),
});

const INCLUSION_ORDER = [
  "gst",
  "homeCollection",
  "reportDelivery",
  "consumables",
] as const;

const FALLBACK_QUESTIONS: Record<(typeof INCLUSION_ORDER)[number], string> = {
  gst: "Is GST included in the quoted price?",
  homeCollection:
    "Is home sample collection included? If not, what is the charge?",
  reportDelivery: "Is the digital report included in the quoted price?",
  consumables:
    "Are any registration, handling, or consumable charges extra?",
};

/** Returns one high-value follow-up question, or null when further probing is unnecessary. */
export async function nextClarification(
  transcript: TranscriptTurn[],
  partialQuote: Quote
): Promise<string | null> {
  const businessTurns = transcript.filter(
    (turn) => turn.speaker === "business"
  ).length;
  const unknownInclusion = INCLUSION_ORDER.find(
    (field) => partialQuote.inclusions[field] === null
  );

  if (!unknownInclusion || businessTurns >= 6) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return FALLBACK_QUESTIONS[unknownInclusion];

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
          content: `You choose one concise diagnostic-lab pricing question. Return JSON only: {"question": string}. The required unresolved field is "${unknownInclusion}". Ask only about that field; never ask any other question and never return null. Field order is GST, home collection, report delivery, then consumables. Do not seek price precision while any inclusion is unresolved.`,
        },
        {
          role: "user",
          content: JSON.stringify({ transcript, partialQuote }),
        },
      ],
    }),
  });

  if (!response.ok) return FALLBACK_QUESTIONS[unknownInclusion];

  try {
    const payload = z
      .object({
        choices: z.array(
          z.object({ message: z.object({ content: z.string().nullable() }) })
        ).min(1),
      })
      .parse(await response.json());
    const content = payload.choices[0].message.content;
    return (
      (content
        ? ClarificationSchema.parse(JSON.parse(content)).question
        : null) ?? FALLBACK_QUESTIONS[unknownInclusion]
    );
  } catch {
    return FALLBACK_QUESTIONS[unknownInclusion];
  }
}
