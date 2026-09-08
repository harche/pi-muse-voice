/**
 * Muse Voice Transcribe for Pi
 *
 * Dictation (mic -> prompt editor) via wss://api.meta.ai/v1/asr/realtime,
 * plus a `transcribe_audio` tool for the agent via POST /v1/asr/transcribe.
 *
 * Requires: `sox` (mic capture), `ffmpeg` (file convert), and a Meta Model API key.
 *
 * The key is reused from Pi's own credentials — the ASR endpoints live on
 * api.meta.ai, the same host as the Meta Model API, so the provider key you
 * already use for muse-spark works here unchanged. Resolution order mirrors
 * Pi's: auth.json first, then environment.
 *
 * Shortcut: ctrl+shift+v toggles dictation.  Command: /voice
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// NOT the global WebSocket: Node 26's built-in negotiates HTTP/2 via ALPN
// (api.meta.ai advertises h2) and WebSocket-over-HTTP/2 fails here with an
// immediate 1006. `ws` is HTTP/1.1-only, which the endpoint accepts. Verified:
// global WebSocket -> closed 1006 in ~50ms; ws -> handshake ack in ~500ms.
import WebSocket from "ws";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PROTOCOL  — everything below traces to dev.meta.ai/docs/speech-to-text.
// If Meta changes the wire format, this block is the only thing to edit.
// ---------------------------------------------------------------------------
const PROTOCOL = {
	realtimeUrl: "wss://api.meta.ai/v1/asr/realtime",
	transcribeUrl: "https://api.meta.ai/v1/asr/transcribe",
	model: "muse-voice-transcribe-1.0",

	// Engine-native rate. 24kHz mono s16le = 48000 bytes/sec.
	audioEncoding: "PCM_24KHZ",
	sampleRate: 24000,
	bytesPerSecond: 48000,

	// Handshake must arrive within 10s of connect; ack has NO `type` field.
	handshakeTimeoutMs: 10_000,

	// Server-side caps on the file endpoint.
	maxBodyBytes: 32 * 1024 * 1024,
	maxAudioSeconds: 600,

	// UNDOCUMENTED, found by bisection: a keyword longer than 20 characters makes
	// the server return 503 (not 400) deterministically. 20 passes, 21 fails.
	// The docs' own example keyword "Muse Voice Transcribe" is 21 chars and always
	// fails. Because it surfaces as 5xx, blind "retry once on server error" logic
	// would loop forever and burn quota, so we reject these before sending.
	maxKeywordChars: 20,
} as const;

/** Drop keywords that would trip the undocumented 20-char server limit. */
function sanitizeKeywords(keywords: readonly string[]): { ok: string[]; dropped: string[] } {
	const ok: string[] = [];
	const dropped: string[] = [];
	for (const k of keywords) {
		(k.length <= PROTOCOL.maxKeywordChars ? ok : dropped).push(k);
	}
	return { ok, dropped };
}

/** Shared handshake/request settings. The realtime handshake and the file
 *  endpoint's `request` part take the same fields, minus authorization. */
function biasFields(): Record<string, unknown> {
	const { ok } = sanitizeKeywords(CONFIG.keywords);
	return {
		...(CONFIG.languageBias.length ? { languageBias: CONFIG.languageBias } : {}),
		...(ok.length ? { keywords: ok } : {}),
	};
}

// ---------------------------------------------------------------------------
// CONFIG — tune these.
// ---------------------------------------------------------------------------
const CONFIG = {
	// ctrl+shift+v: the one binding empirically confirmed to reach pi on this
	// machine. f5 is swallowed by macOS Dictation, and ctrl+space is the macOS
	// default for "Select the previous input source".
	shortcut: "ctrl+shift+v",
	// Language hints, e.g. ["English", "French"]. Empty = auto-detect.
	languageBias: [] as string[],
	// Vocabulary biasing: product names, people, places, acronyms, and jargon the
	// model would otherwise mishear. Empty by default — add your own terms.
	// Each entry must be <= 20 characters; see sanitizeKeywords().
	// Example: ["Kubernetes", "Postgres", "OAuth", "gRPC"]
	keywords: [] as string[],
	// Safety stop so a forgotten toggle can't bill an open mic.
	// Realtime sessions are capped at 60 min server-side regardless.
	maxDictationMs: 5 * 60_000,
	// Chunk size for pacing. 80ms at 24kHz = 3840 bytes.
	chunkBytes: 3840,
} as const;

