type StoredAudio = {
  bytes: Buffer;
  contentType: string;
};

const turnAudio = new Map<string, StoredAudio>();

export function audioKey(callId: string, businessId: string, turnIndex: number) {
  return `${callId}:${businessId}:${turnIndex}`;
}

export function storeTurnAudio(
  callId: string,
  businessId: string,
  turnIndex: number,
  bytes: Buffer,
  contentType = "audio/mpeg"
) {
  turnAudio.set(audioKey(callId, businessId, turnIndex), { bytes, contentType });
}

export function getTurnAudio(
  callId: string,
  businessId: string,
  turnIndex: number
) {
  return turnAudio.get(audioKey(callId, businessId, turnIndex));
}
