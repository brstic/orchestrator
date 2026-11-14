# Where the office stands: surroundings

What is around the building — seen from above, over the low walls of the usual view, and through the windows — is a choice the office makes. This page says what can be chosen, how it is kept and who may change it, how a place is built, how to add one, and how to look at one. Read it before touching `packages/office-3d/src/surroundings/`, the windows in `Building` (`Environment.tsx`), or `OwnerSettings.surroundings`.

_Built on 2026-11-12 on the owner's request: "make the background and the surroundings of the office changeable (remembered by the server) — the office on one floor of a skyscraper, in glass, everything far below, traffic all round the building, like New York… or in a park, or more of that kind; be creative and make a few different, beautiful 3D surroundings." Why it is built this way: `DECISIONS.md`, "Where the office stands is the office's own, and every place is drawn in code"._

## What can be chosen

*Settings → The office → Surroundings.* Six cards; one click, and it changes at once in every window that has the office open.

| Id | Called | What is there |
| --- | --- | --- |
| `studio` | By itself | The building alone in the dark, as it always was. Nothing is drawn for it and nothing about the scene changes. **The default** — an office that never chose stores nothing. |
| `skyline` | Skyline | The top floor of a tower at dusk, 150 m over the street: a city of some 600 buildings (see "The Skyline's city") — stone and brick with set-in windows, bands of windows, towers of glass that mirror the sky, piers; round towers, podiums, setbacks, machine rooms, air handlers and water tanks on the roofs, a few crowns lit — streets with crossings, stop lines and trees, **traffic that stops at red lights** (cars, SUVs, taxis, buses), red lights on the tall roofs, a helicopter on its round, an aeroplane high up. A paved terrace with a glass balustrade around the office; the tower itself under it. |
| `park` | Park | A pavilion on mown lawns on a clear day: an avenue to a fountain that plays, gravel paths, flower beds, benches and lamps, a pond with a jetty, two boats and water lilies, some 800 trees that move in the wind, hills beyond, birds, five hot-air balloons, clouds drifting. |
| `island` | Island | A small island at sunset: the office on a timber deck, sand sloping into clear shallows and foam, palms, a pier out towards the sun with a boat tied up, sails far out, a lighthouse on a rock with its beam going round, gulls. |
| `north` | Northern lights | A valley deep in snow at night: mountains all round, pines, two cabins with their windows lit, lamps along the way down to a lake that shows the lights, a snowman by the door, snow falling (outside only), the aurora overhead. |
| `orbit` | Orbit | A station above the Earth: the office on a deck of its own, a long truss with solar wings, modules docked, a great wheel turning at the station's end, somebody on a spacewalk at the end of a line, a ship going by — and the planet below, turning, with clouds, city lights on its night side and the thin line of its air. |

Anywhere but `studio` **the outer walls get windows** — floor to ceiling, wherever nothing hangs on the wall or stands against it (see "Windows").

## Whose it is, and where it is kept

- **The office's.** `OwnerSettings.surroundings` (`packages/contracts/src/entities.ts`; the list is `SURROUNDINGS`, and `surroundingsOf(value)` reads a stored value as one of them or `studio`). It lives with the other settings in the office's store, goes to every client in the office's state and in a `settings` update when it changes, and survives restarts. It is **not** one of the preferences a computer keeps for itself (graphics quality, key bindings): everybody in the office stands in the same place.
- **An owner changes it** — `PATCH /api/settings { surroundings }`, like every other setting of the office: the office's own computer and members who are owners; a colleague and a visitor see the page with its controls switched off. A value that is not in the list changes nothing. The change is in the audit log (`settings.changed`, `changed: ["surroundings"]`).
- **How much of a place is drawn** follows each computer's own graphics quality: on *Low* there are fewer far trees, cars, flakes and birds, and smaller painted grounds. The place is the same.

## How it is put together

```
OfficeScene
 ├─ <Surroundings kind world quality>        packages/office-3d/src/surroundings/index.tsx
 │    sets scene.background, scene.fog and the camera's far plane for the place (or back to the plain office's)
 │    ├─ <Sky>            one shell round the camera, drawn behind everything      kit.ts  skyMaterial
 │    ├─ place.group      the place itself, built once per (place, building, quality)   skyline.ts park.ts island.ts north.ts orbit.ts
 │    └─ footing.group    what the floor stands on, rebuilt when the floor grows   buildTower / buildDeck / buildStationDeck
 ├─ <Lights surroundings>                    the place's tint on the office's own three lights
 └─ <Building surroundings>                  hides its dark ground plane; draws `glazed(world)` instead of `world.walls`
```

