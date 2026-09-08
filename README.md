# pi-muse-voice

**Voice dictation and audio transcription for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), powered by Meta Muse Voice Transcribe.**

[![npm](https://img.shields.io/npm/v/pi-muse-voice?label=npm)](https://www.npmjs.com/package/pi-muse-voice)
[![Pi extension](https://img.shields.io/badge/Pi-extension-19c7d4)](https://github.com/earendil-works/pi-coding-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-1f8f4d)](package.json)
[![License](https://img.shields.io/badge/license-MIT-f5a623)](LICENSE)

Two things:

- **Dictation** — press a key, talk, and your words stream into Pi's prompt box *while you speak*. Press again to stop.
- **`transcribe_audio` tool** — the agent can transcribe any audio or video file, with speaker labels and timestamps.

Both run on `muse-voice-transcribe-1.0` at **$0.18 per audio hour**.

---

## Requirements

| | |
|---|---|
| **Pi** | `>=0.84` |
| **Node** | `>=22.19` |
| **`sox`** | microphone capture — `brew install sox` |
| **`ffmpeg`** | audio conversion for file transcription — `brew install ffmpeg` |
| **Meta Model API key** | from the [Model API dashboard](https://ai.developer.meta.com/) |

## Install

```bash
pi install npm:pi-muse-voice
```

## Credentials

The extension **reuses the key Pi already has** — the ASR endpoints live on `api.meta.ai`, the same host as the Meta Model API, so no separate credential is needed. Resolution order mirrors Pi's own:

1. `~/.pi/agent/auth.json` under `meta-ai`, then `meta`
2. `MODEL_API_KEY`, then `META_API_KEY` environment variables

If you already use a Meta model in Pi, it works with no setup. Otherwise `/login` and pick a Meta provider, or export `MODEL_API_KEY`.

Nothing is written to disk and no key is ever logged. If no key is found you get an actionable message instead of a stack trace.

## Usage

### Dictation

Press **`ctrl+shift+v`** to start, speak, press again to stop. Text appears in the prompt box as you talk, and existing text in the box is preserved — dictation appends to it.

`/voice` does the same thing, as a fallback if the keybinding is intercepted.

### File transcription

Just ask Pi:

> transcribe /path/to/meeting.m4a

```
[00:00] A: Alright, let us start the standup. The kubelet patch is ready for review.
[00:04] B: Thanks. I will look at the CRI-O side this afternoon.
```

Any format ffmpeg can read is converted automatically. Recordings over 10 minutes are split and stitched, so the server's duration cap is invisible to you.

## Configuration

Edit the `CONFIG` block at the top of `extensions/muse-voice.ts`:

| Option | Default | Meaning |
|---|---|---|
| `shortcut` | `"ctrl+shift+v"` | Dictation toggle |
| `languageBias` | `[]` | Expected languages, e.g. `["English", "French"]`. Empty = auto-detect |
| `keywords` | `[]` | Vocabulary biasing — **max 20 characters each** |
| `maxDictationMs` | `5 * 60_000` | Safety stop so a forgotten toggle can't hold the mic open |

### Vocabulary biasing is worth setting

It measurably changes results. Dictating *"I am testing Muse Voice Transcribe"* with no keywords produced:

> I am testing **use** voice transcribe

With `keywords: ["Muse"]`:

> I am testing **Muse** voice transcribe

Add your project's jargon — service names, acronyms, libraries. It steers recognition but does not guarantee spelling.

## Capabilities and limits

25 languages with code-switching, speaker diarization, model-detected turn boundaries, and long-audio streaming.

**Not available:** word-level timestamps (turn-level only), confidence scores, sound event detection, emotion detection, transcript reformatting.

| Limit | Value |
|---|---|
| File request body | 32 MB |
| File audio duration | 10 min (auto-split by this extension) |
| Realtime session | 60 min |
| Concurrent streams | 8 |
| Streams per hour | 1,000 |

## Troubleshooting

### The keyboard shortcut does nothing

Almost always the OS or terminal eating the key before Pi sees it. Verified on macOS:

| Key | Problem |
|---|---|
| `ctrl+space` | macOS default for *Select the previous input source* |
| `f5` | macOS **Dictation** — pops up Apple's own dictation dialog |
| `f1`–`f6` | Mac media keys (brightness, Mission Control, Spotlight) |

`ctrl+shift+v` is the default because it survives. To confirm whether a key reaches Pi: press it while dictation is running. If the status line changes to `● finishing…`, the key was delivered. If nothing changes at all, it wasn't.

Use `/voice` to work around any keybinding problem.

### `503` from the transcribe endpoint

**A keyword longer than 20 characters returns `503`, deterministically.** This is undocumented, and `503` is misleading — it's a validation error, not a server fault, so retrying never helps.

Found by bisection: 20 characters passes, 21 fails. Meta's own documentation example, `"Muse Voice Transcribe"`, is 21 characters and always fails. This extension filters over-long keywords before sending, so you shouldn't hit it — but it's worth knowing if you call the API directly.

### No audio captured

Check `sox` can reach your microphone, and grant your terminal mic permission in System Settings → Privacy & Security → Microphone:

```bash
sox -d -t raw -b 16 -e signed-integer -r 24000 -c 1 - trim 0 2 | wc -c
# should print 96000 (2 seconds x 48000 bytes/sec)
```

## Implementation notes

A few non-obvious things, in case you're building something similar:

- **`ws`, not Node's built-in `WebSocket`.** Node 22+ negotiates HTTP/2 via ALPN, and `api.meta.ai` advertises `h2`. WebSocket-over-HTTP/2 fails against this endpoint with an immediate `1006`, before `open` fires. `ws` is HTTP/1.1-only and connects fine. Same reason `curl` needs `--http1.1` to get `101 Switching Protocols`.
- **Realtime auth goes in the first frame**, not the HTTP upgrade — `authorization.accessToken`. The `Authorization` header is ignored there. The file endpoint is the opposite: it uses the header.
- **Partials are cumulative**, so each one *replaces* the previous. That maps directly onto `setEditorText`, which is how text updates live in the prompt box. `pasteToEditor` would be wrong: it's bracketed paste and appends at the cursor.
- **`endStream` ends the session, not a turn.** The socket stays open afterwards so the server can flush the final transcript; closing early discards it.
- **The completion signal depends on mode.** `PUSH_TO_TALK` (used for dictation) finishes with a `transcript` event carrying `final: true` — it never emits `speechComplete`. `ENDPOINTING` and `DIARIZATION` use `speechComplete` per `turnId`.
- **The final transcript is post-processed** and differs from the last partial: `"how is the weather today"` becomes `"How is the weather today?"`.

## Privacy

Audio is sent to Meta's API for transcription. Review [Meta's Model API terms](https://ai.developer.meta.com/) before dictating anything sensitive. This extension stores nothing and transmits only to `api.meta.ai`.

## License

MIT
