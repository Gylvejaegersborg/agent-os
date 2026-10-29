# Local voice service (HUD mode, part 6) — phase 1

One local Python process for speech in and, optionally, speech back. It runs on the machine with the mic,
keeps its models loaded, and serves OpenAI-compatible routes on `127.0.0.1:8765` only. Nothing leaves the
machine. Spec: "Local Voice Service — Spec" (17 Oct 2026); handoff: `docs/hud-mode-handoff.md`, part 6.

```
mic 16 kHz ─▶ Silero VAD (32 ms frames) ─▶ segmenter ─▶ NB-Whisper (no) ─▶ WS /v1/listen  {type: final, text, …}
                                                                        POST /v1/audio/transcriptions
text ─▶ Kokoro (en) ─▶ wav/pcm        POST /v1/audio/speech   (only with tts.enabled — off by default)
```

**Phase 1 has:** the service and config, Silero VAD on the live mic, NB-Whisper small (Norwegian; it copes
with English words in Norwegian speech), Kokoro for English speech back, `/health`.
**Measured on this PC (i7-11800H):** NB-Whisper small takes ~2.2 s for a 3.5 s clip on 4 threads (~1.95 s on 8), above the spec's budget; phase 4 (speculative transcription) and NB-Whisper base are the levers. 670 MB RAM with everything loaded. Set to Norwegian, NB-Whisper translates English speech into Norwegian rather than transcribing it, so English needs phase 2's routing.

**Not yet:** language ID and Phonon-2 for English (phase 2), Piper Norwegian speech, sentence routing and
barge-in (phase 3), speculative transcription (phase 4), idle unload and measured RAM (phase 5), the HUD
and gateway hookup, including Ctrl+Alt+B push-to-talk (phase 6).

## Set up (Windows)

```
cd voice
uv venv --python 3.11
.venv\Scripts\activate
uv pip install -r requirements.txt
python fetch_models.py            # Silero VAD + NB-Whisper small (~1 GB download)
python fetch_models.py --tts      # also Kokoro, only if you turn speech back on
copy voice.example.yaml voice.yaml   # optional: pick the mic, tune the VAD, turn speech back on
python run.py
```

Pick the mic: `python -m sounddevice` lists devices; put the name or index in `audio.input_device`.

## Check it (phase 1 acceptance)

- Speak Norwegian: the console prints `[voice] final (no, nb-whisper-small, … ms): …`, and a client on
  `ws://127.0.0.1:8765/v1/listen` gets `speech_start`, `speech_end` and `final` events.
- With `tts.enabled: true`:
  `curl -X POST http://127.0.0.1:8765/v1/audio/speech -H "content-type: application/json" -d "{\"input\":\"Hello from the OS.\"}" -o hello.wav`
  gives playable English audio. With it off, the route answers 409 and says how to turn it on.
- `curl http://127.0.0.1:8765/health`: loaded models, mic device, RAM, last latencies.
- File transcription: `curl -F file=@clip.wav http://127.0.0.1:8765/v1/audio/transcriptions`.

`python test_voice.py` tests the segmenter and config without models or a mic.

## Rules it keeps

- Audio goes from the mic to the transcriber and nowhere else; nothing is stored. Only the text leaves,
  and only to whoever is connected to `/v1/listen` locally.
- Binds 127.0.0.1; `run.py` refuses any other host.
- Speech back is off unless `tts.enabled: true`; with it off, no TTS model is loaded.
- Below-normal process priority; 4 threads for NB-Whisper and Kokoro, 2 for the VAD.
