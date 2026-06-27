# VoiceEnable Agent

A dependency-free static prototype for a voice-centric Pollinations agent.

## Modes
- Realtime mode uses `gpt-realtime-2` through `/v1/realtime` and browser BYOP auth via `?key=...` because WebSocket browser clients cannot set auth headers.
- Push2Talk mode records microphone audio, transcribes it, sends it to a configurable text model, and can optionally speak responses with TTS.
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
