# Acceptance: 2026-09-29

Validated runtime image: `chronoframe:review-fixes-20260929-final`
(image ID `28b73e40c149e0eaebbb0aa6a63d200f224fbb13ec3e6b6a9b06d93cbd1f4fef`).
The local container used port 3309 and local storage; onboarding and login completed.

- Production Docker/Nuxt build succeeded; targeted lint and Git whitespace checks passed.
- All six source regression tests passed.
- Real container FFmpeg/ExifTool checks removed GPS from MOV and MP4 without changing decoded frame hashes.
- Portrait 1080x1920 and 720x1280 stayed unchanged; 3840x2160 became 1920x1080.
- HTTP upload-to-queue acceptance covered both privacy overrides with a rotated MOV fixture. Both displayed 180x320; downloaded originals confirmed GPS absent when enabled and retained when disabled.
- Editing ratings and coordinates, reindexing, then removing coordinates and reindexing preserved user edits without restoring GPS.
- Share preview requests measured 123-149 ms cold and 4-5 ms warm on these small local fixtures. These are smoke measurements, not a production benchmark.
- Browser verified portrait decoding/playback, muted loop, the 180x320 info panel, and a fully loaded 1200x630 share preview.

Limits: upload file selection could not be automated in this browser, so the upload pipeline was exercised over HTTP. Native Safari HEVC/HDR playback was not tested. Existing stored originals are not retroactively sanitized. No production deployment was performed.
