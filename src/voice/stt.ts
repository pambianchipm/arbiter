export interface SpeechToText {
  readonly name: string;
  transcribe(wav: Buffer): Promise<string>;
}

function wavBlob(wav: Buffer): Blob {
  // Copy into a plain ArrayBuffer: Blob parts must not be backed by a SharedArrayBuffer-typed view.
  const ab = new ArrayBuffer(wav.byteLength);
  new Uint8Array(ab).set(wav);
  return new Blob([ab], { type: "audio/wav" });
}

/** ElevenLabs Scribe. https://elevenlabs.io/docs/api-reference/speech-to-text */
export class ElevenLabsSTT implements SpeechToText {
  readonly name = "elevenlabs-scribe";
  constructor(private readonly apiKey: string) {}
  async transcribe(wav: Buffer): Promise<string> {
    const fd = new FormData();
    fd.append("model_id", "scribe_v1");
    fd.append("file", wavBlob(wav), "utterance.wav");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": this.apiKey }, body: fd });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { text?: string };
    return (j.text ?? "").trim();
  }
}

/** OpenAI Whisper. https://platform.openai.com/docs/api-reference/audio/createTranscription */
export class OpenAISTT implements SpeechToText {
  readonly name = "openai-whisper";
  constructor(private readonly apiKey: string) {}
  async transcribe(wav: Buffer): Promise<string> {
    const fd = new FormData();
    fd.append("model", "whisper-1");
    fd.append("response_format", "json");
    fd.append("file", wavBlob(wav), "utterance.wav");
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: fd });
    if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { text?: string };
    return (j.text ?? "").trim();
  }
}

export function pickSTT(opts: { preference: string; elevenLabsKey?: string; openaiKey?: string }): SpeechToText | undefined {
  const pref = opts.preference.toLowerCase();
  if (pref === "off") return undefined;
  if ((pref === "auto" || pref === "elevenlabs") && opts.elevenLabsKey) return new ElevenLabsSTT(opts.elevenLabsKey);
  if ((pref === "auto" || pref === "openai") && opts.openaiKey) return new OpenAISTT(opts.openaiKey);
  return undefined;
}
