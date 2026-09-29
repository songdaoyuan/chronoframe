# Video regression checks

Run the source-level regression suite after installing workspace dependencies:

```sh
node --test tests/video-regressions.test.cjs
```

It covers rotated video dimensions, thumbnail fallback rendering, preservation
of database-only edits during reindexing, bounded preview caching, concurrent
render deduplication, privacy overrides in both queue APIs, and storage prefixes.

`video-media.container.cjs` additionally exercises the image's real FFmpeg and
ExifTool binaries against synthetic media. Transpile `server/services/video/display.ts`
and `privacy.ts` to CommonJS files named `display.cjs` and `privacy.cjs`, place
them with the script in a scratch directory, and mount it at `/verify` in the
ChronoFrame image. Run `/usr/bin/node /verify/video-media.container.cjs` with
network access disabled. The scratch mount must be writable for the synthetic
portrait fixture. The checks verify GPS removal from MOV/MP4 without changing
decoded frames, no upscaling of portrait footage, and a 1920-pixel maximum edge.

Privacy cleanup applies to newly processed uploads. Existing stored media are
not rewritten merely by updating the application or reindexing technical metadata.
