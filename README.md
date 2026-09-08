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

Add a `museVoice` block to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (one project). **You never need to edit the extension source, so your setup survives `pi update`.** Project settings win over global ones.

```json
{
  "museVoice": {
    "shortcut": "ctrl+shift+v",
    "languageBias": ["English"],
    "keywords": ["Kubernetes", "Postgres", "gRPC"],
    "maxDictationMs": 300000
  }
}
```

| Option | Default | Meaning |
|---|---|---|
| `shortcut` | `ctrl+shift+v` | Dictation toggle. Falls back to the default if unparseable |
| `languageBias` | `[]` | Expected languages, e.g. `["English", "French"]`. Empty = auto-detect |
| `keywords` | `[]` | Vocabulary biasing — **max 20 characters each**, longer ones are dropped |
| `maxDictationMs` | `300000` | Safety stop so a forgotten toggle can't hold the mic open |

Malformed settings are ignored rather than fatal: wrong types fall back to defaults, and an unusable `shortcut` falls back to `ctrl+shift+v` with `/voice` still available.

### Vocabulary biasing is worth setting

It measurably changes results. Dictating *"I am testing Muse Voice Transcribe"* with no keywords produced:

> I am testing **use** voice transcribe

With `keywords: ["Muse"]`:

> I am testing **Muse** voice transcribe

Add your project's jargon — service names, acronyms, libraries. It steers recognition but does not guarantee spelling.

## Privacy

Audio is sent to Meta's API for transcription. Review [Meta's Model API terms](https://ai.developer.meta.com/) before dictating anything sensitive. This extension stores nothing and transmits only to `api.meta.ai`.

## License

MIT
