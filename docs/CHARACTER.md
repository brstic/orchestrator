# My character — how each person looks in the office

_Built on 2026-11-17 on the owner's request: "make a full character creator, so that players can change their character and customise it as much as they want (different clothes, hair styles and so on), and so that it stays every time they come in."_

Every person who comes into the office — the owner, a colleague, a visitor — has a figure that walks for them. In **Menu → My character** they choose everything about it, with the figure itself turning in front of them as they choose. What they make is **kept for them by the office** (on the server, by who they are — not in a browser or on one computer), so every window, every computer and every visit draws them so, and **everybody in the office sees them so**.

Read this before touching `apps/desktop/src/hud/panels/character.tsx`, `apps/server/src/characters.ts`, `packages/office-3d/src/looks.ts`, the hair and facial hair in `packages/office-3d/src/character/head.ts`, or `Appearance` in `packages/contracts/src/entities.ts`.

## What can be chosen

| Tab | What |
| --- | --- |
| **Body** | Skin (ten tones or any colour), height (90–110 %), build (slim — broad) |
| **Face** | Face shape (soft oval, round, long with a firm jaw), eye colour (six or any), brows (soft, straight, arched, full, fine), facial hair (none, stubble, mustache, goatee, beard — in the colour of the hair) |
| **Hair** | Style: short, buzz cut, long, ponytail, bun, curly, afro, mohawk, bald; colour: twelve natural ones, five bold ones, or any |
| **Clothes** | Polo, shirt, T-shirt, sweater or suit; the colour of the top (or the suit), the trousers, the shoes, and with a suit the tie |
| **Extras** | On the head: nothing, a cap or headphones; glasses, with either |

Under the figure: **Standing / Walking / Waving / Sitting** (on a chair) to see it so; dragged sideways, it turns. At the bottom: **Surprise me** (a look made up at random), **Undo changes**, **The office's look** (forget what was made and look as before — asks first), and the main button **Save** (*Save my character* the first time).

## The look the office gives you

Somebody who never made a character is drawn as before, and now **the same in every window** (`defaultLook` in `office-3d/src/looks.ts`): the root owner as the office's boss in a dark suit; anybody else from the colour the office gives them (`hue`, the colour of the ring under them). Before this, the owner's own window drew the boss while the others saw them in another look; now everybody sees the same figure.

The creator starts from what you wear now, with everything the office used to decide by itself written out (`filledLook`): the outfit, the face, the brows, the eyes, the build, the shoes, the tie. Drawn the same — but now each of them can be changed one at a time.

## How it is kept and shown

```
 the creator (character.tsx)        the server                               every window
 ┌──────────────────────────┐ PUT   ┌──────────────────────────────┐  me.look  ┌──────────────────────────┐
 │ a look, all of it        ├──────▶│ cleanAppearance → kv          ├─────────▶│ their own windows: me.look│
 │ /api/me/character        │       │ `characters` (by member id)   │  people   │ everybody: people[].look  │
 └──────────────────────────┘       │ audit `character.changed`     ├─────────▶│ → Rig (own) / Humans      │
                                    └──────────────────────────────┘           └──────────────────────────┘
```

- **Routes** (`server.ts`, rules in `access.ts`, level *read* — so a visitor too, and each only their own): `GET /api/me/character` → `{ look | null }`; `PUT /api/me/character { look }` → `{ look }`; `DELETE /api/me/character` → back to the office's look.
- **Cleaned on the way in** (`cleanAppearance`, contracts): colours must be `#rrggbb`, choices one of the known ones, numbers within their ranges; anything else is dropped or falls back. Nothing a person sends is kept as sent unless it is a look.
- **Kept** in the office's store, kv `characters`, by the member's id (`'owner'` for the root owner) — `apps/server/src/characters.ts`. It survives restarts and deploys.
- **Shown**: the client's `ready` carries `me.look` (and `me.hue`); a change is sent at once as `me.look` to that person's windows and with the next `people` list to everybody (`PersonPresence.look`). The window keeps an unchanged look as the same object (`sameLook` in `store.ts`), so a figure is rebuilt only when its look changes, not with every step anybody takes.
- **Drawn**: one's own figure by `Rig` (`selfLook` → `OfficeScene` → `Rig`), everybody else by `Humans` (`h.look ?? defaultLook(...)`).

## The figure's new parts

- **Hair** (`head.ts`, all on the same shell over the skull as the old ones): *buzz* (clipped all over), *ponytail* (swept back, a tail to the nape, a band), *afro* (a full round cloud of curls, with the curl texture), *mohawk* (a crest from forehead to nape; the sides shaved — the surface runs 7 mm under the skin there, so the crest's edge is a clean line). Each also under a cap, and headphones sized for each.
- **Facial hair** is **part of the head**: the head's own triangles where it grows are a second group drawn in the colour of the hair (stubble: the hair colour mixed with the skin). Nothing lies on the face, so nothing can fight it for depth; its edges follow the face's own rows (level) and columns (upright, by angle round the side of the head), so they are clean lines, not steps. A separate sheet over the face was tried first and dropped: where it crossed into the skin between the mesh's points its edge was ragged.
- **Brows**: two new ones (straight and full; fine and high-arched), offered in the creator only; a look the office makes up still picks from the first three, so every figure made before keeps its brows.
- **Glasses with a cap or headphones** (`glasses: true` beside `accessory`).
- **Chosen shoes and tie** (`shoes`, `tie` in the look).

`Appearance` keeps its seven fields; the new ones (`outfit`, `glasses`, `facialHair`, `face`, `brows`, `eyes`, `girth`, `shoes`, `tie`) are optional. Where one is absent the office decides it as it always did (`traitsOf`), so every look saved before — every employee's — is drawn exactly as it was. Employees can wear the new hair styles too (their profile → Appearance).

## Who may do what

| | sees others' characters | makes their own |
| --- | --- | --- |
| Owner | yes | yes |
| Colleague | yes | yes |
| Visitor | yes | yes (only their own) |

Nobody can change anybody else's character.

## Tests

- `packages/contracts/test/appearance.test.ts` — what is kept of a look sent from outside.
- `packages/office-3d/test/character.test.ts` — the new hair styles are sound surfaces (also under a cap, with headphones), facial hair is the head's own triangles in a group of their own (beard > goatee > mustache), a look's own choices win and a look without them is drawn as before.
- `tests/e2e/62-character.test.ts` — a colleague makes one: kept as sent, in their next window, seen by everybody in the `people` list; a visitor makes their own and only their own; what is not a look is not kept; back to the office's look; the owner's is there after a restart; the change is on the audit log.
- The UI suite's step *My character*: opened, a look made with real clicks (afro, beard, sweater, glasses, seen sitting), saved, and there when the window is opened again.

## Not done / not seen

- Not looked at on the owner's real display, nor on a phone-sized browser window (the window stacks the figure over the choices below 760 px wide; not tried).
- A figure from across the building: the new parts were looked at up close and at a few metres, not from the overhead camera.
- Employees are still dressed in their profile's Appearance tab (now with the new hair styles), not in this creator.