// Providers to borrow the credential from, in order. Both point at
// https://api.meta.ai/v1 in models.json and carry the same Model API key.
const AUTH_PROVIDERS = ["meta-ai", "meta"] as const;
const ENV_VARS = ["MODEL_API_KEY", "META_API_KEY"] as const;

function configDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

let cachedKey: string | null = null;

/** Resolve the Meta Model API key the same way Pi resolves provider credentials:
 *  auth.json takes priority over environment variables. */
/** Thrown when no Meta Model API key can be resolved at all. */
class MissingKeyError extends Error {
	constructor() {
		super(
			"Muse Voice: no Meta Model API key found.\n" +
			`Add one under "${AUTH_PROVIDERS[0]}" in ${join(configDir(), "auth.json")} ` +
			`(/login with a Meta provider does this for you), or set ${ENV_VARS[0]}.`,
		);
		this.name = "MissingKeyError";
	}
}

function apiKey(): string {
	if (cachedKey) return cachedKey;

	try {
		const auth = JSON.parse(readFileSync(join(configDir(), "auth.json"), "utf8"));
		for (const provider of AUTH_PROVIDERS) {
			const cred = auth?.[provider];
			if (cred?.type !== "api_key") continue;
			// A credential's key may be a "$VAR" reference, and may carry
			// provider-scoped env values that win over the process environment.
			const raw = String(cred.key ?? "");
			const resolved = raw.startsWith("$")
				? (cred.env?.[raw.slice(1)] ?? process.env[raw.slice(1)] ?? "")
				: raw;
			if (resolved) return (cachedKey = resolved);
		}
	} catch {
		// No auth.json, or unreadable — fall through to the environment.
	}

	for (const name of ENV_VARS) {
		if (process.env[name]) return (cachedKey = process.env[name]!);
	}

	throw new MissingKeyError();
}

// ---------------------------------------------------------------------------
// Realtime dictation
// ---------------------------------------------------------------------------

type Session = {
	ws: WebSocket;
	sox: ChildProcessWithoutNullStreams;
	stopTimer: NodeJS.Timeout;
	stopping: boolean;
};

let active: Session | null = null;

