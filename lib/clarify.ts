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
  homeCollection: "Is home sample collection included in the quoted price?",
  reportDelivery: "Is digital report delivery included in the quoted price?",
  consumables:
    "Are registration, handling, and consumable charges included in the quoted price?",
};

function fieldAskedByQuestion(text: string) {
  if (!text.includes("?")) return null;
  if (/\bgst\b/i.test(text)) return "gst" as const;
  if (/home.*collection|collection.*home/i.test(text)) {
    return "homeCollection" as const;
  }
  if (/report|courier/i.test(text)) return "reportDelivery" as const;
  if (/consumable|registration|handling/i.test(text)) {
    return "consumables" as const;
  }
  return null;
}

function isValidInclusionQuestion(
  question: string,
  field: (typeof INCLUSION_ORDER)[number]
) {
  return (
    /included/i.test(question) &&
    !/\b(cost|charge|how much|extra)\b/i.test(question) &&
    fieldAskedByQuestion(question) === field
  );
}

/** Returns one high-value follow-up question, or null when further probing is unnecessary. */
export async function nextClarification(
  transcript: TranscriptTurn[],
  partialQuote: Quote
): Promise<string | null> {
  const businessTurns = transcript.filter(
    (turn) => turn.speaker === "business"
  ).length;
  const unknownInclusion = INCLUSION_ORDER.find(
    (field) =>
      partialQuote.inclusions[field] === null &&
      !transcript.some(
        (turn) =>
          turn.speaker === "agent" && fieldAskedByQuestion(turn.text) === field
      )
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
          content: `You choose one concise diagnostic-lab pricing question. Return JSON only: {"question": string}. The required unresolved field is "${unknownInclusion}". Ask only whether that field is INCLUDED IN THE QUOTED PRICE. Never ask what it costs, whether it is extra, or for price precision. Never ask any other question and never return null. Field order is GST, home collection, report delivery, then consumables.`,
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
    const question = content
      ? ClarificationSchema.parse(JSON.parse(content)).question
      : null;
    return question && isValidInclusionQuestion(question, unknownInclusion)
      ? question
      : FALLBACK_QUESTIONS[unknownInclusion];
  } catch {
    return FALLBACK_QUESTIONS[unknownInclusion];
  }
}
