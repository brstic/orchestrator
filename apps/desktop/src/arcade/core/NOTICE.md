# The arcade's emulator core

Two files that are not ours, kept here so that building the app needs no network (docs/ARCADE.md, "The emulator").

| File here (gzip -9 of) | SHA-256 of the unpacked file |
|---|---|
| `genesis_plus_gx_libretro.js.gz` | `80da80493936df3ee66bb0d7313bcf181f6aefc5245c50d08f41b4eb5d0dcccc` |
| `genesis_plus_gx_libretro.wasm.gz` | `98de5d0096b82461c3a8bb999c617ecfbc913b585055fcfa5102161e774d44bb` |

- **From**: `https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2/retroarch/genesis_plus_gx_libretro.zip` (SHA-256 of the zip: `7bd0f36eef6f61e63541a0f51c3ccecb8a7139235d9c3734739acd9c4249b3c8`), fetched 2026-11-12. That project builds RetroArch and its cores for the web; it is where the `nostalgist` library takes its cores from.
- **What it is**: RetroArch 1.22.2 (GPLv3, https://github.com/libretro/RetroArch) with the Genesis Plus GX core (https://github.com/libretro/Genesis-Plus-GX) linked in.
- **Genesis Plus GX's licence is non-commercial**: it may be used and passed on free of charge, with its licence text, and may not be sold or be part of something sold. See `LICENSE.txt` in its repository. Orchestrator is used by its owner and their colleagues; if that ever changes, this core has to go (docs/DECISIONS.md, "The arcade").
- **To replace it** (a newer build, or another core): unpack the new zip, `gzip -9 -n` each file to the names above (or change the two imports in `../console.ts` and `CORE` in `../frame.ts`), and update this table. The frame's script never fetches a core itself.
