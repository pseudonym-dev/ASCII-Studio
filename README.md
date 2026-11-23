# ASCII Studio

Turn images and short videos into colored ASCII, entirely in the browser.

**Live:** https://pseudonym-dev.github.io/ASCII-Studio/

Drop a photo or a clip (up to 15 seconds, 100 MB) on the page. The home screen also has three short example clips; click one to open it in the editor. Adjust density, edges, glow, and background separation, then download a PNG or copy the text. For video, transport controls sit under the picture, like a video editor, and a live preview plays while you work. Export to MP4, WebM, or GIF happens frame by frame at the end. Nothing is uploaded. There is no audio.

## Develop locally

Node 22+ is enough to lint, typecheck, unit-test, and build. End-to-end tests also need Google Chrome, `ffmpeg`, and `ffprobe` on `PATH`.

```sh
npm ci
npm run verify      # lint + typecheck + unit tests + build + e2e (headless Chrome, ffprobe)
npm run build       # writes web/ascii-studio.html from web/src, web/template.html, and web/assets
```

Open `web/ascii-studio.html` in a browser. The built page is a single self-contained file.

## Credits

Full source and license notes for sample media are in `samples/SOURCES.txt`.

- Sample photo (`web/assets/demo.jpg`, also `samples/clownfish-real.jpg`) — Nick Hobgood, clownfish (*Amphiprion ocellaris*) in a magnificent sea anemone, East Timor. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Anemone_purple_anemonefish.jpg), **CC BY-SA 3.0**. The file on the page is a smaller JPEG of that photograph.
- “Clownfish” example — Amada44, *Weissrücken-Anemonenfisch*. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Weissr%C3%BCcken-Anemonenfisch_-_Amphiprion_akallopisos.webm), **CC BY-SA 3.0**.
- “Scissor dance, Peru” example — Chris Gill. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Scissor_Dance,_Peru.webm), **CC BY 3.0**.
- “Fireplace” example — BrillLyle. [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:ABOedit2015-Video-Fire.webm), **CC0 1.0**.

The on-page example clips are pre-rendered ASCII grids of those videos (same authors and licenses). Credits also appear under each clip.

Look follows [voa](https://github.com/plainroom/voa) (Apache-2.0): tokens from `src/voa/ui/tokens.css`, automatic light/dark. The voa NOTICE and license are in `web/assets/NOTICE-voa.txt` and `web/assets/LICENSE-voa.txt`. Icons from [Lucide](https://lucide.dev) (ISC, `web/assets/icons/LICENSE-lucide.txt`). The ASCII canvas keeps its own dark background. Libraries inlined at build time: [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer) (MIT), and [gifenc](https://github.com/mattdesl/gifenc) (MIT).
