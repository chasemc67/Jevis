#!/usr/bin/env python3
"""Generate the local README visuals (Python 3.9+ and Pillow).

    python3 -m venv /tmp/jevis-doc-assets
    /tmp/jevis-doc-assets/bin/python -m pip install Pillow==11.3.0
    /tmp/jevis-doc-assets/bin/python scripts/generate-doc-assets.py

No network, API keys, or running Jevis server are used by this script. The GIF
illustrates the mixed fixture; its display timing is editorial, except for the
1,500 ms debounce countdown. It is not a recording or a model-quality benchmark.
Fonts: Arial on macOS/Windows, DejaVu Sans on Linux; --font-dir overrides search.
"""

import argparse
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets"
W, H, SCALE = 1080, 636, 2
C = {
    "bg": "#101519", "panel": "#171e23", "line": "#303c43",
    "text": "#ecf1ef", "muted": "#9cacae", "faint": "#64767d",
    "mint": "#9be2be", "green": "#243c30", "amber": "#e8c282",
    "amber_bg": "#342f24", "blue": "#91c8df", "blue_bg": "#253940",
    "excluded": "#20292e",
}
WORDS = "We already ate dinner. Could you summarize my notes?".split()


def find_fonts(extra):
    dirs = [Path(extra)] if extra else []
    dirs += [Path("/System/Library/Fonts/Supplemental"),
             Path("/usr/share/fonts/truetype/dejavu"), Path("C:/Windows/Fonts")]
    for directory in dirs:
        for regular, bold, mono in [
            ("Arial.ttf", "Arial Bold.ttf", "Courier New.ttf"),
            ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf"),
            ("arial.ttf", "arialbd.ttf", "cour.ttf"),
        ]:
            paths = [directory / name for name in (regular, bold, mono)]
            if all(p.is_file() for p in paths):
                return paths
    raise SystemExit("Install DejaVu Sans fonts or pass --font-dir with Arial fonts.")


class Canvas:
    def __init__(self, font_paths):
        self.image = Image.new("RGB", (W * SCALE, H * SCALE), C["bg"])
        self.draw = ImageDraw.Draw(self.image)
        self.paths = font_paths
        self.fonts = {}

    def font(self, size, kind=0):
        key = (size, kind)
        if key not in self.fonts:
            self.fonts[key] = ImageFont.truetype(str(self.paths[kind]), size * SCALE)
        return self.fonts[key]

    def text(self, xy, value, size=18, color="text", kind=0):
        self.draw.text(tuple(v * SCALE for v in xy), value,
                       fill=C.get(color, color), font=self.font(size, kind), anchor="lt")

    def width(self, value, size=18, kind=0):
        return self.draw.textlength(value, font=self.font(size, kind)) / SCALE

    def box(self, bounds, fill="panel", outline="line", radius=12):
        self.draw.rounded_rectangle(tuple(v * SCALE for v in bounds), radius * SCALE,
                                    fill=C.get(fill, fill), outline=C.get(outline, outline), width=SCALE)

    def line(self, xy, color="line", width=1):
        self.draw.line([tuple(v * SCALE for v in p) for p in xy], fill=C.get(color, color), width=width * SCALE)

    def triangle(self, xy, color="mint"):
        self.draw.polygon([tuple(v * SCALE for v in p) for p in xy], fill=C.get(color, color))

    def finish(self):
        return self.image.resize((W, H), Image.Resampling.LANCZOS)


