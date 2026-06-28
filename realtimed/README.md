# VoiceEnable Agent

A dependency-free static prototype for a voice-centric Pollinations agent.

## Modes
- Realtime mode uses `gpt-realtime-2` through `/v1/realtime` and requests the model's own audio output/voice over the realtime socket. Browser BYOP auth uses `?key=...` because WebSocket browser clients cannot set auth headers.
- Realtime does not need separate TTS; the model emits audio deltas, and the app routes them into an `<audio>` element so browser echo cancellation has the model voice as its reference.
- Push2Talk mode records microphone audio, transcribes it, sends it to a configurable text model, and can optionally speak responses with TTS.
- Gibberlink mode is an agent-to-agent data-over-sound link (inspired by [Gibberlink](https://github.com/PennyroyalTea/gibberlink)). Two VoiceEnable instances exchange JSON frames as [ggwave](https://github.com/ggerganov/ggwave) audio tones instead of speech: they broadcast a handshake, recognize each other, and — when both ends are the same agent type — negotiate a faster, noisier protocol. The agent can also enter it on its own via the `start_gibberlink` tool when it recognizes an AI peer. `ggwave` is loaded lazily from a CDN only when this mode is used, so the rest of the app stays dependency-free.
- The agent can call configured tools for image, video, audio/music/TTS generation, a coder model, and HTTP MCP-compatible gateways.

## BYOP Setup
- `CLIENT_ID` in `app.js` is the publishable app key (`pk_VIepF2clCLKh5xiX`). This key is intentionally static client-side app identity.
- Users click **Connect Pollen**, approve the app at `enter.pollinations.ai`, and return with their own scoped user key in the URL fragment.
- Do not put a secret `sk_...` app key into static code.

## Live Models
- Model fields load suggestions from Pollinations model-listing endpoints at runtime: `/text/models`, `/image/models`, `/audio/models`, and `/embeddings/models`.
- The realtime model is fixed to `gpt-realtime-2` in realtime mode.

## Run Locally
Open `index.html` from a local static server. One simple option is:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.
