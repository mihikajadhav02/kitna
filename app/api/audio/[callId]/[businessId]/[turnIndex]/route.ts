import { getTurnAudio } from "@/lib/call-store";

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/audio/[callId]/[businessId]/[turnIndex]">
) {
  const { callId, businessId, turnIndex } = await params;
  const audio = getTurnAudio(callId, businessId, Number(turnIndex));

  if (!audio) {
    return Response.json({ message: "Audio not found." }, { status: 404 });
  }

  return new Response(new Uint8Array(audio.bytes), {
    headers: {
      "Content-Type": audio.contentType,
      "Cache-Control": "no-store",
    },
  });
}
