"""Speech-to-text and text-to-speech.

Engines
- STT `pocketsphinx`: fully offline (bundled en-US model). Lower accuracy; no audio leaves the server.
- STT `openai_compatible`: Whisper-compatible `/audio/transcriptions` endpoint (higher accuracy).
- TTS `espeak`: offline eSpeak NG; returns WAV so the browser can analyse real playback amplitude.
- TTS `openai_compatible`: `/audio/speech` endpoint.
The browser's own Web Speech APIs are a client-side alternative configured in Settings.

Audio is processed in memory per request and never written to disk or retained.
"""

from __future__ import annotations

import asyncio
import io
import shutil
import wave
from dataclasses import dataclass

from jarvis.config import get_settings

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_TTS_CHARS = 3000


class VoiceError(Exception):
    pass


@dataclass
class Transcript:
    text: str
    engine: str
    duration_s: float


async def _to_pcm16k(audio: bytes) -> bytes:
    """Convert any input (wav/webm/ogg) to raw 16 kHz mono s16le PCM via ffmpeg (no shell)."""
    try:
        with wave.open(io.BytesIO(audio)) as w:
            if w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2:
                return w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        pass
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VoiceError("Audio must be 16 kHz mono 16-bit WAV (ffmpeg is not installed for conversion).")
    proc = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(proc.communicate(audio), timeout=30)
    if proc.returncode != 0:
        raise VoiceError(f"Could not decode audio: {err.decode(errors='replace')[:200]}")
    return out


def _sphinx_decode(pcm: bytes) -> str:
    from pocketsphinx import Decoder

    decoder = Decoder(loglevel="FATAL")
    decoder.start_utt()
    decoder.process_raw(pcm, full_utt=True)
    decoder.end_utt()
    hyp = decoder.hyp()
    return hyp.hypstr if hyp else ""


async def transcribe(audio: bytes, *, filename: str = "audio.wav") -> Transcript:
    if len(audio) > MAX_AUDIO_BYTES:
        raise VoiceError("Audio too long (max 10 MB).")
    s = get_settings()
    if s.jarvis_stt_engine == "openai_compatible":
        if not s.openai_compat_base_url:
            raise VoiceError("OpenAI-compatible STT selected but OPENAI_COMPAT_BASE_URL is not set.")
        import openai

        client = openai.AsyncOpenAI(
            base_url=s.openai_compat_base_url,
            api_key=s.openai_compat_api_key.get_secret_value() if s.openai_compat_api_key else "not-needed",
        )
        res = await client.audio.transcriptions.create(model=s.openai_compat_stt_model, file=(filename, audio))
        return Transcript(text=res.text.strip(), engine="openai_compatible", duration_s=0.0)
    if s.jarvis_stt_engine == "pocketsphinx":
        pcm = await _to_pcm16k(audio)
        if len(pcm) < 3200:
            raise VoiceError("Audio is too short.")
        text = await asyncio.to_thread(_sphinx_decode, pcm)
        return Transcript(text=text.strip(), engine="pocketsphinx", duration_s=len(pcm) / 32000)
    raise VoiceError("Server speech-to-text is disabled.")


async def synthesize(text: str, *, voice: str = "en-gb", rate: float = 1.0) -> tuple[bytes, str]:
    text = text.strip()
    if not text:
        raise VoiceError("Nothing to say.")
    text = text[:MAX_TTS_CHARS]
    s = get_settings()
    if s.jarvis_tts_engine == "openai_compatible":
        if not s.openai_compat_base_url:
            raise VoiceError("OpenAI-compatible TTS selected but OPENAI_COMPAT_BASE_URL is not set.")
        import openai

        client = openai.AsyncOpenAI(
            base_url=s.openai_compat_base_url,
            api_key=s.openai_compat_api_key.get_secret_value() if s.openai_compat_api_key else "not-needed",
        )
        res = await client.audio.speech.create(
            model=s.openai_compat_tts_model, voice=s.openai_compat_tts_voice, input=text, response_format="wav"
        )
        return res.content, "audio/wav"
    if s.jarvis_tts_engine == "espeak":
        exe = shutil.which("espeak-ng") or shutil.which("espeak")
        if not exe:
            raise VoiceError("espeak-ng is not installed on the server.")
        if not voice.replace("-", "").replace("+", "").isalnum() or len(voice) > 20:
            voice = "en-gb"
        speed = str(int(max(80, min(320, 165 * rate))))
        # Text goes through stdin, never through argv, so it cannot be parsed as options.
        proc = await asyncio.create_subprocess_exec(
            exe,
            "-v",
            voice,
            "-s",
            speed,
            "--stdout",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(text.encode()), timeout=30)
        if proc.returncode != 0 or not out:
            raise VoiceError(f"TTS failed: {err.decode(errors='replace')[:200]}")
        return out, "audio/wav"
    raise VoiceError("Server text-to-speech is disabled.")