def frame(font_paths, stage, count, excluded, directed, progress=0, submitted=False):
    c = Canvas(font_paths)
    titles = ["Ambient speech arrives", "The ambient prefix is excluded",
              "Jev finds the directed span", "The quiet period completes", "One segment enters chat"]
    details = ["STT keeps advancing. No chat message is submitted.",
               "excludedBefore moves forward; startIndex is still null.",
               "The selected suffix starts at word 4, after the ambient prefix.",
               "New words reset the timer and require a fresh decision.",
               "Only words[4..8] are submitted. The ambient words stay out."]
    c.text((32, 24), "JEVIS  /  FROM ROOM AUDIO TO AGENT INPUT", 13, "mint", 1)
    c.text((32, 52), "Every word is heard. Only the directed span is sent.", 30, kind=1)
    c.text((32, 96), "Mixed fixture illustration · scripted Jev labels · word indices are zero-based", 16, "muted")
    c.box((32, 136, 75, 177), "green", "green", 10)
    c.text((44, 146), f"0{stage + 1}", 20, "mint", 1)
    c.text((90, 137), titles[stage], 23, kind=1)
    c.text((90, 166), details[stage], 17, "muted")

    c.box((32, 207, 1048, 376))
    c.text((52, 223), "SLIDING WINDOW", 13, "muted", 1)
    c.text((745, 223), f"{count} words  /  1 speech region", 14, "muted", 2)
    x = 52
    positions = []
    for i, word in enumerate(WORDS):
        width = c.width(word, 21) + 22
        positions.append((x, width))
        if i < count:
            is_excluded = i < excluded
            selected = directed and i >= 4
            fill = "green" if selected else ("excluded" if is_excluded else "blue_bg")
            c.box((x, 271, x + width, 317), fill, fill, 7)
            c.text((x + 10, 246), str(i), 14, "mint" if selected else "muted", 2)
            c.text((x + 11, 283), word, 21, "mint" if selected else ("faint" if is_excluded else "text"))
            if is_excluded:
                c.line([(x + 9, 295), (x + width - 9, 295)], "faint", 1)
        x += width + 7

    if excluded:
        end = positions[excluded - 1][0] + positions[excluded - 1][1]
        c.line([(52, 328), (52, 334), (end, 334), (end, 328)], "faint")
        c.text((52, 345), f"excludedBefore = {excluded}", 15, "muted", 2)
    if directed:
        start = positions[4][0]
        end = positions[max(count - 1, 4)][0] + positions[max(count - 1, 4)][1]
        c.line([(start, 328), (start, 334), (end, 334), (end, 328)], "mint", 2)
        c.text((start, 345), "startIndex = 4", 15, "mint", 2)
        c.triangle([(start - 8, 281), (start - 8, 305), (start - 1, 293)])
    else:
        c.text((744, 345), "startIndex = null", 15, "muted", 2)

    c.box((32, 396, 363, 565))
    c.text((51, 414), "01 / CONFIDENCE GATE", 13, "muted", 1)
    if directed:
        c.text((51, 445), "DIRECTED", 21, "mint", 1)
        c.text((51, 478), "Choice 96%  +  Boolean 97%", 17)
        c.text((51, 511), "Both pass the 60% defaults.", 16, "muted")
    else:
        pending = count > excluded
        c.text((51, 445), "HOLD" if pending else "AMBIENT", 21, "amber" if pending else "blue", 1)
        c.text((51, 478), "Waiting for a current decision." if pending else "Speech continues; chat stays empty.", 16)
        c.text((51, 511), "Unclear means no permission." if pending else "Ambient words are excluded.", 16, "muted")

    c.box((380, 396, 650, 565))
    c.text((399, 414), "02 / SUBMIT DEBOUNCE", 13, "muted", 1)
    remaining = max(0, round(1500 * (1 - progress)))
    timer = "FIRED" if submitted else (f"{remaining:,} ms" if directed else "NO SUBMIT")
    c.text((399, 445), timer, 24, "mint" if directed else "muted", 1)
    c.text((399, 482), "After the latest word update" if directed else "The timer alone is not enough.", 15, "muted")
    c.box((399, 519, 629, 527), "line", "line", 4)
    if progress > 0:
        c.box((399, 519, 399 + max(8, progress * 230), 527), "mint", "mint", 4)

    c.box((667, 396, 1048, 565))
    c.text((686, 414), "03 / CHAT STREAM", 13, "muted", 1)
    if submitted:
        c.box((686, 442, 1029, 524), "green", "#395948", 8)
        c.text((700, 455), "SUBMITTED  /  words[4..8]", 12, "mint", 1)
        c.text((700, 480), "Could you summarize my notes?", 20)
        c.text((686, 539), "1 message · no ambient prefix", 14, "muted")
    else:
        c.text((686, 453), "No submitted messages", 22, "muted")
        c.text((686, 491), "Raw transcript is not agent input.", 17, "muted")

    c.line([(32, 590), (1048, 590)])
    c.text((32, 608), "FAIL CLOSED", 13, "amber", 1)
    c.text((145, 607), "Unclear, failed or stale decisions cannot authorize a submit.", 16, "muted")
    return c.finish()


