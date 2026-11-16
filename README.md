# Pocket Pitch — WebAR tabletop rugby

A zero-install AR game that runs from a link or QR code. Point at a table, tap to drop a mini rugby pitch, then flick a ball into moving bins, tackle bags and goalposts.

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
| **iPhone / iPad, any browser** | **Camera mode**: live camera feed + gyroscope. The pitch is placed at an assumed height below the phone (use the ▲▼ buttons to match your table). It tracks rotation only, not walking around. |
| **Desktop browser** | **Preview mode** (no camera): fixed view, mouse-drag to flick. Good for quick checks of gameplay. |

Flow: **Start → scan/aim → tap to place → flick up the screen**. Faster swipe = longer throw; swipe slightly left/right to aim.

The four challenges (all short): **Kick-Off** (static bin, light aim-assist), **Moving Bins**, **Through the Posts** (tackle bags + goal over the crossbar), **Final Whistle** (40-second scoring round). Consecutive scoring throws build a streak multiplier (x2, x3).

## Project layout

```
index.html        page shell, HUD / screens (also the WebXR DOM-overlay root)
style.css         mobile-first UI
src/logic.js      pure game logic: physics, targets, challenges, scoring (no DOM / three.js)
src/main.js       three.js scene, WebXR + fallback, input, FX, UI wiring
test/logic.test.mjs   `npm test` — 16 headless checks of the game logic
vercel.json       permissions + cache headers
```

## Tweaking

- **Branding / CTA link** — `CONFIG` at the top of `src/main.js` (`ctaUrl`, `ctaText`; set `ctaUrl` to `''` to hide it). Colours are in `COLORS` and `style.css` (`:root`).
- **Challenges & difficulty** — `CHALLENGES` in `src/logic.js` (targets, speeds, balls, star thresholds, `assist`). Physics constants are in `WORLD`.
- **Flick feel** — `flickToVelocity()` in `src/logic.js` (speed → range mapping, sideways sensitivity).
- **Default table size** — `CONFIG.defaultScale` (1 = 0.56 × 0.90 m). Players can switch S / M / L in the HUD.
- **Self-host three.js** — download `three@0.160.0/build/three.module.js` into a `vendor/` folder and change the import-map URL in `index.html` to `./vendor/three.module.js`.

## Known limitations

- True surface detection is Android Chrome only. To our knowledge iOS Safari doesn't offer WebXR AR, so iPhones use camera mode (rotation tracking only).
- Camera mode assumes a table height; the pitch won't stay put if you physically walk around.
- Flick, physics and UI logic are covered by automated tests, but the WebXR path itself needs a real Android device to validate. Please check placement, flick direction and touch handling on-device.
- Sounds are synthesised in-browser (no audio files) and start after the first tap, as browsers require.
- Prototype branding is generic rugby styling — no federation logos or marks are used.
