import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** ElevenLabs streaming TTS → MP3 stream (ffmpeg-static decodes it for Discord). */
export class ElevenLabsTTS {
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly modelId = "eleven_flash_v2_5",
  ) {}

  async stream(text: string): Promise<Readable> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=mp3_44100_64`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.modelId }),
    });
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }
}