- **A place is a plain function** `build(input) → { group, update(time), setFloor?, dispose }` (`place.ts`). It makes three.js objects directly, not React elements: a place is a few dozen objects that never change, and this way everything it made is let go of in one `dispose()` (`Kept` in `kit.ts`). `index.tsx` holds the table `PLACES` — for each place its look (sky, fog, how far the camera sees, the tint of the lights), its builder and its footing.
- **Everything that repeats is one draw call** (`instanced` in `kit.ts`): 600 buildings, 3,000 cars, 800 trees, 900 pines. **Everything that moves is moved by the graphics card from the time alone** — cars along their lanes, wings, flakes, fountain drops, waves, clouds, the aurora, the Earth's weather — or is a handful of objects set once a frame (a helicopter, balloons, boats, the wheel). Nothing is simulated and nothing is worked out per item per frame on the processor.
- **Nothing is fetched or loaded.** There is not one image or model file: skies, cities, water and the planet are shaders, grounds are painted once on a 2D canvas, shapes are built in code (`merged`, `turned`). A place costs nothing to ship and nothing on the network.
- **The same for everybody.** Whatever is scattered — trees, cars, lit windows, palms — comes from `rng(seed)` and `noise2`/`fbm2` (`kit.ts`), which give the same numbers on every computer.
- **The sky and the Earth are not things in the scene.** They are drawn where they are *seen from* (their shaders turn with the camera and ignore where it stands) at the far end of the depth range, after everything solid — so they cost only the pixels that show them, need no huge far plane, and do not slide when one walks.
- **The office's own light stays.** The office is lit as ever, whatever the hour outside (three lights; a place only tints them — `PlaceLook`). So the night places are *painted* in night colours: under the office's lamps a white snowfield would be daylight.
- **The floor under the office** (`plateOf(world)` in `windows.ts`): the building with nine metres to walk round it, grown to hold any member's room that reaches further. A footing is rebuilt only when that rectangle changes (to the half metre), not when a member merely comes or goes.

### Windows

`glazed(world)` (`surroundings/windows.ts`, pure, unit-tested) returns the walls to **draw**: each outer wall cut into solid and glass stretches. A stretch is glass when, within 0.8 m of the wall on either side, there is no wall fixture (`wallFixtures`: the board, the wall of screens, the whiteboard, the TV, the CEO room's clocks, signs, chairs at desks), no furniture (`world.solids`), no inner wall ending on it, and no member's room on the other side; a window is at least 1.6 m long and keeps 0.45 m of wall at every end. The world itself is untouched — `world.walls`, collision, navigation and where member rooms may attach are exactly what they were; glass is only a way of drawing a wall. `Building` draws such a stretch as the partitions inside are drawn (a pane between two rails), with clearer glass and its posts 2.4 m apart in one draw call.

### The Skyline's city

Redone on 2026-11-14 (the owner: "redesign the buildings so they look more realistic, and the traffic too"). `skyline.ts`, `traffic.ts`.

- **Buildings.** One material (`buildingMaterial`; `buildingMaterial(true)` for round towers, where the way round is the way along the wall) draws four kinds of front, chosen by height: **stone or brick** with windows set in it (most low ones), **bands of windows** with mullions, **a wall of glass** whose panes each mirror the sky a shade differently (most tall ones), and **piers** with tall windows between, one side of each pier in shade. A tall tower stands on a **podium** of shops filling its lot, steps back as it rises (an older one in more steps), and may be **round**. A pane mirrors what it faces — the last light low in the west, dark blue overhead, the warm city below — more of it the flatter one looks at it (Fresnel). A lit window shows **a room**: brighter under the ceiling, a blind half down here and there. The ground floor is **shop fronts** under a band of awnings and signs; a third of the tall towers have their **crown lit**; the street between towers is darker than the tops (`above`). Light comes from the sky, from the street's glow and from the west, more of it higher up.
- **Roofs.** Gravel and tar with a parapet, and what stands there: the lift's **machine room**, a few **air handlers**, and on older stone buildings a **water tank** on four legs (New York's). They are drawn with the same material as `plain` (no windows; `PLAIN` says concrete, metal, wood, leaves).
- **Streets** (`streetTile`): worn tarmac, a double yellow line, white lane dashes, **zebra crossings** on every side of a crossing and **stop lines** where traffic waits, pavements in slabs with a kerb, pools of lamp light; **trees** along the pavements of the nearer blocks.
- **Traffic** (`traffic.ts`, pure; the shader mirrors `centerAt` as `TRAFFIC_GLSL`). Every crossing has lights on one 36-second cycle: the streets along x have green first, then those along z (`GREEN` 15 s, `AMBER` 2.5 s); the **signals** are drawn at every corner, green, amber or red by the time. In each lane, before each crossing, a **queue** of up to five waits behind the stop line, nose to tail; on green they pull away one after another, drive one block and stop in the same place before the next crossing — so every vehicle moves exactly one block a cycle, and where it is follows from the time alone. **Brake lights** burn while standing and slowing down. Cars, SUVs, yellow **taxis** and **buses** (outer lanes, lit inside). Nobody drives into the one ahead (a follower starts later and takes no less time for the block), and the two directions are never in a crossing together (`packages/office-3d/test/traffic.test.ts` measures both over two cycles, and that nobody is in a crossing on red).
- **What it costs:** 669 draw calls with the Skyline against 594 for the plain office, about 53 frames a second in `tests/ui/surroundings.mjs` on the owner's Mac (the same run: Park 70, Island 46). On *Low*: about half the traffic, a smaller street picture, trees only on the nearest blocks.
- **Shimmer, measured** as below but with the cameras of the redo (over the walls to the horizon · from above onto the streets · towards the west · down in a street): median 3 · 11 · 11 · 4 pixels a frame of 1,410,000.

