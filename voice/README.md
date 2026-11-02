# Local voice service (HUD mode, part 6) — phases 1 and 4

One local Python process for speech in and, optionally, speech back. It runs on the machine with the mic,
keeps its models loaded, and serves OpenAI-compatible routes on `127.0.0.1:8765` only. Nothing leaves the
machine. Spec: "Local Voice Service — Spec" (17 Oct 2026); handoff: `docs/hud-mode-handoff.md`, part 6.

```
mic 16 kHz ─▶ Silero VAD (32 ms frames) ─▶ segmenter ─▶ NB-Whisper (no) ─▶ WS /v1/listen  {type: final, text, …}
                                                                        POST /v1/audio/transcriptions
text ─▶ Kokoro (en) ─▶ wav/pcm        POST /v1/audio/speech   (only with tts.enabled — off by default)
```

**Phase 1:** the service and config, Silero VAD on the live mic, NB-Whisper small (Norwegian; it copes
with English words in Norwegian speech), Kokoro for English speech back, `/health`.

**Phase 4 (reactivity):**
- *Short encoder window.* The encoder is ~85% of NB-Whisper's time and always processed a 30 s window,
  however short the clip. Now it encodes only what the clip needs, at least `stt.min_window_s` (10 s):
  transcribing drops from ~1.4 s to ~0.35 s. 6 s windows started changing words, hence the 10 s floor.
  Clips over 29 s use the normal 30 s path.
- *Speculative transcription.* At `vad.speculative_ms` (250 ms) of silence, the utterance so far is queued.
  If the silence reaches 600 ms, that same utterance is final and its text is usually ready; if speech comes
  back, the result is dropped. Final utterances are never dropped from the queue.
- Warm-up at load was already in phase 1. Early language ID and English partials wait for phase 2's models.

**Measured on this PC (i7-11800H), `replay.py`, 4 clips of 1–6 s, end of speech → final, median:**

| | median |
|---|---|
| phase 1 (30 s window, no speculation) | 1,998 ms |
| short window only | 968 ms |
| short window + speculation | 616 ms (600 ms of it is the silence window) |

The spec's target is ≤ 700 ms English / ≤ 900 ms Norwegian. The clips were synthetic English (Kokoro),
which NB-Whisper set to Norwegian *translates*; accuracy on real Norwegian speech is checked live, not by
these numbers. Phase 1's mic test (operator, Norwegian): ~2.7 s, text right in 5 of 6 utterances.

**Not yet:** language ID and Phonon-2 for English (phase 2), Piper Norwegian speech, sentence routing and
barge-in (phase 3), idle unload and measured RAM (phase 5), the HUD and gateway hookup, including
Ctrl+Alt+B push-to-talk (phase 6).

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

`python test_voice.py` tests the segmenter, speculation events and config without models or a mic.
`python replay.py a.wav b.wav …` plays clips through the real pipeline at real-time pace and prints the
end of speech → final latency (`--no-speculation`, `--window 0` to compare).

## Rules it keeps

- Audio goes from the mic to the transcriber and nowhere else; nothing is stored. Only the text leaves,
  and only to whoever is connected to `/v1/listen` locally.
- Binds 127.0.0.1; `run.py` refuses any other host.
- Speech back is off unless `tts.enabled: true`; with it off, no TTS model is loaded.
- Below-normal process priority; 4 threads for NB-Whisper and Kokoro, 2 for the VAD.