function startDictation(ctx: ExtensionContext, sessionId: string): void {
	// Resolve the credential before touching the mic or the network, so a missing
	// key is a quiet notice rather than an unhandled error thrown mid-keypress.
	let key: string;
	try {
		key = apiKey();
	} catch (err) {
		ctx.ui.notify(err instanceof MissingKeyError ? err.message : `Muse Voice: ${String(err)}`);
		return;
	}
	const url = `${PROTOCOL.realtimeUrl}?sessionId=${encodeURIComponent(sessionId)}`;
	const ws = new WebSocket(url);

	// Audio captured before the handshake ack is buffered, not dropped.
	let acked = false;
	const pending: Buffer[] = [];

	// Live-insertion state. Partials are CUMULATIVE — each one is the complete
	// hypothesis for the turn — so the dictated text is rendered as
	// `baseText + partial` and rewritten in place on every event. That puts words
	// in the editor while you are still speaking, and means nothing depends on
	// `final:true` ever arriving: whatever was said is already in the box.
	//
	// setEditorText (not pasteToEditor) is the right primitive here: pasteToEditor
	// is bracketed paste and appends at the cursor, so per-partial calls would
	// stack duplicates instead of replacing.
	// The separator must NOT be folded into lastWritten: that variable has to
	// mirror what is actually in the editor, or the first partial sees a mismatch,
	// re-bases onto the un-spaced text, and eats the space ("fix the buginHow is…").
	const startText = ctx.ui.getEditorText();
	let baseText = startText && !startText.endsWith(" ") ? `${startText} ` : startText;
	let lastWritten = startText;
	let lastPartial = "";

	const applyLive = (text: string) => {
		// If the user typed while dictating, the editor no longer matches what we
		// wrote. Re-base onto their edit instead of clobbering it.
		const current = ctx.ui.getEditorText();
		if (current !== lastWritten) {
			baseText = lastPartial && current.endsWith(lastPartial)
				? current.slice(0, current.length - lastPartial.length)
				: current;
		}
		lastPartial = text;
		lastWritten = baseText + text;
		ctx.ui.setEditorText(lastWritten);
	};

	const sox = spawn("sox", [
		"-d",
		"-t", "raw",
		"-b", "16",
		"-e", "signed-integer",
		"-r", String(PROTOCOL.sampleRate),
		"-c", "1",
		"-",
	]);
	sox.stderr.on("data", () => {}); // sox chatters on stderr; ignore.

	const session: Session = {
		ws,
		sox,
		stopping: false,
		stopTimer: setTimeout(() => {
			ctx.ui.notify("Muse: dictation auto-stopped (safety limit)");
			stopDictation(ctx);
		}, CONFIG.maxDictationMs),
	};
	active = session;

	const cleanup = () => {
		clearTimeout(session.stopTimer);
		clearTimeout(ackTimer);
		try { sox.kill("SIGTERM"); } catch {}
		ctx.ui.setStatus("muse", undefined);
		if (active === session) active = null;
	};

	// The server drops the socket if the handshake is not acked; don't hold the
	// mic open waiting forever if that ack never arrives.
	const ackTimer = setTimeout(() => {
		if (acked) return;
		ctx.ui.notify("Muse: no handshake ack, giving up");
		try { ws.close(); } catch {}
		cleanup();
	}, PROTOCOL.handshakeTimeoutMs);

	// sox emits at real time, so no manual pacing is needed: the mic is the clock.
	// Never send faster than realtime — the server rejects streams >5s ahead.
	sox.stdout.on("data", (chunk: Buffer) => {
		// After endStream the client->server direction is closed: send nothing more,
		// including mic bytes already buffered in the pipe when sox was killed.
		if (session.stopping) return;
		if (ws.readyState !== WebSocket.OPEN) return;
		if (!acked) { pending.push(chunk); return; }
		for (let i = 0; i < chunk.length; i += CONFIG.chunkBytes) {
			ws.send(chunk.subarray(i, i + CONFIG.chunkBytes));
		}
	});

	ws.addEventListener("open", () => {
		// Handshake MUST be the first text frame, within 10s.
		// Auth goes here — the HTTP Authorization header is ignored on this endpoint.
		ws.send(JSON.stringify({
			authorization: { accessToken: `Bearer ${key}` },
			model: PROTOCOL.model,
			audioEncoding: PROTOCOL.audioEncoding,
			mode: "PUSH_TO_TALK",
			partialMode: "CUMULATIVE",
			emitAudioProgress: false,
			...biasFields(),
		}));
		ctx.ui.setStatus("muse", "● connecting…");
	});

	// All server frames are text JSON; `ws` surfaces those as a string.
	ws.addEventListener("message", (ev: { data: unknown }) => {
		if (typeof ev.data !== "string") return;
		let msg: any;
		try { msg = JSON.parse(ev.data); } catch { return; }

		// The handshake ack is the only server frame with no `type` field.
		if (!msg.type) {
			acked = true;
			clearTimeout(ackTimer);
			ctx.ui.setStatus("muse", "● listening…");
			for (const buf of pending) {
				for (let i = 0; i < buf.length; i += CONFIG.chunkBytes) {
					ws.send(buf.subarray(i, i + CONFIG.chunkBytes));
				}
			}
			pending.length = 0;
			return;
		}

		switch (msg.type) {
			case "transcript": {
				// CUMULATIVE: each partial REPLACES the previous one. Never append.
				// Write every partial straight into the editor so the text builds up
				// live while the sentence is still being spoken.
				const text = msg.transcript ?? "";
				if (text) applyLive(text);
				if (msg.final === true) {
					// PUSH_TO_TALK completion signal. (ENDPOINTING/DIARIZATION use
					// speechComplete instead — this mode does not emit it.) The final
					// text is post-processed, so it can differ from the last partial:
					// applying it upgrades punctuation and capitalization in place.
					ctx.ui.setStatus("muse", undefined);
				} else {
					ctx.ui.setStatus("muse", `● listening… (${CONFIG.shortcut} to stop)`);
				}
				break;
			}
			case "error":
				ctx.ui.notify(`Muse error: ${msg.message ?? "unknown"} (session ${msg.sessionId ?? sessionId})`);
				break;
			// Ignore unknown//future event types by design.
		}
	});

	ws.addEventListener("close", (ev: { code: number; reason: string }) => {
		if (ev.code !== 1000 && ev.code !== 1005) {
			ctx.ui.notify(`Muse: closed ${ev.code}${ev.reason ? ` — ${ev.reason}` : ""}`);
		}
		cleanup();
	});

	ws.addEventListener("error", () => {
		ctx.ui.notify("Muse: websocket error");
		cleanup();
	});
}

