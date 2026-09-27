"""Derive the ambient-animation data from public/art/boardwalk.png.

    python3 web/scripts/make_ambient.py

Writes, next to the art:
  boardwalk_water.png    alpha mask of the sea (the scene ripples it)
  boardwalk_foliage.png  alpha mask of palms and bushes (the scene sways it)
  boardwalk_ambient.json water glint spots and lantern positions
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

ART = Path(__file__).resolve().parents[1] / "public" / "art"
BOAT = [(520, 460, 725, 725), (438, 668, 862, 856)]  # sail and hull boxes
AWNINGS = [(322, 245, 552, 345), (732, 245, 952, 345), (1138, 245, 1368, 345)]  # blue stripes aren't sea
FOLIAGE_MAX_Y = 470
# Lantern glass shares its orange with sunlit planks, so the ~18 lanterns are listed by hand.
LANTERNS = [
    (60, 262), (174, 55), (71, 169), (195, 169), (187, 262), (287, 226), (569, 283), (720, 268), (1111, 274),
    (1493, 244), (1511, 152), (1647, 314), (77, 460), (347, 492), (548, 498), (1167, 506),
    (1637, 480), (36, 800), (364, 800),
]


def save_mask(mask: np.ndarray, name: str) -> None:
    alpha = (mask * 255).astype(np.uint8)
    rgba = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha])
    Image.fromarray(rgba, "RGBA").save(ART / name, optimize=True)


def main() -> None:
    img = np.asarray(Image.open(ART / "boardwalk.png").convert("RGB")).astype(int)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]

    water = (b > r + 60) & (b > 110)
    for x0, y0, x1, y1 in AWNINGS:
        water[y0:y1, x0:x1] = False
    for x0, y0, x1, y1 in BOAT:  # inside the boat keep only true sea (red ~0), not the blue paint
        water[y0:y1, x0:x1] &= r[y0:y1, x0:x1] < 12
    save_mask(water, "boardwalk_water.png")

    foliage = (g > r + 15) & (g > b + 15) & (b < 110)  # leaves have little blue; shallow water does
    foliage[FOLIAGE_MAX_Y:] = False
    save_mask(foliage, "boardwalk_foliage.png")

    rng = np.random.default_rng(3)
    ys, xs = np.nonzero(water)
    pick = rng.choice(len(xs), size=260, replace=False)
    glints = [[int(xs[i]), int(ys[i])] for i in pick]

    lanterns = [list(p) for p in LANTERNS]

    (ART / "boardwalk_ambient.json").write_text(json.dumps({"glints": glints, "lanterns": lanterns}) + "\n")
    print(f"water {water.mean():.0%} of pixels, foliage {foliage.mean():.0%}, {len(lanterns)} lanterns")


if __name__ == "__main__":
    main()
