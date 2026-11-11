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

  async speak(text: string, prefs: VoicePrefs): Promise<void> {
    const clean = text.replace(/[`*_#>]/g, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").trim().slice(0, 2800);
    if (!clean || prefs.tts === "off") return;
    this.stopSpeaking();
    const store = useJarvis.getState();
    if (prefs.tts === "browser" && "speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.rate = prefs.rate;
      // Approximate envelope from word boundaries (browser TTS exposes no audio stream).
      u.onboundary = () => {
        levelRef.current = 0.55 + Math.random() * 0.35;
        setTimeout(() => (levelRef.current *= 0.4), 120);
      };
      store.setSpeaking(true);
      await new Promise<void>((resolve) => {
        u.onend = u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
      levelRef.current = 0;
      store.setSpeaking(false);
      return;
    }
    const res = await api<Response>("/api/voice/speak", {
      method: "POST",
      body: { text: clean, voice: prefs.voice, rate: prefs.rate },
      raw: true,
    });
    const ctx = this.audioCtx();
    await ctx.resume();
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser).connect(ctx.destination);
    this.playback = src;
    store.setSpeaking(true);
    this.meter(analyser);
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.playback === src) this.playback = null;
    cancelAnimationFrame(this.raf);
    levelRef.current = 0;
    store.setSpeaking(false);
  }

  stopSpeaking() {
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