def make_gif(font_paths):
    frames, durations = [], []

    def add(stage, count, excluded, directed=False, duration=700, progress=0, submitted=False):
        frames.append(frame(font_paths, stage, count, excluded, directed, progress, submitted))
        durations.append(duration)

    for count in range(1, 5):
        add(0, count, count - 1, duration=250)
        add(0, count, count, duration=250)
    add(1, 4, 4, duration=1500)
    add(1, 5, 4, duration=650)
    add(2, 6, 4, True, duration=700)
    add(2, 7, 4, True, duration=450)
    add(2, 8, 4, True, duration=450)
    for step in range(15):
        add(3, 9, 4, True, duration=100, progress=step / 15)
    add(4, 9, 4, True, duration=3000, progress=1, submitted=True)

    # One shared palette keeps the animation compact and prevents color flicker.
    contact = Image.new("RGB", (270 * 5, 159), C["bg"])
    for i, index in enumerate([0, 4, 6, 12, len(frames) - 1]):
        contact.paste(frames[index].resize((270, 159)), (i * 270, 0))
    palette = contact.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    encoded = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    encoded[0].save(OUT / "sliding-window.gif", save_all=True, append_images=encoded[1:],
                    duration=durations, loop=0, optimize=True, disposal=1)
    frames[-1].save(OUT / "sliding-window-poster.png", optimize=True)


