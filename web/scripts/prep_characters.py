"""Turn cut-out character art into the scene's 8-bit sprites.

    python3 web/scripts/prep_characters.py SRC_DIR

SRC_DIR holds full-size transparent PNGs named like the sprites (player.png,
main_agent.png, reviewer.png, vendor1-3.png). Each is trimmed to its figure,
crushed onto a coarse pixel grid with a small palette, hard edges and a dark
1px outline (8-bit look), blown back up with nearest-neighbour, and padded below so the feet land
where Scene.person() anchors them (anchor y 0.94). Output goes to
public/art/characters/.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "public" / "art" / "characters"
FEET = 0.94  # Scene.person() anchor
PIXEL = 3  # screen px per art pixel, before PEOPLE_SCALE
COLORS = 20  # palette size per sprite
OUTLINE = (38, 24, 18, 255)
HEIGHT = {  # figure height in art pixels, outline excluded
    "player": 46,
    "main_agent": 52,  # the captain stands a head taller than the crew
    "reviewer": 47,
    "vendor1": 46,
    "vendor2": 47,
    "vendor3": 45,
}


def outline(img: Image.Image) -> Image.Image:
    """Ring the silhouette with a 1px dark border (4-neighbour)."""
    out = Image.new("RGBA", (img.width + 2, img.height + 2), (0, 0, 0, 0))
    out.paste(img, (1, 1))
    src, px = out.copy().load(), out.load()
    for y in range(out.height):
        for x in range(out.width):
            if src[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < out.width and 0 <= ny < out.height and src[nx, ny][3]:
                    px[x, y] = OUTLINE
                    break
    return out


def prep(src: Path, height: int) -> Image.Image:
    img = Image.open(src).convert("RGBA")
    img = img.crop(img.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox())
    width = max(1, round(img.width * height / img.height))
    small = img.resize((width, height), Image.BOX)
    solid = small.getchannel("A").point(lambda a: 255 if a >= 128 else 0)  # hard 1-bit edges
    rgb = small.convert("RGB").quantize(COLORS, method=Image.Quantize.MEDIANCUT).convert("RGB")
    small = rgb.convert("RGBA")
    small.putalpha(solid)
    small = outline(small)
    big = small.resize((small.width * PIXEL, small.height * PIXEL), Image.NEAREST)
    canvas = Image.new("RGBA", (big.width, round(big.height / FEET)), (0, 0, 0, 0))
    canvas.paste(big, (0, 0), big)
    return canvas


def main() -> None:
    src_dir = Path(sys.argv[1])
    for name, height in HEIGHT.items():
        out = prep(src_dir / f"{name}.png", height)
        out.save(OUT / f"{name}.png", optimize=True)
        print(f"{name}: {out.width}x{out.height}")


if __name__ == "__main__":
    main()
