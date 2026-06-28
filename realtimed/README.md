# VoiceEnable

**A real-time, voice-first AI agent that talks, creates, and builds — right in your browser.**

VoiceEnable is powered by `gpt-realtime-2` and wired into image generation, video generation, music, speech, web search, a coding model, and a live adaptive canvas. Have a natural spoken conversation, ask it to make things for you, and watch them appear. No installs, no backend — it runs as a single static page and spends *your* Pollen through bring-your-own-key auth.

---

## 🎙️ Talk to it, naturally

- **Realtime mode** — a full spoken conversation over `gpt-realtime-2`. It hears you, replies in its own voice, and reacts live. The visualizer pulses to the actual audio so you can *see* it listening and speaking.
- **Push2Talk mode** — prefer something cheaper? Switch to push-to-talk: your speech is transcribed by a model of your choice, answered by a normal text model, and optionally spoken back with TTS. Same agent, lighter footprint.
- **Type instead** — drop a message in the composer any time. Replies render with clean markdown and copyable code blocks.

## 🎨 Ask it to make things

Just ask — it routes to the right tool and saves the result to your local gallery.

- **"Make me an image of…"** → done.
- **"Now a video of…"** → sure, why not.
- **"Compose 30 seconds of lo-fi"** → music and sound generation.
- **"Say this in a warm voice"** → clean text-to-speech.
- **Edit & remix** — use an existing image as a reference, or turn an image into a video. VoiceEnable only runs edits on models that actually support reference images, and asks you to drop in source images when it needs them.

## 🧩 An adaptive canvas that builds itself

The workspace reshapes around the conversation. The agent can render **charts, tables, checklists, metrics, notes, and code** on the fly — and when a preset isn't enough, it asks the **coding model to build a live, interactive widget** (a calculator, a diagram, a mini-tool) that runs sandboxed right on the canvas.

Need something runnable? Ask for an app or game and the coder returns a complete HTML project, saved to your gallery to open, inspect, or download.

## 🔎 It knows things beyond its training

Built-in **web search** routes to a search-grounded model for current, factual answers with cited sources — complete with a little magnifying-glass-over-sources animation while it looks.

## 🧠 It remembers you

VoiceEnable keeps a **persistent long-term memory** across sessions. Tell it your name, your defaults, the project you're working on — it stores the durable stuff and brings it to every future conversation. You stay in control: review and forget memories any time.

## 🖼️ Your own media library

Everything it generates lands in a **local gallery** (stored in your browser). Reuse images as sources, replay audio and video, open generated projects — and let the agent **manage the gallery for you**: delete, clear, or retag on request.

## 📡 Gibberlink — agents talking to agents

An experiment for the curious: **Gibberlink** lets two VoiceEnable agents talk to each other over *sound* instead of speech, exchanging data as audio tones (via ggwave). They broadcast a handshake, recognize each other, and — when both ends are the same agent — switch to a faster, noisier machine-to-machine protocol. The agent can even decide to start it on its own when it realizes it's talking to another AI.

## 🎛️ Total control

- **Pick every model** — realtime voice, text, coder, transcription, TTS, image, video, music, embeddings, and search are all swappable from live model lists. Too expensive on realtime? Drop to Push2Talk. Want a different image model? Switch it.
- **Bring Your Own Pollen** — authorize the app once and it spends your own scoped key. No bundled secrets, no surprise bills.
- **Make it yours** — themes (Aurora, Paper, Obsidian, Studio), layouts, agent personalities, and a full interface sound design with its own volume control.
- **Connect tools** — point it at HTTP MCP gateways to give the agent external capabilities.

---

VoiceEnable is a dependency-free static web app — open it, connect, and start talking. The only thing loaded on demand is the ggwave sound library, and only if you use Gibberlink.
