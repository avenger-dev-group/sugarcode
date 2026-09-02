---
name: video-production
description: Create, edit, preview, or render videos, animations, motion graphics, captioned clips, product demos, and code-driven video compositions through a project-local video engine.
---

# Video production

Treat video creation as an agent workflow backed by replaceable local tools. The model plans and authors the composition; a project-local engine previews and renders it. Do not imply that the language model itself encodes video.

## Boundaries

- Core authoring, preview, and rendering must work without a hosted media API when the selected local engine and its runtime dependencies are installed.
- External APIs are optional providers for generated footage, images, voices, avatars, music, or cloud rendering. Never require or configure one unless the requested result needs it and the user authorizes that provider.
- Keep generated projects, downloaded assets, temporary frame output, and final renders inside the active workspace.
- Reuse user-provided assets. Do not replace them silently with remote assets.
- Never read `.env` files or print credentials. Use the existing trusted command environment when a provider is explicitly authorized.

## Engine selection

The video engine is an adapter, not a SugarCode core dependency. Select it in this order:

1. Continue with the engine already declared by an existing video project.
2. Use an engine explicitly named by the user.
3. Use a compatible engine already installed in the workspace.
4. For a new code-driven composition with no declared preference, use a project-local Remotion setup. Explain the dependency before the first command that installs packages.

Do not install multiple engines for one deliverable. Do not migrate an existing composition merely to follow the default.

## Workflow

For tool reliability throughout this workflow:

- Make at most one tool call in each assistant response and wait for its result before the next call.
- Pass exactly one standalone JSON object as the tool arguments. Never concatenate, merge, or batch multiple JSON objects into one tool argument.

1. Identify the subject and available input. Ask only when the subject itself is missing; otherwise infer safe defaults and state them briefly.
2. Inspect the workspace for an existing video project, package manager, media assets, fonts, and engine configuration.
3. Write a concise storyboard before implementation. Include scenes, timing, narration or caption intent, aspect ratio, frame rate, and output format.
4. Freeze all used media into a project asset directory. Record source or generation provenance in an asset ledger when media came from outside the workspace.
5. Author deterministic, frame-derived animation. Given the same inputs and frame number, the composition must render the same pixels. Avoid wall-clock time, uncontrolled randomness, live network media, autoplay-dependent state, and animations that cannot be sought.
6. Preview locally. Inspect representative frames from the beginning, middle, transitions, and end; fix clipping, overflow, missing media, font fallback, and unreadable captions.
7. Render a short or low-quality sample before a long final render. Use the same browser and concurrency settings planned for the final render; changing those settings invalidates the sample as a renderer-stability check. Report progress during a long render and preserve actionable engine errors.
8. Verify the final file exists and probe its duration, dimensions, frame rate, video codec, and audio stream when `ffprobe` is available. Also scan the encoded video for isolated temporal outliers or full-frame flashes. Representative stills alone are insufficient because they do not exercise concurrent full-video capture.
9. After successful production, always finish with the verified workspace-relative video artifact directive on its own final line so SugarCode displays the quick playback card. The video is not fully handed off until this card can be derived:

   `::preview{path="renders/final.mp4"}`

## Defaults

- Unknown destination: 16:9, 1920x1080, 30 fps.
- Shorts, Reels, or TikTok: 9:16, 1080x1920.
- Social feed when vertical is not requested: 1:1, 1080x1080.
- Narration and captions use the user's language.
- Prefer MP4 for ordinary delivery and WebM only when transparency or a web-specific codec is required.

## Local dependency checks

Before scaffolding or rendering, inspect rather than guess:

- Node.js and the workspace package manager
- the selected engine and its exact version
- Chrome or Chromium requirements of that engine
- `ffmpeg` and `ffprobe` availability and codec support

Use the engine's programmatic renderer or CLI through `shell_exec`; keep installation project-local and version-pinned. A missing encoder is a runtime dependency problem, not a reason to switch models or call an external video API.

## Remotion adapter

For the default new-project adapter:

- Keep all `remotion` and `@remotion/*` packages on the same exact version.
- Define compositions with explicit width, height, fps, and duration.
- Derive visual state from the current frame and input props.
- Default final renders to one browser worker (`--concurrency=1` or `Config.setConcurrency(1)`). This is mandatory when using a system-installed Chrome or Chromium instead of Remotion's managed browser: concurrent tabs can intermittently capture a scaled or tiled viewport even when separately rendered stills are correct.
- Do not increase final-render concurrency merely to work around a timeout. Raise the render timeout instead. If higher concurrency is intentionally tested, decode the entire result and inspect every flagged temporal discontinuity before accepting it.
- When a decoded frame is an unexplained temporal outlier, render that exact frame as a standalone still. If the still is correct, treat the video frame as a capture-concurrency failure, discard the video, and render again with concurrency one.
- Use the embedded development server for preview and the renderer or CLI for final output.
- Keep the rendered file under `renders/` and never overwrite unrelated user media.
- Before product distribution or end-user automated rendering, surface that Remotion licensing must be reviewed; do not make legal eligibility claims.

## Editing existing media

For trim, concat, reframe, loudness, subtitle burn-in, or overlay-only jobs, a direct FFmpeg pipeline may be simpler than creating a composition project. Preserve the original input, write to a new output path, and verify audio/video synchronization.