### Not shimmering

The owner is sensitive to flicker (`DEVELOPMENT.md`, "Flicker"), and far-away detail is where it comes from. The rules used here, each for a pattern that would otherwise crawl when the camera moves:

- **A building's windows** are worked out per pixel; where a window is smaller than a pixel the wall shows its *average* instead (`detail` in `skyline.ts`).
- **What a building knows about itself must be exact when it reaches a pixel.** Each building's seed and share of lit windows travel from the vertex to the pixel shader, and on some graphics cards (seen on Windows, Direct3D through ANGLE; not on the owner's Mac) an interpolated constant arrives a hair off from pixel to pixel. A hash turns a hair into another answer, so a window whose hash lay near the line between lit and dark came out as a field of lit and dark pixels that crawled as the camera moved — it looked like two walls fighting for the same place, and was not. The values are made on a grid (`SEED_STEPS`, `onGrid` in `skyline.ts`) and put back on it in the pixel shader. Anything new that feeds a hash from a varying has to do the same.
- **Waves** finer than a pixel are left out, train by train (`grain` in `waterMaterial`), and what is left of their sparkle far away is a smooth path of light.
- **Stars** are at least a pixel wide whatever the lens (`fwidth` in the sky).
- **Grounds near the office are one flat painted picture** (lawn, paths, beds, shadows; snow, the trodden way, pools of lamp light): nothing lies a few centimetres over anything else. Where something must (a pond on a lawn), it uses `ON_SURFACE`. The land beyond starts exactly at the picture's edge (`INNER` is a whole number of the land's squares — a seam there was the one flicker found while building this).
- **Washes of colour on a canvas** come out in visible steps; `grain()` hides them.

## Adding a place

1. Add its id to `SURROUNDINGS` in `packages/contracts/src/entities.ts`.
2. Write `packages/office-3d/src/surroundings/<id>.ts` exporting `build<Name>(input: PlaceInput): Place` (and a footing if the floor should stand on something). Keep everything in a `Kept`; use `instanced` for anything there is more than a handful of; move things in shaders. Keep clear of the building and of where members' rooms may stand (up to 27 m out on the west, east and north sides; never the south, where the door is).
3. Add it to `PLACES` in `surroundings/index.tsx` with its look.
4. Add its card to `PLACES` in `apps/desktop/src/hud/panels/settings.tsx` (name, one line, a small CSS picture), and its name to `tests/ui/surroundings.mjs`.
5. Look at it (below), on *Low* too, and with member rooms. Run the three tests.

## Looking at one

There is no substitute for eyes here. The loop used while building:

```sh
node scripts/dev-office.ts --port 4652            # prints the office's address with the owner token
ORCH_SERVER_URL=http://127.0.0.1:4652 pnpm --filter @orchestrator/desktop exec vite --port 5199   # the UI, reloading as you edit
curl -X PATCH -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"surroundings":"park"}' http://127.0.0.1:4652/api/settings
```