function stopDictation(ctx: ExtensionContext): void {
	const session = active;
	if (!session || session.stopping) return;
	session.stopping = true;
	clearTimeout(session.stopTimer);

	// Stop the mic, then signal end-of-input. endStream ends the whole session
	// (not one turn) and closes only the client->server direction — the socket
	// stays open so the server can flush the final transcript. Do NOT close here;
	// closing discards pending events. Wait for the server's 1000.
	try { session.sox.kill("SIGTERM"); } catch {}
	if (session.ws.readyState === WebSocket.OPEN) {
		session.ws.send(JSON.stringify({ type: "endStream" }));
		// Visible proof the stop keypress was delivered. If you press the shortcut
		// and see neither this nor a status change, the key never reached pi.
		ctx.ui.setStatus("muse", "● finishing…");
	} else {
		ctx.ui.setStatus("muse", undefined);
		active = null;
	}
}

// ---------------------------------------------------------------------------
// File transcription (agent-callable tool)
// ---------------------------------------------------------------------------

/** Build multipart/form-data by hand so the `request` part gets an exact
 *  Content-Type: application/json and no bogus filename. */
function buildMultipart(requestJson: string, wav: Buffer): { body: Buffer; contentType: string } {
	const boundary = `----pi-muse-${Date.now().toString(16)}`;
	const head = Buffer.from(
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="request"\r\n` +
		`Content-Type: application/json\r\n\r\n${requestJson}\r\n` +
		`--${boundary}\r\n` +
		`Content-Disposition: form-data; name="audio"; filename="audio.wav"\r\n` +
		`Content-Type: audio/wav\r\n\r\n`,
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	return {
		body: Buffer.concat([head, wav, tail]),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

async function transcribeWav(wav: Buffer, mode: string, sessionId: string): Promise<any> {
	const requestJson = JSON.stringify({
		model: PROTOCOL.model,
		mode,
		audioEncoding: "WAV",
		...biasFields(),
	});
	const { body, contentType } = buildMultipart(requestJson, wav);

	const res = await fetch(`${PROTOCOL.transcribeUrl}?sessionId=${encodeURIComponent(sessionId)}`, {
		method: "POST",
		headers: {
			// Unlike realtime, THIS endpoint does use the Authorization header.
			Authorization: `Bearer ${apiKey()}`,
			Accept: "application/json",
			"Content-Type": contentType,
		},
		// Buffer is a Uint8Array and is a valid fetch body at runtime (verified
		// against the live endpoint); the DOM BodyInit union just doesn't model it.
		body: body as unknown as BodyInit,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		// Distinguish "no key" (handled above) from "key present but rejected":
		// otherwise a stale credential reads as an opaque HTTP failure.
		if (res.status === 401 || res.status === 403) {
			throw new Error(
				`Muse Voice: Meta rejected the API key (HTTP ${res.status}). ` +
				`Check the credential under "${AUTH_PROVIDERS[0]}" in ${join(configDir(), "auth.json")}.`,
			);
		}
		if (res.status === 429) {
			throw new Error("Muse Voice: rate limited by Meta (HTTP 429). Retry with backoff.");
		}
		if (res.status === 413) {
			throw new Error("Muse Voice: audio too large (HTTP 413). The 32 MB request cap was exceeded.");
		}
		throw new Error(`Muse Voice: transcribe failed (HTTP ${res.status}): ${detail.slice(0, 400)}`);
	}
	return res.json();
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut(CONFIG.shortcut, {
		description: "Toggle Muse voice dictation",
		handler: async (ctx) => {
			if (active) stopDictation(ctx);
			else startDictation(ctx, `pi-${Date.now().toString(36)}`);
		},
	});

	pi.registerCommand("voice", {
		description: "Toggle Muse voice dictation",
		// Command handlers receive (args, ctx) — unlike shortcut handlers, which take ctx alone.
		handler: async (_args, ctx) => {
			if (active) stopDictation(ctx);
			else startDictation(ctx, `pi-${Date.now().toString(36)}`);
		},
	});

	pi.registerTool({
		name: "transcribe_audio",
		label: "Transcribe audio",
		description:
			"Transcribe an audio or video file to text using Meta Muse Voice Transcribe. " +
			"Returns the full transcript plus turn-level timestamps, and speaker labels when " +
			"mode is DIARIZATION. Any input format is converted automatically. Recordings " +
			"longer than 10 minutes are split and stitched. Word-level timestamps are not available.",
		promptSnippet: "transcribe_audio: convert an audio/video file to text with speaker labels",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the audio or video file" }),
			mode: Type.Optional(
				Type.Union([Type.Literal("DIARIZATION"), Type.Literal("ENDPOINTING")], {
					description: "DIARIZATION adds speaker labels (default). ENDPOINTING is turn-only.",
				}),
			),
		}),
		execute: async (_id, params, _signal, onUpdate) => {
			// Fail before spawning ffmpeg or creating temp dirs if there is no key.
			apiKey();
			const mode = params.mode ?? "DIARIZATION";
			const src = params.path.replace(/^@/, "");
			const dir = await mkdtemp(join(tmpdir(), "pi-muse-"));
			try {
				// Normalize to the only container the endpoint accepts:
				// RIFF/WAVE, mono, 16-bit integer PCM, 24 kHz, no metadata.
				const norm = join(dir, "norm.wav");
				onUpdate?.({ content: [{ type: "text", text: "Converting audio…" }], details: null });
				await execFileAsync("ffmpeg", [
					"-nostdin", "-y", "-i", src,
					"-ac", "1", "-ar", String(PROTOCOL.sampleRate),
					"-c:a", "pcm_s16le", "-map_metadata", "-1",
					norm,
				], { maxBuffer: 64 * 1024 * 1024 });

				const full = await readFile(norm);
				// Do not assume a 44-byte canonical header: ffmpeg emits a LIST chunk
				// (78 bytes here) even with -map_metadata -1. Walk the RIFF chunks.
				const seconds = wavDurationSeconds(full);

				// Both caps matter: 10 min of audio, and 32 MB of body.
				const perChunk = Math.min(
					PROTOCOL.maxAudioSeconds - 60,
					Math.floor((PROTOCOL.maxBodyBytes * 0.9) / PROTOCOL.bytesPerSecond),
				);

				if (seconds <= perChunk) {
					const out = await transcribeWav(full, mode, `pi-file-${Date.now().toString(36)}`);
					return { content: [{ type: "text", text: formatResult(out) }], details: out };
				}

				const parts: string[] = [];
				const count = Math.ceil(seconds / perChunk);
				for (let i = 0; i < count; i++) {
					onUpdate?.({
						content: [{ type: "text", text: `Transcribing segment ${i + 1}/${count}…` }],
						details: null,
					});
					const seg = join(dir, `seg${i}.wav`);
					await execFileAsync("ffmpeg", [
						"-nostdin", "-y", "-ss", String(i * perChunk), "-t", String(perChunk),
						"-i", norm, "-c", "copy", seg,
					], { maxBuffer: 64 * 1024 * 1024 });
					const out = await transcribeWav(await readFile(seg), mode, `pi-file-${Date.now().toString(36)}-${i}`);
					parts.push(formatResult(out, i * perChunk * 1000));
				}
				return { content: [{ type: "text", text: parts.join("\n\n") }], details: null };
			} finally {
				await rm(dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});
}

function formatResult(out: any, offsetMs = 0): string {
	const turns = Array.isArray(out?.turns) ? out.turns : [];
	// PUSH_TO_TALK returns an empty turns array; fall back to the flat transcript.
	if (!turns.length) return String(out?.transcript ?? "");
	return turns
		.map((t: any) => {
			const ts = fmtMs((t.startMs ?? 0) + offsetMs);
			return t.speaker ? `[${ts}] ${t.speaker}: ${t.transcript}` : `[${ts}] ${t.transcript}`;
		})
		.join("\n");
}

/** Duration of a mono 16-bit PCM WAV, from its actual `data` chunk size. */
function wavDurationSeconds(buf: Buffer): number {
	let off = 12; // skip "RIFF" <size> "WAVE"
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === "data") return size / PROTOCOL.bytesPerSecond;
		off += 8 + size + (size % 2); // chunks are word-aligned
	}
	return (buf.length - 44) / PROTOCOL.bytesPerSecond; // fallback
}

function fmtMs(ms: number): string {
	const s = Math.floor(ms / 1000);
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
