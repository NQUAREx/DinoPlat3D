# Dino Run

[Play on a portrait phone](https://nquarex.github.io/DinoPlat3D/)

A lightweight, touch-only endless 3D runner built with Three.js 0.186.1, TypeScript and Vite. GitHub Pages serves the static client; Supabase provides unique device profiles, online leaderboards and activity statistics. No Node.js server is required on Pages. The separate original DinoPlat repository/game is untouched.

## Online profiles and analytics

First launch requires a unique nickname. Home displays it and allows renaming. The same browser restores its private device profile; clearing browser storage loses access. Previously registered players can play offline, but runs without a server-confirmed start stay local.

Leaderboards offer distance and earned-run coins for UTC day, Monday-start week and all time, including personal value/rank. Shop balances and DEV grants never raise coin rank. The author code reveals a separate Admin tab; summary data additionally requires the allowlisted Supabase Auth administrator login. Detailed player/session history, daily activity and D1/D7/D30 retention views live in the [Supabase dashboard](https://supabase.com/dashboard/project/yusnxxdeumczuniwumvi).

Setup, credential retrieval, privacy/retention, free-tier limits and optional regional relay: [Supabase operations](docs/SUPABASE.md). Telegram notifications run on Supabase, not the phone. A bot must receive `/start` from the recipient before it can send private messages. Direct connectivity from every Russian ISP is not guaranteed; no proxy hosting is currently configured.

## Controls

The Help tab contains the full icon-based manual and opens automatically on the first visit. It is also available in Pause, alongside Resume and Settings.

- Hold the left/right half to turn continuously in that direction. Release to keep running along the new heading. Full 360° movement, no lanes/boundaries; speed never stops during normal play.
- Camera follows turns with a 0.42s delay. Distance counts travelled path length, including sideways/backward travel, not a world coordinate.
- Release a hold and make a separate upward swipe to jump. Downward swipe dives in the air or ducks for 0.85s on the ground. Vertical gestures never start steering.
- A stationary hold classifies after 36ms, horizontal intent after 2.7px; a moving pending swipe is not converted to steering by a timer. A committed hold cannot later turn into a jump—use a separate gesture.
- Consecutive top-left tabs open Home, Shop, Settings and Help before a run or after death. Pause is separate: Resume, Settings and Help. Sound effects and music have independent saved toggles. Camera shake stays fixed at290%; landing impact is50% stronger, respecting reduced motion. Portrait touch browsers only; keyboard/mouse and landscape gameplay are intentionally unsupported.
- Damage displays a small 2D -1 heart notice and freezes the contact pose for one second, including fatal hits; then two seconds of immunity/blinking and temporary start speed. Coins/diamonds/hearts display +1 icons; a full-health heart displays MAX. Bonus notices show the effect name and duration, with ! for negative effects. Pause freezes timers and restart clears feedback.
- Coins/diamonds survive new runs via a validated, year-long, project-scoped cookie. Hearts restore one up to three. Browser privacy/deletion can clear storage; this is a client-side prototype economy, not secure server money.
- Shop shows a sticky coin/diamond balance, refreshed after purchases. All menus share the world background. Home's fixed-scale character slowly rotates at a bounded30Hz; touch dragging changes rotation, never scale. Other menus remain event-driven. No extra WebGL context or background texture.
- Flat-ground jump flight lasts about1.008s, with a4.020m apex. Take-off impulse15.96m/s adds the runner's current uphill/downhill vertical velocity; gravity stays31.68m/s². This prevents an uphill slope from immediately catching a jump. Jump/dive collisions remain swept.

## Rare pickup effects

Seven temporary effects share the pickup pool with coins, diamonds and hearts. Pickups activate immediately; collecting the same kind refreshes its full duration without stacking time or strength. Different kinds can run together. Timers freeze during pause and hit stop and reset for a new run. Compact icons and whole-second countdowns appear below the score only during play; negative effects carry an **!** marker. Help explains all effects and relative rarity.

| Effect | Duration | Selection weight | Rule |
| --- | --- | --- | --- |
| Jetpack | 6s | 1.2 | Flies 5m above terrain, including water/lava/pits; fades down on expiry. Reach safe ground before descending. |
| Invisibility | 8s | 1.5 | Prevents obstacle damage only. Water, lava and pits remain fatal when fallen into. |
| Magnet | 10s | 2 | Attracts coins within 7m; other pickups are unaffected. |
| Blindness (!) | 4s | 0.6 | Restricts visibility; hazards remain dangerous. |
| Turbo | 5s | 1 | Adds 40% speed, capped at 26m/s while active (normal cap24m/s); grants no protection. |
| Reverse (!) | 5s | 0.6 | Swaps left/right turning; jump/duck swipes remain unchanged. |
| Shake (!) | 3s | 0.4 | Shakes the camera; system reduced-motion preference suppresses shaking. |

Weights are relative selection weights, not percentages: coin250, diamond10, heart1. Negative pickups are intentional hazards to avoid. The HUD preallocates seven slots and countdown strings, mutating DOM only when displayed seconds or visibility change; pickup notices reuse the existing twelve-label pool.

## iPhone / Android rendering

- Fixed the old whole-canvas `image-rendering:pixelated` enlargement and aggressive resolution reduction that treated a healthy 30Hz Safari cadence as overload.
- Rendering requests native antialiasing, uses normal canvas compositing, caps DPR at2 and physical pixels at1.3M, and does not reduce ordinary phone buffers below one CSS pixel per pixel. Icons/fonts retain pixel-art filtering; the environment is texture-free low-poly geometry.
- Sustained frame intervals above40ms can reduce resolution with6s hysteresis; recovery requires12s healthy cadence. Stable30Hz does not progressively lower quality. This trades some extra fill cost for clarity; it is not proof of higher FPS on every device.
- The owner's screenshot shows a yellow battery/Low Power Mode. [WebKit documents a 30fps requestAnimationFrame throttle in Low Power Mode](https://bugs.webkit.org/show_bug.cgi?id=168837). Turn it off when comparing smoothness. Web code cannot override OS refresh/power/thermal limits, and cloud tests cannot guarantee Brawl Stars/native-game performance.
- Android/compatible browsers request fullscreen on Play/Resume user activation and fall back safely on denial. Normal iPhone Safari tabs cannot be forced fullscreen: Share → Add to Home Screen, then launch the installed icon. The local manifest/icons support standalone/fullscreen display; offline play is not implemented.
- Native touch selection/callout, scrolling, overscroll, dragging, tap flash and zoom gestures are disabled; settings buttons and attribution links remain usable. Landscape, background, fullscreen exit and context loss pause rather than silently continuing.

## Art and procedural world

Current wardrobe:110 items across24 dinosaur skins,23 hats,23 boots,20 watches and20 gloves. Original offline geometry shares vertex-colour materials; watches/gloves follow arm bones. Existing purchases remain compatible. Connected dinosaur:1182 triangles,14 blended surface bridges,11 bones and five clips. Current GLB:1,069,064 bytes /127 meshes. Detailed cactus range26.4–36m. Pickups award once immediately, then a bounded32-slot visual pool lifts/fades their models over0.45s. Dust uses the same day/night lighting as other models, with no extra shadow pass.

### Author tools

Settings → Author code unlocks a hidden developer tab and an in-run DEV button. Only a SHA-256 verifier is shipped; this is a convenience gate, **not authentication or protection**. A project-scoped `dinorun-developer=1` cookie remembers the device. All tuning values reset on reload.

Live controls cover gameplay, generation, camera, terrain, lighting, audio, effects and rendering, plus separate +1000coin/+1000diamond actions. Changes are session-only; structural pool/GPU capacities are read-only. Generation edits can restore consumed candidates. The seven temporary pickup effects are normal gameplay, independent of developer access.

Audio-file verification in `npm test` requires development tools `ffmpeg` and `ffprobe`; GitHub CI installs them. They are unnecessary for playing, serving or building the static game. Isolated browser checks: `node tests/personal-record-browser.mjs` and `node tests/sound-browser.mjs` (installed Playwright browsers required).

- Home shows a fixed-scale rotatable3D dinosaur with equipped accessories, result, record and wallet. Original prices remain: free green, white750coins, pink60diamonds, gold1000diamonds; original hats240/360coins or75diamonds, shoes270/360coins or60diamonds. The100 additions have individual prices in the catalogue. Locked prices show currency icons. Purchases/equipment persist in localStorage; spending persists in the wallet cookie. Closed soles cover the feet. Cosmetics never change physics or speed.
- Fatal contact freezes for1s, then the stopped dinosaur falls sideways and bounces for1.25s before Home. No bone death animation is required. First-person temporarily returns to the rear camera for the fall. Dust emits from alternating animated planted feet; landing emits from both feet.
- Surface footsteps use12 selected Kenney CC0 takes with separate sand/grit, stone, grass and wood textures, three takes each, ten distinct cover profiles and subtle variation. One171197B local MP3 contains22 cues plus the original16s music loop. One mono decode stays below4MiB at48kHz; eight bounded SFX channels plus music. Effects/music toggles remain independent. Sources and references: ASSETS.md and art/audio.
- Bottom-right camera button switches between delayed third-person and first-person views. Both views use the same .42s heading smoothing. A .65s sinusoidally eased position/rotation/FOV transition preserves the ongoing run. First person hides the dinosaur and follows jumping/crouching. Turning is1.6rad/s; third-person follow delay is.42s. Crouching retains an animated distance-driven walking gait.
- Original cartoon dinosaur inspired by the owner's watch/keyring references: long chamfered muzzle, large eyes/teeth, tapered turquoise body and tail, cream belly and coral plates, with newly rounded body facets. 1182 triangles /11 bones /five cached blended run, jump, duck, hit, death clips; appearance is independent of the stable body collider.
- Seven detailed cactus variants with enlarged spines/rounded bumps and2–8 enlarged scattered stones:750/774/468/930/886/810/936 triangles. Seven simplified copies omit detail:192/192/48/192/168/192/192 triangles. No additional textures or separate detail objects.
- Distance-based **LOD**: detailed within26.4m, low beyond36m, complementary opaque4×4 dither fade between. Both tiers are preloaded with identical core normalization/positions. No network requests, per-obstacle LOD nodes or geometry generation during play.
- One cached local `src/assets/game-models.glb`:127 meshes /1069064 bytes, no texture maps or external decoders. Editable original generators: `tools/low-poly-dinosaur.mjs`, `tools/low-poly-cacti.mjs` and `tools/low-poly-cosmetics.mjs`. Coin/diamond/heart are original volumetric low-poly models (192/48/84 triangles), matching HUD palettes; source tools/low-poly-collectibles.mjs. Imported GPL VOX art is archival only, not runtime dinosaur/cactus geometry.
- World positions are continuous Float64 X/Z with a bounded symmetric15×15 chunk ring:2250 numeric slots, not2250 rendered objects. Actual instances are full-volume camera culled, with a small shadow-caster guard. Deterministic candidates in a numerical neighbourhood allow turns/revisits without near-camera spawning or an ever-growing scene.
- Cacti use forgiving simple swept collision (.65× cactus half extents plus .22m body radius), separate from full visual/culling bounds, and and hard-core spacing. Separate pickup RNG preserves cactus distribution; coin:diamond:heart weights250:10:1, with10% fewer pickup candidates via an independent deterministic gate. Safe continuous corridors remain reserved and tested with a delayed heading-steering pilot at maximum speed.
- Desert dominates the coordinate-seeded world. Oasis/lava patch candidates occur one-third as often; retained patches keep their varied shape and size. Tallest mountains occur half as often. Positive heights are three times lower (42m cap); negative relief remains down to-16.6m. Mini-cliffs and all terrain contact damage are removed. Both pit families, fatal water/lava and14m pit depth remain.
- A224m bounded reusable terrain mesh has jittered shared vertices and polygon-clipped shores, banks, deep pit walls and bridge thickness. Crossings and their planks follow curved/oblique directions, not square cell axes. Vertex-coloured Lambert shading needs no floor atlas, textures or downloaded world engine. CPU support uses the same clipped warped triangles as rendering. Gray ravine depth haze shares the ground draw; no transparent fog layers or extra render target.
- Rivers/ponds/lava/pits remain fatal when fallen into; bridges cross only water/lava. Dry pits have irregular decorative stone rims and independent clipping that excludes liquid wedges. Birds fly9m/s, launch48–64m inside±45° camera facing and commit a straight path at10m. Launch waits if tumbleweed is predicted to require a jump on the same path. All tumbleweed moves immediately at7.5m/s. Fully fallen trees/cacti are harmless decoration; partial falls and upright obstacles still collide.
- Surface travel speed is equal uphill/downhill/on flats; horizontal travel compensates for grade. Turning is10% sharper (1.76rad/s), stationary hold classification30ms. A slower smoothstep acceleration ramp reaches full pace near3000m, with1.2s easing. At high speed, new obstacle candidates thin by up to30%; existing visible objects and pickup rates stay unchanged. Camera slope pitch/FOV remain.
- Twenty-six new original offline models include three trees and three dead trees with matching LODs, three rocks, grass/shrubs/reeds/flowers/stumps/logs, tumbleweed and a flapping bird. New181468B GLB, cached geometry and instanced banks; numeric chunk ring remains2250 slots. Only camera-visible instances plus bounded shadow guards are submitted. No growing chunk-history cache or runtime mesh creation.
- 256 pooled8-triangle dust puffs, one draw,42 per step/72 on landing with varied lift and .85s lifetime. Heading-relative world-anchored trails; stronger running bob (+50% versus the previous build) and landing impulse respect fixed290% shake/reduced motion.
- One unchanged360s active-play day/night cycle starts at09:00 each run: dusk begins after105s, night after135s. Pause/hit freeze/Game Over stop the clock. `?time=` intentionally freezes it for debugging; normal URLs advance automatically. Smooth fog/ambient and opposite-side virtual moonlight; no visible moon or second sun/map. Cached256² shadows stay enabled at low quality; their focus follows the delayed view without rotating celestial direction. Dinosaur uses a separate small jump/duck-aware contact shadow.

## Local development

Requires Node.js22+ and npm.

```sh
npm ci
npm run dev
# open the forwarded port5173 on a touch device / browser mobile emulation
npm run build
npm run preview
```

Codex Cloud: start the dev server and use its forwarded browser port/preview if the client provides one. Desktop browsers need touch/mobile emulation; otherwise the intentional phone prompt appears without loading GPU assets. If no preview/port forwarding is offered, use the deployed Pages link or run the commands locally.

```sh
npm run model:build          # offline characters/accessories/cacti/pickups → GLB
npm run shop:build           # ten actual-model WebP thumbnails (Chromium + ffmpeg)
npm run audio:build          # local CC0 clips + original music → MP3 (ffmpeg)
npm run collectibles:build   # requires ImageMagick, rebuilds pickups + GLB
node tools/build-biome-models.mjs # offline original environment GLB
npm test
npm run test:browser         # Playwright Chromium
npm run test:mobile          # Playwright Chromium + WebKit
```

Install Playwright browser binaries/system dependencies as required by your environment. Some managed hosts need `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` only after the needed libraries are available. Test outputs/screenshots go to ignored `test-results/`.

## GitHub Pages

The committed workflow `.github/workflows/pages.yml` builds/tests and deploys `dist/` on main. If Pages needs manual activation:

1. Open NQUAREx/DinoPlat3d → Settings → Pages.
2. Under Build and deployment → Source choose **GitHub Actions** (not a branch).
3. Enable Actions if disabled; run **Build and deploy static game** or push to main.
4. Wait for the deploy job/environment to finish, then open the URL above.

Vite uses relative asset paths so the current `/DinoPlat3D/` subpath works on static hosting. Only development/build needs Node.js; Pages serves HTML/JS/CSS/fonts/GLB/WebP/icons. No backend routes or server-only code. GitHub Pages paths are case-sensitive; use the play link above.

## Architecture and verification

- `Simulation`, `BonusState`, `WorldSpawner`, `ObjectRegistry`, wallet/health/events: numeric gameplay, seven temporary pickup effects, fixed pools and extension contracts. Enemies/destruction remain inactive extension metadata.
- `RenderPose`, `CameraRig`, `View`, instanced renderers and `RenderQuality`: one floating origin, delayed camera, LOD/culling and bounded adaptive rendering.
- `LandscapeField`, `TerrainSurface`, `Ground`, `Scenery`, `LightingRig`, `CachedShadows`: stateless coordinate biomes/support/hazards, bounded volumetric terrain/decoration, one cached shadow map. Preserve the Three r186 instance-upload epoch fix.
- `ModelLibrary`, `AnimatedDinosaur`, `FootDust`, `FloatingFeedback`: explicit GPU/animation/DOM ownership, no runtime model generation or per-pickup node creation.
- `MobileBrowser`, `GestureRecognizer`, `GameUI`, `CurrencyCookies`, sound/haptics/settings: mobile lifecycle/gesture/UI/persistence, user-activated optional browser features.

The expanded wardrobe retains only the equipped accessory meshes in the scene; switching models reuses their offline cached geometry. The pickup fade uses ten bounded instanced banks/geometries (three ordinary pickups and seven bonuses), sharing32 visual slots with no new textures. Warming previously unseen catalogue entries can increase GPU geometry residency up to the finite catalogue; compare restart memory only after warming the same selections. Fixed pools and finite tests are evidence of bounded resources, not proof against every leak. Physical-device FPS remains unmeasured. See [VERIFICATION.md](VERIFICATION.md), [ASSETS.md](ASSETS.md), and [AGENTS.md](AGENTS.md) for current results, licensing and mandatory invariants.

GPL-3.0-only; no warranty. Preserve source/attribution when redistributing. Original reference artwork and third-party notices are documented in ASSETS.md.

## Optional Codex communication skill

The environment has the authentic [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) skill installed globally using `DO_NOT_TRACK=1 npx --yes skills add JuliusBrussee/caveman --skill caveman --agent codex --global --yes`. Installed file: `/home/agent/.agents/skills/caveman/SKILL.md`; its Git blob hash matches the official source: `9a94044529e5ee1576361c891b4a271504518e6f`. This installs the skill only, not Caveman's proxy, model routing or CLI suite. It does not add a game dependency or change code/documentation style. Global installation belongs to this environment; a different environment needs installation again.