Open `http://127.0.0.1:5199/?token=<token>`. `__orchScene.still = true` stops the time outside (cars, water, clouds, snow stand still) — for measuring shimmer, below. To hold the camera somewhere (any view, also from far outside): in the console, `__orchScene.cam = { pos: [90, 60, 90], look: [0, -20, 0], fov: 55 }`; `delete __orchScene.cam` gives it back. `__orchScene.surroundings` says which place is drawn, the camera's far plane and the fog; `__orchScene.outerWindows` how many windows there are; `__orchPerf` what a frame costs. With member rooms: `node scripts/dev-office.ts --member-room "Mila:3" --member-room "Vuk:9"`.

## Testing it

| Test | What it covers |
| --- | --- |
| `packages/office-3d/test/surroundings.test.ts` | where windows go and do not (fixtures, furniture, member rooms; every side; each wall still whole; the world untouched; one cannot walk out through one), the floor's size with rooms of every depth, that the scattering repeats, and reading a stored value |
| `tests/e2e/44-surroundings.test.ts` | the setting on a real server: nothing chosen at first, each place stored and in the office's state, a value that is not a place ignored, other settings undisturbed, the audit entry, a colleague and a visitor refused, there after a restart |
| `tests/ui/surroundings.mjs` (30 checks; needs the UI build) | two windows of one office with storage of their own: the Settings page and its six cards; each place chosen with a real click and standing in both windows and in the office's state; a sky, the place's air, the long view, the windows; the frame rate and the draw calls against the plain office; **that no shader failed to build** (the renderer's complaints are collected); a window opened afresh is given the place by the office; *Low* on one computer; back to the plain office with nothing left behind |

## Shimmer, measured

The way `DEVELOPMENT.md` describes ("Flicker"): composited frames with the camera creeping 3 mm a frame, people and overlays hidden, the time outside stopped (`__orchScene.still`), the lens given fourteen frames to settle first; a pixel that changes by 30 levels and is back the frame after is counted. Of 1,410,000 pixels, the median per frame, from three cameras (over the low walls to the horizon · from above · towards the west):

| | horizon | above | west |
| --- | --- | --- | --- |
| By itself | 20 | 18 | 14 |
| Skyline | 30 | 53 | 12 |
| Park | 30 | 48 | 26 |
| Island | 40 | 51 | 29 |
| Northern lights | 53 | 61 | 50 |
| Orbit | 29 | 38 | 23 |

A few dozen pixels in a million and a half, the office's own edges included: nothing a place adds is seen as flicker. The measurement found one thing that was: the line where the sea cut the sand (800 pixels flipping from above) — the water now fades out just before the sand instead.

## What it costs

On the owner's Mac (the development office, the usual view, 1500×940): the plain office 581 draw calls and 0.69 M triangles; with a place 650–700 draw calls and 0.71–1.06 M triangles (the park is the heaviest: its trees). The frame rate was the display's 144 in every place, on *Low* as well. About 70 of the extra draw calls are the windows (each stretch of glass is a pane and two rails) — the same in every place.

## Limits, plainly

- **One time of day per place.** Dusk over the city, noon in the park, sunset on the island, night in the north. There is no clock and no weather setting.
- **The window rule is by what stands near a wall, not by what looks good.** A room with furniture along its outer wall (the server room, the kitchen side of the break room) keeps a solid wall there. Members' rooms have no windows at all.
- **Snow does not fall "inside"**: inside is one rectangle round the building and every member's room together, so in the notch between a deep member's room and the building no snow falls either.
- **Traffic goes straight on**: nobody turns at a crossing, and all the lights of the city change together. Vehicles come round again at the city's edge (in the fog).
- **The island's sea is striped from high above** (a free camera far up): its waves are a few regular trains. From the office and the beach it is not.
- **Nothing outside can be walked on.** The floor to walk on ends where it always did; the terrace, the lawn and the beach are to look at.
- **Phones** get the office's phone page, which has no 3D office; nothing changes there.
- The entrance page (`ENTRANCE-PAGE.md`) draws its own small office and is not moved by this setting.

## Not verified

- **On a slow or integrated graphics card.** Every number above is from one fast Mac. The shaders are cheap by design (no loops over lights, no textures to fetch but small painted ones), but that is a design, not a measurement.
- **Safari and Firefox**; Linux and Windows builds of the desktop app. Looked at in Electron (Chromium) only.
- **The owner's eye.** Each place was looked at in captures from a handful of fixed cameras, in the usual view, from above, at eye level through the windows (the city) and with two member rooms (the city and the island). Nobody has walked round in one.
- **Shimmer with the time running.** It was measured with the time outside stopped, so that what moves on purpose is not counted. Whether a moving thing itself crawls (a car's lights far away, a wave) was judged by eye in captures only.
