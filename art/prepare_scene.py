"""Turn art/market_reference.png into the live scene's assets.

- Removes the baked-in fake bid bubbles and the checkmark bubble (the live
  scene draws real ones) and fills the sand back in.
- Cuts one crate-carrying courier out as a transparent sprite and removes it
  from the background, so the scene can walk it between stalls.

    python3 art/prepare_scene.py
Writes web/public/art/market.png and web/public/art/courier.png.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "art" / "market_reference.png"
OUT = ROOT / "web" / "public" / "art"

# Speech bubbles to remove, as boxes (x0, y0, x1, y1) in source pixels. Their
# text splits the white interior, so whole boxes (plus border and tail) go.
# Boxes hug each bubble's outline; tails get their own small boxes so nothing
# touches the characters standing just below.
BUBBLE_BOXES = [
    (695, 1001, 1080, 1069), (872, 1066, 903, 1079),     # "Bid: 0.05 tokens | Qual: 95"
    (943, 1104, 1253, 1172), (1090, 1168, 1121, 1186),   # "Bid: 0.12 ... | Qual: 91"
    (1879, 1027, 2004, 1159), (1926, 1155, 1956, 1164),  # checkmark over Task Delivery
]
# Courier to cut out: a box around it, and a point on its body.
COURIER_BOX = (1640, 986, 1748, 1112)
SAND_SAMPLE = (1780, 1060)


def flood(mask: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    x0, y0 = seed
    out = np.zeros_like(mask)
    if not mask[y0, x0]:
        raise ValueError(f"seed {seed} is not inside the region")
    queue = deque([(y0, x0)])
    out[y0, x0] = True
    h, w = mask.shape
    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                queue.append((ny, nx))
    return out


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        grown = out.copy()
        grown[1:, :] |= out[:-1, :]
        grown[:-1, :] |= out[1:, :]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        out = grown
    return out


def fill(img: np.ndarray, mask: np.ndarray) -> None:
    """Onion-peel fill: each masked pixel takes the mean of its known neighbours."""
    known = ~mask
    img[mask] = 0
    while not known.all():
        acc = np.zeros(img.shape, dtype=float)
        cnt = np.zeros(mask.shape, dtype=float)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            shifted_known = np.roll(known, (dy, dx), axis=(0, 1))
            shifted_img = np.roll(img, (dy, dx), axis=(0, 1))
            acc += shifted_img * shifted_known[..., None]
            cnt += shifted_known
        frontier = (~known) & (cnt > 0)
        if not frontier.any():
            break
        img[frontier] = acc[frontier] / cnt[frontier][:, None]
        known |= frontier


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img = np.asarray(Image.open(SRC).convert("RGB")).astype(float)

    # 1. courier sprite: everything in its box that isn't sand, connected to its body
    x0, y0, x1, y1 = COURIER_BOX
    box = img[y0:y1, x0:x1]
    sand = img[SAND_SAMPLE[1], SAND_SAMPLE[0]]
    not_sand = np.linalg.norm(box - sand, axis=2) > 12  # sand varies by only ~2
    body = flood(not_sand, (1690 - x0, 1040 - y0))
    # fill holes: anything not reachable from the box edge through sand is body
    outside = np.zeros_like(body)
    padded = np.pad(~body, 1, constant_values=True)
    outside = flood(padded, (0, 0))[1:-1, 1:-1]
    body = ~outside
    body[90:, :32] = False  # the neighbouring courier's head pokes into this corner
    rgba = np.dstack([box, body * 255.0]).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(OUT / "courier.png")

    # 2. background: remove bubbles and the courier, fill with sand
    mask = np.zeros(img.shape[:2], dtype=bool)
    for bx0, by0, bx1, by1 in BUBBLE_BOXES:
        pad = 3 if (bx1 - bx0) > 60 else 0  # soft bubble borders bleed ~3px; tails sit near heads
        mask[by0 - pad:by1 + pad, bx0 - pad:bx1 + pad] = True
    courier_full = np.zeros_like(mask)
    courier_full[y0:y1, x0:x1] = body
    mask |= dilate(courier_full, 4)
    # The plaza sand is one flat colour, so fill with it (plus faint grain);
    # averaging neighbours would smear characters' colours into the gap.
    rng = np.random.default_rng(7)
    img[mask] = sand + rng.integers(-2, 3, size=(int(mask.sum()), 1))
    Image.fromarray(img.clip(0, 255).astype(np.uint8), "RGB").save(OUT / "market.png", optimize=True)
    print(f"wrote {OUT / 'market.png'} and {OUT / 'courier.png'} ({x1 - x0}x{y1 - y0})")


if __name__ == "__main__":
    main()
