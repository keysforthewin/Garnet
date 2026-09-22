# Garnet launch media

The three finished square MP4s, four product screenshots, poster frames, and X copy live in [`docs/media/garnet/`](../../docs/media/garnet/). Open its `index.html` directly in a browser to watch all three videos. No server or installation is needed for playback.

## Reproduce

Requires the existing production build, the host MongoDB service on port 27018, Node 22+, installed npm dependencies and Playwright Chromium, FFmpeg/FFprobe with libx264, and the Ubuntu Sans/Ubuntu Mono system fonts. Genuine agent captures also require authenticated `claude` and `codex` host CLIs. The scripts do not change the application build or production data.

```sh
node scripts/media/setup.mjs
```

Leave the integrated demo server running and use another terminal to capture, render, and verify:

```sh
node scripts/media/capture.mjs
node scripts/media/render.mjs
node scripts/media/verify.mjs
```

The demo app is fixed to `127.0.0.1:8082`, database `ed_promo`, and `data/promo-*` directories. It creates Alex and Sam accounts and six fictional documents. Generated passwords stay in the ignored runtime directory. Capture reuses existing demo documents, so subsequent takes retain previous edits. To create a pristine take, use a fresh disposable demo database and matching empty demo directories; never reset `ed` or the production directories.

`storyboards.mjs` defines exact shot durations, source crops, overlay text, and X captions. `render.mjs` uses browser-rendered typography and FFmpeg to produce 1080×1080 H.264 MP4s at 30 fps, with fast-start metadata and no audio. Each exported cut is exactly 30 seconds. `COPY.md` is generated from the same storyboards.

Raw timestamped browser frames, intermediate renders, and full run evidence stay under the ignored `test-results/media/` directory. Browser frame timestamps preserve real-time typing and collaboration. Completed agent results are shown after a labeled cut; the actual recorded Claude and Codex runs took approximately 28 and 30 seconds respectively. The footage uses the real interface, including actual save statuses, provider selection, and collaborator cursors.

The capture verifies offline reload/reconnection, bidirectional collaboration, and real agent document edits. The media verifier checks duration, dimensions, codec, file size, full decoding, browser playback and seeking, mobile player layout, and README asset paths. Public media verification is saved alongside the MP4s.

## GitHub players

The README includes hosted GitHub players and repository MP4 download links. `docs/media/garnet/attachments.json` maps each hosted attachment URL to its local filename and SHA-256 hash. The uploaded files were checked against the local exports, and playback was verified in GitHub's README preview.

For replacement videos, sign in to the repository's README editor, attach the finished MP4s, copy the generated URLs into separate paragraphs in the local README, and discard the browser edit. Confirm filenames by comparing downloaded attachment hashes, since simultaneous uploads can appear in reverse order. Keep the repository copies for portability. No issue or comment needs to be posted.

## Stop the demo services

Stop the foreground demo server with Ctrl+C. The production app, HTTPS service, and MongoDB remain running.
