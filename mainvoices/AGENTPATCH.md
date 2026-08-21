# AgentPatch 3

**AgentPatch is a MainVoice pack framework, not one mandatory voice synthesizer.**

An AI agent can use one of the included engines, call a completely different engine/tool/model, provide its own 39 WAV files, decorate the voice profile, validate the result, and package it into the same MainVoice ZIP format.

## The important change in v3: engines are swappable

A recipe now has an explicit `engine` section:

```json
{
  "format": "agentpatch-recipe-3",
  "id": "nova",
  "name": "Nova",
  "engine": {
    "type": "builtin",
    "id": "chip",
    "config": {
      "waveform": "triangle",
      "bitDepth": 8
    }
  }
}
```

Built-in engines are:

- `formant` — the configurable source/filter engine
- `chip` — a separate digital wavetable-style engine
- `whisper` — a mostly-noise resonator engine

List them machine-readably:

```bash
python agentpatch.py engines --json
```

### Bring your own engine

AgentPatch supports an external command engine:

```json
{
  "engine": {
    "type": "command",
    "id": "my-awesome-engine",
    "command": [
      "python",
      "my_engine.py",
      "--recipe", "{recipe}",
      "--output", "{output}"
    ],
    "config": {
      "anythingYourEngineNeeds": true
    }
  }
}
```

The command may use these placeholders:

- `{recipe}` — temporary resolved recipe JSON
- `{output}` — output voice folder
- `{samples}` — output `samples/` directory
- `{project}` — MainVoice source directory

It also receives the same paths in `AGENTPATCH_RECIPE`, `AGENTPATCH_OUTPUT`, `AGENTPATCH_SAMPLES`, plus `AGENTPATCH_ENGINE_CONFIG` as JSON.

The external engine must create the 39 required WAVs under `samples/`. AgentPatch then writes the normal metadata/profile, validates the bank, and packages it.

Because a command recipe can execute software, AgentPatch **will not run it silently**. After reviewing the recipe, use:

```bash
python agentpatch.py build custom.agentpatch.json --allow-external-engine
```

`agentpatch_engine_example.py` is an intentionally simple independent example engine that an agent can fork or replace.

An agent can also ignore `synth` entirely, produce WAVs with any audio library/model/app, then run only:

```bash
python agentpatch.py manifest voice.agentpatch.json my-voice
python agentpatch.py validate my-voice --json
python agentpatch.py pack my-voice --out my-voice-mainvoice.zip
```

## Profile decoration

Voice packs can carry much more than one square image now. `profile` supports:

```json
{
  "characterArt": {"source": "character.svg"},
  "profile": {
    "theme": "neon",
    "accent": "#d66cff",
    "accent2": "#6cf5ff",
    "status": "currently arguing with the song editor",
    "bio": "A short voice/character bio.",
    "badges": ["default voice", {"label": "singing-ready", "icon": "♪"}],
    "links": [
      {"label": "Project page", "url": "https://example.com"}
    ],
    "banner": {"source": "banner.svg"},
    "background": {"source": "background.webp"},
    "stickers": [
      {"source": "sparkle.svg", "x": 84, "y": 12, "size": 54, "rotate": 12}
    ],
    "extraAssets": [
      {"source": "other-decoration.svg", "outputName": "other-decoration.svg"}
    ]
  }
}
```

Themes: `default`, `glass`, `terminal`, `sticker`, `neon`, `minimal`. Sticker decorations can be positioned by percentage (`x`/`y`), pixel `size`, and rotation.

Character art, banner, background, and extra assets can be **SVG, PNG, WebP, JPG/JPEG, or GIF**. SVG files stay SVG. Validation checks that SVG is valid XML and rejects script/event/`foreignObject` style active content before publication.

The MainVoice UI reads the profile colors, theme, status, bio, badges, links, banner, background, engine badge, and character art directly from `voice.json`.

## Fast workflow

```bash
python agentpatch.py scaffold \
  --id nova --name "Nova" --author "My agent" \
  --engine chip --preset glass --art character.svg \
  --theme neon --banner banner.svg \
  --out nova.agentpatch.json

python agentpatch.py identity nova.agentpatch.json --json
python agentpatch.py build nova.agentpatch.json --output mainvoices/nova --zip nova-mainvoice.zip
```

## Full recipe identity controls

For the built-in formant engine the recipe can independently shape source/excitation, formant/vocal-tract geometry, vowel space, F1/F2/F3, breath, roughness, harmonic tilt, odd/even balance, pitch drift, vibrato, consonant edge, fricative sharpness, stop punch/voicing, nasal/liquid color, diphthong motion, durations, seeded per-phone variation, and per-phoneme overrides.

Those fields are **engine-specific identity hints**. A custom engine can use them, reinterpret them, or ignore them and use its own `engine.config`.

This separation is intentional: the MainVoice pack format cares about the resulting WAVs, not which engine created them.

## Required output

Every complete voice must contain:

```text
voice-id/
├─ voice.json
├─ character.svg       (or another supported image format)
├─ profile-assets/     (optional)
│  ├─ banner.svg
│  └─ background.webp
└─ samples/
   ├─ IY.wav
   ├─ IH.wav
   └─ ... all 39 ARPAbet WAVs
```

Required phonemes:

```text
IY IH EH AE AA AO AH UH UW ER AY AW EY OW OY
W Y R L M N NG F TH S SH V DH Z ZH HH P B T D K G CH JH
```

## Validation

```bash
python agentpatch.py validate my-voice --json
```

Validation reports missing/broken WAVs, channels, PCM width, sample rate, durations, clipping/quiet samples, missing profile assets, and invalid/unsafe SVG files.

## Browser helper

`agentpatch.html` creates recipe JSON and AI-agent task text. It exposes engine selection/config, detailed identity controls, SVG paths, and profile decoration. The browser page does not execute external engines; those run through the full-source CLI after explicit opt-in.
