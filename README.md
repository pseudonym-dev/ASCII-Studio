# ASCII Studio

Turn images and short videos into colored ASCII, entirely in the browser.

**Live:** https://pseudonym-dev.github.io/ASCII-Studio/

Drop a photo or a clip (up to 15 seconds, 100 MB) on the page. The home screen also has six short example clips; click one to open it in the editor. Adjust density, edges, glow, and background separation, then download a PNG or copy the text. For video, transport controls sit under the picture, like a video editor, and a live preview plays while you work. Export to MP4, WebM, or GIF happens frame by frame at the end. Nothing is uploaded. There is no audio.

## Develop locally

Node 22+ is enough to lint, typecheck, unit-test, and build. End-to-end tests also need Google Chrome, `ffmpeg`, and `ffprobe` on `PATH`.

```sh
npm ci
npm run verify      # lint + typecheck + unit tests + build + e2e (headless Chrome, ffprobe)
npm run build       # writes web/ascii-studio.html from web/src, web/template.html, and web/assets
```

Open `web/ascii-studio.html` in a browser. The built page is a single self-contained file.

To rebuild the packed example grids from the clips in `samples/`, run `node tools/pack-examples.mjs` (needs `ffmpeg` and `@napi-rs/canvas`; on macOS point `DEJAVU_MONO` at a DejaVu Sans Mono .ttf).

## Credits

Full source and license notes for sample media are in `samples/SOURCES.txt`.

- Clownfish photo (`samples/clownfish-real.jpg`, used by tests): Nick Hobgood, clownfish (*Amphiprion ocellaris*) in a magnificent sea anemone, East Timor. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Anemone_purple_anemonefish.jpg), **CC BY-SA 3.0**.
- “Toco toucan” example: Eaktas06. [Pixabay](https://pixabay.com/videos/toucan-bird-beak-feathers-plumage-150714/), **Pixabay Content License**.
- “Dancer” example: agus252. [Pixabay](https://pixabay.com/videos/woman-girl-dancer-2d-cartoon-140638/), **Pixabay Content License**.
- “Galloping horse” example: Yocchi09. [Pixabay](https://pixabay.com/videos/horse-run-meadow-animal-natural-330880/), **Pixabay Content License**.
- “Campfire” example: NickyPe. [Pixabay](https://pixabay.com/videos/fire-flames-wood-burn-campfire-192687/), **Pixabay Content License**.
- “Koi pond” example: Paul_Tran. [Pixabay](https://pixabay.com/videos/koi-fish-fish-japanese-pond-nature-48287/), **Pixabay Content License**.
- “Jellyfish” example: christianbodhi. [Pixabay](https://pixabay.com/videos/jellyfish-aquarium-exhibition-213616/), **Pixabay Content License**.

The on-page example clips are pre-rendered ASCII grids of those videos (same authors and licenses). Credits also appear under each clip.

Component styles follow [Untitled UI React](https://github.com/untitleduico/react) (MIT), dark mode, with a lime brand colour. Font: [Inter](https://rsms.me/inter/) (OFL, `web/assets/fonts/LICENSE-inter.txt`), latin subset inlined at build time. Icons from [Lucide](https://lucide.dev) (ISC, `web/assets/icons/LICENSE-lucide.txt`); GitHub mark from [Simple Icons](https://simpleicons.org) (CC0). The ASCII canvas keeps its own dark background. Libraries inlined at build time: [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer) (MIT), and [gifenc](https://github.com/mattdesl/gifenc) (MIT).