def make_ui_map():
    # Native SVG is crisp in GitHub's image proxy, with no scripts or web fonts.
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="550" viewBox="0 0 1080 550" role="img" aria-labelledby="title desc">',
             '<title id="title">Jevis demo UI panel map</title>',
             '<desc id="desc">A schematic of the local demo: run and stop buttons, Raw transcript and Jev decisions visibility toggles, the Gateway STT model selector, and three panels. Chat is always visible and contains only submitted segments. Raw transcript shows unfiltered speech. Jev decisions shows the window, confidence, and debounce. R and J toggle the inspectors.</desc>',
             '<style>text{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;fill:#ecf1ef}.muted{fill:#9cacae}.mint{fill:#9be2be}.amber{fill:#e8c282}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.label{font-weight:650;letter-spacing:1px}</style>',
             '<rect width="1080" height="550" rx="14" fill="#101519"/>']

    def rect(x, y, w, h, fill="#171e23", stroke="#303c43", radius=9):
        parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')

    def text(x, y, value, size=16, css="", extra=""):
        parts.append(f'<text x="{x}" y="{y}" font-size="{size}" class="{css}" {extra}>{escape(value)}</text>')

    text(28, 30, "JEVIS / SPEECH FILTER LAB", 12, "mint label")
    text(28, 65, "The demo, at a glance", 28, "", 'font-weight="650"')
    text(1052, 35, "UI SCHEMATIC", 12, "muted label", 'text-anchor="end"')
    text(1052, 64, "127.0.0.1:3210", 14, "muted mono", 'text-anchor="end"')
    rect(28, 89, 1024, 114, "#141c20")
    rect(44, 104, 156, 34, "#9be2be", "#9be2be", 6)
    text(57, 126, "Run offline demo", 16, "", 'style="fill:#142a22;font-weight:650"')
    rect(211, 104, 62, 34, "#202a30", radius=6)
    text(226, 126, "Stop", 15, "muted")
    text(291, 126, "Fixture · scripted labels · no keys", 14, "muted")
    text(661, 126, "☑ Raw transcript [R]", 15)
    text(857, 126, "☑ Jev decisions [J]", 15)
    parts.append('<path d="M44 150H1036" stroke="#303c43"/>')
    text(44, 179, "STT model", 14, "muted")
    rect(129, 160, 430, 29, "#202a30", radius=5)
    text(141, 180, "openai/gpt-realtime-whisper  ▾", 15, "mono")
    text(578, 180, "or xai/grok-stt · live Gateway input", 14, "muted")

    rect(28, 223, 315, 262)
    text(45, 246, "A / AGENT INPUT", 11, "muted label")
    text(45, 275, "Chat stream", 23, "", 'font-weight="600"')
    rect(227, 256, 99, 24, "#24362e", "#41514d", 4)
    text(238, 272, "ALWAYS ON", 11, "mint label")
    text(45, 302, "Only gated, debounced submits.", 15, "muted")
    parts.append('<path d="M28 318H343" stroke="#303c43"/>')
    rect(45, 338, 281, 86, "#20332b", "#395948", 8)
    text(59, 360, "SUBMITTED SEGMENT", 11, "mint label")
    text(59, 386, "Could you summarize", 19)
    text(59, 410, "my notes?", 19)
    text(45, 464, "1 submitted message", 14, "mint")

    rect(360, 223, 277, 262)
    text(377, 246, "B / BEFORE THE FILTER", 11, "muted label")
    text(377, 275, "Raw transcript", 23, "", 'font-weight="600"')
    text(377, 302, "Toggle with R", 15, "muted")
    parts.append('<path d="M360 318H637" stroke="#303c43"/>')
    text(377, 346, "We already ate dinner.", 18, "muted")
    text(377, 372, "Could you summarize", 18)
    text(377, 398, "my notes?", 18)
    text(377, 442, "Partial + final STT events", 14, "muted")
    text(377, 464, "Includes ambient speech", 14, "muted")

    rect(654, 223, 398, 262)
    text(671, 246, "C / INSIDE THE FILTER", 11, "muted label")
    text(671, 275, "Jev decisions", 23, "", 'font-weight="600"')
    text(671, 302, "Toggle with J", 15, "muted")
    parts.append('<path d="M654 318H1052" stroke="#303c43"/>')
    rect(671, 332, 364, 38, "#11191d", "#304047", 6)
    text(684, 356, "startIndex 4 · excludedBefore 4", 15, "mint mono")
    text(671, 396, "Choice + Boolean → confidence gate", 16)
    text(671, 427, "Submit debounce", 14, "muted")
    text(1035, 427, "1,500 ms", 14, "mint mono", 'text-anchor="end"')
    rect(671, 437, 364, 4, "#2d3c43", "#2d3c43", 2)
    rect(671, 437, 255, 4, "#9be2be", "#9be2be", 2)
    text(671, 466, "Candidate history · scores · stale counts", 14, "muted")
    text(28, 520, "Chat stays visible. Inspectors can be hidden independently.", 15, "muted")
    text(1052, 520, "Schematic, not a screenshot", 13, "muted", 'text-anchor="end"')
    parts.append('</svg>')
    (OUT / "ui-panel-map.svg").write_text("\n".join(parts) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--font-dir", help="Optional folder containing Arial or DejaVu Sans fonts")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    make_gif(find_fonts(args.font_dir))
    make_ui_map()
    for name in ["sliding-window.gif", "sliding-window-poster.png", "ui-panel-map.svg"]:
        path = OUT / name
        size = path.stat().st_size
        if size >= 1_500_000:
            raise SystemExit(f"Asset exceeds 1.5 MB budget: {path}")
        print(f"{path.relative_to(ROOT)}: {size:,} bytes")


if __name__ == "__main__":
    main()
