/**
 * Discord hands us 48 kHz stereo signed-16-bit PCM per speaker. Speech-to-text APIs want
 * something small and mono; 16 kHz mono WAV is 6× smaller and plenty for speech.
 */
export function pcm48kStereoToWav16kMono(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4); // 2 channels × 2 bytes
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.alloc(44 + outFrames * 2);
  writeWavHeader(out, outFrames * 2, 16_000, 1);
  let o = 44;
  for (let i = 0; i < outFrames; i++) {
    // Average three stereo frames into one mono sample: a cheap low-pass plus decimation.
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const idx = (i * 3 + k) * 4;
      acc += pcm.readInt16LE(idx) + pcm.readInt16LE(idx + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 6))), o);
    o += 2;
  }
  return out;
}

function writeWavHeader(buf: Buffer, dataBytes: number, sampleRate: number, channels: number): void {
  const byteRate = sampleRate * channels * 2;
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
}

export function durationSeconds48kStereo(pcm: Buffer): number {
  return pcm.length / (48_000 * 4);
}

const HALLUCINATIONS = new Set([
  "you", "bye", "okay", "ok", "um", "uh", "hmm", "mm", "thank you", "thanks", "thank you for watching", "thanks for watching", "subscribe", "like and subscribe", "so", "yeah",
]);

/** Whisper-style models produce these on silence and breath noise. */
export function looksLikeHallucination(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,…]/g, "").replace(/\s+/g, " ");
  if (t.length < 2) return true;
  return HALLUCINATIONS.has(t);
}
