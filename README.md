# Pocket Pitch — England Rugby on your table (WebAR)

A zero-install AR game that runs from a link or QR code. Point at a table, tap to drop a mini rugby union pitch, then flick an England-kit rugby ball to score tries (bins), tackle the moving bags and land drop goals over the posts.

Static site: **no build step, no dependencies**. three.js (r160) loads from a CDN.

## Deploy to Vercel

**Option A — CLI (fastest)**
```bash
cd pocket-pitch
npx vercel          # first run: log in and accept the defaults (framework: "Other", no build command)
npx vercel --prod   # promote to a production URL
```

**Option B — GitHub**
Push this folder to a repo → vercel.com → *Add New… → Project* → import it → *Deploy* (leave all settings as default).

Vercel serves over HTTPS, which WebXR, the camera and motion sensors all require. **Test on the deployed URL on your phone** (or open it on desktop and scan the URL as a QR code). `file://` and plain `http://` won't work for AR.

## How to test

| Device | What you get |
| --- | --- |
| **Android phone, Chrome** (with Google Play Services for AR) | **Real AR**: WebXR `immersive-ar` + hit-test surface detection. A footprint of the pitch snaps to the table; tap to place. |
| **iPhone / iPad, any browser** | **Camera mode** with **surface lock** (experimental, see below): live camera feed + gyroscope for rotation, plus camera-based tracking of the table for movement. The pitch is placed at an assumed height below the phone (▲▼ buttons adjust it). |
| **Desktop browser** | **Preview mode** (no camera): fixed view, mouse-drag to flick. Good for quick checks of gameplay. |

## Surface lock on iPhone (camera mode)

iPhone Safari doesn't expose AR surface tracking to web pages, so a gyroscope-only pitch slides around whenever the phone moves. `src/tracker.js` fixes that without any SDK: it tracks texture points on the table in the video (Lucas-Kanade optical flow, predicted from the gyro rotation) and solves for the phone's translation assuming those points lie on a flat table. A **Surface lock** pill shows *good / weak / lost*, and the **Lock on/off** button lets you compare against rotation-only.

Tips: use a table with some texture (wood grain, a cloth, objects on it) and decent light; move smoothly; give it a second after placing. It is validated against synthetic ground truth (`npm test`: ~1.5 cm mean error, <2 ms/frame) but **has not yet been tuned on real iPhone video** — please test and report how it behaves. For production-grade iOS tracking, a licensed WebAR SDK (e.g. Zappar, 8th Wall's engine binary) is the alternative; licence terms need Legal/Procurement review.

Flow: **Start → scan/aim → tap to place → flick up the screen**. Faster swipe = longer throw; swipe slightly left/right to aim.

The four challenges (all short): **Kick-Off** (static bin = a try, light aim-assist), **Moving Bins**, **Through the Posts** (tackle bags + a drop goal over the crossbar), **Final Whistle** (40-second scoring round). Consecutive scoring throws build a streak multiplier (x2, x3).

## Project layout

```
index.html        page shell, HUD / screens (also the WebXR DOM-overlay root)
style.css         mobile-first UI
src/logic.js      pure game logic: physics, targets, challenges, scoring (no DOM / three.js)
src/tracker.js    surface-lock tracker for camera mode (pure JS, no DOM / three.js)
src/main.js       three.js scene, WebXR + fallback, input, FX, UI wiring
test/logic.test.mjs     `npm test` — headless checks of the game logic
test/tracker.test.mjs   `npm test` — tracker accuracy vs synthetic ground truth (test/synth.mjs)
vercel.json       permissions + cache headers
```

## Tweaking

- **Ball & pitch look** — `makeBallTexture()` and `makePitchTexture()` in `src/main.js` (white ball with navy/red trim and "ENGLAND" lettering; plain text only — add approved federation logos/assets before public use).
- **Surface-lock tuning** — `CONFIG.fovY` (match your phones' camera FOV), and `PlaneTracker` options in `src/tracker.js` (`maxPoints`, `minPoints`).
- **Branding / CTA link** — `CONFIG` at the top of `src/main.js` (`ctaUrl`, `ctaText`; set `ctaUrl` to `''` to hide it). Colours are in `COLORS` and `style.css` (`:root`).
- **Challenges & difficulty** — `CHALLENGES` in `src/logic.js` (targets, speeds, balls, star thresholds, `assist`). Physics constants are in `WORLD`.
- **Flick feel** — `flickToVelocity()` in `src/logic.js` (speed → range mapping, sideways sensitivity).
- **Default table size** — `CONFIG.defaultScale` (1 = 0.56 × 0.90 m). Players can switch S / M / L in the HUD.
- **Self-host three.js** — download `three@0.160.0/build/three.module.js` into a `vendor/` folder and change the import-map URL in `index.html` to `./vendor/three.module.js`.

## Known limitations

- True surface detection is Android Chrome only. To our knowledge iOS Safari doesn't offer WebXR AR, so iPhones use camera mode with the experimental camera-based surface lock described above.
- Camera-mode surface lock needs a textured surface and reasonable light; on blank tables or in the dark it reports *lost* and holds the last position. It drifts slowly over long sessions and doesn't know the table's true height (the pitch size is set by S / M / L).
- Flick, physics and UI logic are covered by automated tests, but the WebXR path itself needs a real Android device to validate. Please check placement, flick direction and touch handling on-device.
- Sounds are synthesised in-browser (no audio files) and start after the first tap, as browsers require.
- Branding is England-kit colours and lettering only — no federation logos or marks are included.
