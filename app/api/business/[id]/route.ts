import { z } from "zod";
import { getBusiness } from "@/lib/businesses";

const HistorySchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

const RequestSchema = z.object({ history: z.array(HistorySchema) });

const ChatResponseSchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string().nullable() }) })
  ).min(1),
});

const SarvamSpeechSchema = z.object({
  audios: z.array(z.string().min(1)).min(1),
});

async function openAiSpeech(text: string, voice: string, apiKey: string) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error("OpenAI speech generation failed.");
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function sarvamSpeech(text: string, apiKey: string) {
  const response = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "api-subscription-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      target_language_code: "en-IN",
      model: "bulbul:v3",
      speaker: "rahul",
      output_audio_codec: "mp3",
    }),
  });
  if (!response.ok) throw new Error("Sarvam speech generation failed.");
  return SarvamSpeechSchema.parse(await response.json()).audios[0];
}

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/business/[id]">
) {
  try {
    const { id } = await params;
    const business = getBusiness(id);

    if (!business) {
      return Response.json({ message: "Business not found." }, { status: 404 });
    }

    const { history } = RequestSchema.parse(await request.json());
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: business.systemPrompt }, ...history],
      }),
    });
    if (!chatResponse.ok) throw new Error("OpenAI chat completion failed.");

    const chat = ChatResponseSchema.parse(await chatResponse.json());
    const text = chat.choices[0].message.content?.trim();
    if (!text) throw new Error("OpenAI returned an empty reply.");

    let audioBase64: string;
    if (business.ttsProvider === "sarvam" && process.env.SARVAM_API_KEY) {
      try {
        audioBase64 = await sarvamSpeech(text, process.env.SARVAM_API_KEY);
      } catch {
        audioBase64 = await openAiSpeech(text, business.voice, apiKey);
      }
    } else {
      audioBase64 = await openAiSpeech(text, business.voice, apiKey);
    }

    return Response.json({ text, audioBase64 });
  } catch (error) {
    console.error("Business simulator failed:", error);
    return Response.json({ message: "Unable to generate the business response." }, { status: 500 });
  }
}
