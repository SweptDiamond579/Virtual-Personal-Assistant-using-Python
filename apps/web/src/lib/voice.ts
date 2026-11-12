"use client";

import { api, post } from "./api";
import { useJarvis } from "./store";

/**
 * Voice engine.
 * - Capture is push-to-talk (or explicit hands-free with silence auto-stop); the
 *   microphone is opened only while capturing and released immediately after.
 * - `levelRef` carries the live amplitude (mic RMS while listening, playback RMS
 *   while speaking) for the AI core. Both come from Web Audio AnalyserNodes.
 * - STT: server (PocketSphinx/Whisper; audio encoded here as 16 kHz WAV) or the
 *   browser's Web Speech API (in Chrome this sends audio to Google — disclosed in Settings).
 * - TTS: server WAV (real playback amplitude) or browser speechSynthesis
 *   (amplitude approximated from word-boundary events — labelled as such).
 */

export type SttEngine = "server" | "browser";
export type TtsEngine = "server" | "browser" | "off";

export interface VoicePrefs {
  stt: SttEngine;
  tts: TtsEngine;
  voice: string;
  rate: number;
  autoStopOnSilence: boolean;
}

export const levelRef: { current: number } = { current: 0 };

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export const browserSttAvailable = () => speechRecognitionCtor() !== null;
export const micAvailable = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const writeStr = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function downsample(input: Float32Array, from: number, to = 16000): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += (buf[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, buf.length));
}

class VoiceEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private raf = 0;
  private recognition: SpeechRecognitionLike | null = null;
  private recognized = "";
  private playback: AudioBufferSourceNode | null = null;
  private onAutoStop: (() => void) | null = null;
  capturing = false;

  private audioCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new AudioContext();
    return this.ctx;
  }

  private meter(analyser: AnalyserNode, onFrame?: (level: number) => void) {
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      const level = Math.min(1, rms(buf) * 4.5);
      levelRef.current = levelRef.current * 0.6 + level * 0.4;
      onFrame?.(level);
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  /** Begin capturing. Resolves once the microphone is live. */
  async startCapture(prefs: VoicePrefs, onAutoStop?: () => void): Promise<void> {
    if (this.capturing) return;
    this.stopSpeaking(); // barge-in: talking interrupts playback
    this.onAutoStop = onAutoStop ?? null;
    const ctx = this.audioCtx();
    await ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.capturing = true;
    useJarvis.getState().setMicActive(true);
    const source = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    let heardSpeech = false;
    let silentSince = 0;
    this.meter(analyser, (level) => {
      if (!prefs.autoStopOnSilence) return;
      const now = performance.now();
      if (level > 0.08) {
        heardSpeech = true;
        silentSince = 0;
      } else if (heardSpeech) {
        silentSince ||= now;
        if (now - silentSince > 1200) this.onAutoStop?.();
      }
    });

    if (prefs.stt === "browser" && browserSttAvailable()) {
      const Ctor = speechRecognitionCtor()!;
      const rec = new Ctor();
      rec.lang = "en-GB";
      rec.interimResults = true;
      rec.continuous = true;
      this.recognized = "";
      rec.onresult = (e) => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) text += e.results[i]?.[0]?.transcript ?? "";
        this.recognized = text;
        window.dispatchEvent(new CustomEvent("jarvis:interim-transcript", { detail: text }));
      };
      rec.onerror = () => undefined;
      rec.start();
      this.recognition = rec;
    } else {
      await ctx.audioWorklet.addModule("/audio/pcm-recorder.js");
      this.chunks = [];
      this.worklet = new AudioWorkletNode(ctx, "pcm-recorder");
      this.worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => this.chunks.push(ev.data);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(this.worklet).connect(sink).connect(ctx.destination);
    }
  }

  /** Stop capturing, release the microphone and return the transcript. */
  async stopCapture(): Promise<{ text: string; engine: string }> {
    if (!this.capturing) return { text: "", engine: "none" };
    this.capturing = false;
    cancelAnimationFrame(this.raf);
    levelRef.current = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    useJarvis.getState().setMicActive(false);

    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      await new Promise<void>((resolve) => {
        rec.onend = () => resolve();
        rec.stop();
        setTimeout(resolve, 1500);
      });
      return { text: this.recognized.trim(), engine: "browser" };
    }
    this.worklet?.disconnect();
    this.worklet = null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      merged.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    if (total < sampleRate * 0.25) return { text: "", engine: "server" };
    const wav = encodeWav(downsample(merged, sampleRate), 16000);
    const form = new FormData();
    form.append("audio", wav, "speech.wav");
    const res = await post<{ text: string; engine: string }>("/api/voice/transcribe", form);
    return { text: res.text, engine: res.engine };
  }

  // ---- speech output ------------------------------------------------------
  // Sentences are queued as they stream in; audio for the next sentence is
  // synthesised while the current one plays. `generation` invalidates the queue
  // on barge-in or a new reply.
  private queue: { text: string; audio: Promise<AudioBuffer | null> | null }[] = [];
  private draining = false;
  private generation = 0;

  private cleanForSpeech(text: string): string {
    return text.replace(/[`*_#>]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").trim().slice(0, 2800);
  }

  private async fetchAudio(text: string, prefs: VoicePrefs): Promise<AudioBuffer | null> {
    try {
      const res = await api<Response>("/api/voice/speak", {
        method: "POST",
        body: { text, voice: prefs.voice, rate: prefs.rate },
        raw: true,
      });
      return await this.audioCtx().decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  private async playBuffer(buffer: AudioBuffer): Promise<void> {
    const ctx = this.audioCtx();
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser).connect(ctx.destination);
    this.playback = src;
    this.meter(analyser);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.playback === src) this.playback = null;
  }

  private speakBrowser(text: string, prefs: VoicePrefs): Promise<void> {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = prefs.rate;
    // Approximate envelope from word boundaries (browser TTS exposes no audio stream).
    u.onboundary = () => {
      levelRef.current = 0.55 + Math.random() * 0.35;
      setTimeout(() => (levelRef.current *= 0.4), 120);
    };
    return new Promise<void>((resolve) => {
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  /** Queue a sentence (or any chunk) for speech; starts playing immediately if idle. */
  enqueueSpeech(text: string, prefs: VoicePrefs): void {
    const clean = this.cleanForSpeech(text);
    if (!clean || prefs.tts === "off") return;
    const serverAudio = !(prefs.tts === "browser" && "speechSynthesis" in window);
    this.queue.push({ text: clean, audio: serverAudio ? this.fetchAudio(clean, prefs) : null });
    if (!this.draining) void this.drain(prefs);
  }

  private async drain(prefs: VoicePrefs): Promise<void> {
    const gen = this.generation;
    this.draining = true;
    const store = useJarvis.getState();
    store.setSpeaking(true);
    try {
      while (this.queue.length && gen === this.generation) {
        const item = this.queue.shift()!;
        if (item.audio) {
          const buffer = await item.audio;
          if (buffer && gen === this.generation) await this.playBuffer(buffer);
        } else {
          await this.speakBrowser(item.text, prefs);
        }
      }
    } finally {
      if (gen === this.generation) {
        this.draining = false;
        cancelAnimationFrame(this.raf);
        levelRef.current = 0;
        store.setSpeaking(false);
      }
    }
  }

  /** Speak a complete text (replaces anything currently queued). */
  async speak(text: string, prefs: VoicePrefs): Promise<void> {
    this.stopSpeaking();
    for (const sentence of splitSentences(text, true).sentences) this.enqueueSpeech(sentence, prefs);
    while (this.draining || this.queue.length) await new Promise((r) => setTimeout(r, 100));
  }

  stopSpeaking() {
    this.generation++;
    this.queue = [];
    this.draining = false;
    if (this.playback) {
      try {
        this.playback.stop();
      } catch {
        /* already stopped */
      }
      this.playback = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
    if (!this.capturing) {
      cancelAnimationFrame(this.raf);
      levelRef.current = 0;
    }
    useJarvis.getState().setSpeaking(false);
  }
}

export const voice = new VoiceEngine();

/**
 * Splits streamed text into speakable sentences. Returns complete sentences and the
 * unfinished remainder. Very short sentences are merged so each clip is worth a request.
 */
export function splitSentences(buffer: string, flush = false, minChars = 24): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  const boundary = /([.!?…]+["')\]]?)(\s+)|\n{2,}/g;
  let last = 0;
  let pending = "";
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(buffer))) {
    const end = m.index + (m[1]?.length ?? 0);
    const piece = buffer.slice(last, end).trim();
    last = m.index + m[0].length;
    if (!piece) continue;
    pending = pending ? `${pending} ${piece}` : piece;
    if (pending.length >= minChars) {
      sentences.push(pending);
      pending = "";
    }
  }
  rest = buffer.slice(last);
  if (pending) rest = `${pending} ${rest}`.trimStart();
  if (flush && rest.trim()) {
    sentences.push(rest.trim());
    rest = "";
  }
  return { sentences, rest };
}
