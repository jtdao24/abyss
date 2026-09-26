"""Turn art/market_reference.png into the live scene's assets.

- Removes the baked-in fake bid bubbles and the checkmark bubble (the live
  scene draws real ones) and fills the sand back in.
- Cuts one crate-carrying courier out as a transparent sprite and removes it
  from the background, so the scene can walk it between stalls.

    python3 art/prepare_scene.py
Also declutters the plaza (passers-by, stepping stones, scattered shells),
lays stone walkways between the stalls, replaces the busy bottom row with
clean stone and plants a row of palm trees along it.

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

# Plaza clutter sitting on plain sand: filled with sand.
CLUTTER_BOXES = [
    (585, 955, 690, 1078),     # man with scroll
    (655, 1055, 930, 1265),    # walking girl + stepping stones
    (440, 1130, 515, 1198),    # starfish by the dock
    (622, 1200, 684, 1266),    # starfish by the pond
    (668, 1262, 716, 1310),    # gem
    (688, 1310, 820, 1384),    # shells
    (1140, 960, 1285, 1110),   # girl with pearl
    (1778, 1310, 2045, 1392),  # painted "Task Delivery" label (the scene draws its own)
    (2190, 1095, 2220, 1175),  # sparkles left by the stepping stones
    (1060, 1172, 1200, 1322),  # kid with shell
    (2000, 1050, 2200, 1235),  # stepping stones (right)
    (2040, 830, 2110, 920),    # crate between the cheap stalls
    (2372, 1150, 2448, 1218),  # starfish on the pond rim
    (2218, 1226, 2278, 1290),  # gem
    (2080, 1296, 2262, 1385),  # shells and coral
]
# Clutter straddling the sand/stone edge: replaced by the rows just below it.
PATCH_FROM_BELOW = [((1550, 1075, 1680, 1212), 140)]  # the second courier
# Passers-by on the upper stone walkway: replaced by stone from beside them.
PATCH_FROM_SIDE = [((852, 438, 910, 548), 110), ((2448, 460, 2508, 592), -110)]
# The central stone walkway: its left edge strip and plain interior are the
# texture for new walkways and the bottom band.
EDGE_STRIP = (1278, 1050, 1304, 1370)
STONE_TILE = (1304, 1050, 1550, 1370)
LANES = [(922, 1032), (1990, 2100)]  # x ranges between vendor 1|2 and 3|4
LANE_Y = (745, 1404)
BOTTOM_BAND = (380, 1404, 2690, 1536)
ROOF_FIX = ((2120, 1372, 2500, 1404), -380)  # red roof poking into the plaza
# Palm to clone (top-left of the art) and where to plant copies: (base x, base y, scale, mirror).
PALM_BOX = (270, 25, 480, 348)
PALMS = [(470, 1536, 0.95, False), (1180, 1530, 1.0, True), (1440, 1536, 0.9, False),
         (2130, 1534, 1.0, True), (2560, 1536, 0.92, False)]


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


def tile(src: np.ndarray, h: int, w: int) -> np.ndarray:
    reps = (-(-h // src.shape[0]), -(-w // src.shape[1]), 1)
    return np.tile(src, reps)[:h, :w]


def palm_sprite(img: np.ndarray) -> np.ndarray:
    """Cut the palm out of its sky/sea/sand background as RGBA."""
    x0, y0, x1, y1 = PALM_BOX
    box = img[y0:y1, x0:x1]
    r, g, b = box[..., 0], box[..., 1], box[..., 2]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    frond = (g > r + 10) & (g > b + 18)
    outline = lum < 70
    trunk = (r > g) & (g > b) & (r - b > 45) & (lum < 170)
    palm = frond | outline | trunk
    yy, xx = np.mgrid[0:box.shape[0], 0:box.shape[1]]
    palm &= ~((yy > 150) & (xx > 118))                # "HAPPY FISH" sign and thatch
    palm &= ~((yy > 140) & (yy < 228) & (xx < 72))    # bunting string
    palm &= ~((yy > 230) & (xx < 45))                 # surfboard
    palm &= ~((yy > 185) & (xx > 103))                # thatch edge beside the trunk
    palm &= ~(yy > 314)                               # sand line at the foot
    body = flood(palm, (110, 55))                     # a frond near the crown
    padded = np.pad(~body, 1, constant_values=True)
    body = ~flood(padded, (0, 0))[1:-1, 1:-1]
    return np.dstack([box, body * 255.0])


def paste(img: np.ndarray, sprite: np.ndarray, base_x: int, base_y: int, scale: float, mirror: bool) -> None:
    pil = Image.fromarray(sprite.astype(np.uint8), "RGBA")
    if mirror:
        pil = pil.transpose(Image.FLIP_LEFT_RIGHT)
    pil = pil.resize((round(pil.width * scale), round(pil.height * scale)), Image.NEAREST)
    arr = np.asarray(pil).astype(float)
    h, w = arr.shape[:2]
    x0, y0 = base_x - w // 2, base_y - h
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(img.shape[1], x0 + w), min(img.shape[0], y0 + h)
    region = arr[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    alpha = region[..., 3:4] / 255.0
    # soft shadow under the trunk
    sy, sx = base_y - 6, base_x
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    shadow = (((xx - sx) / 46.0) ** 2 + ((yy - sy) / 12.0) ** 2) < 1
    img[shadow] *= 0.72
    img[cy0:cy1, cx0:cx1] = img[cy0:cy1, cx0:cx1] * (1 - alpha) + region[..., :3] * alpha


def landscape(img: np.ndarray, sand: np.ndarray, rng: np.random.Generator) -> None:
    for x0, y0, x1, y1 in CLUTTER_BOXES:
        img[y0:y1, x0:x1] = sand + rng.integers(-2, 3, size=(y1 - y0, x1 - x0, 1))
    for (x0, y0, x1, y1), dy in PATCH_FROM_BELOW:
        img[y0:y1, x0:x1] = img[y0 + dy:y1 + dy, x0:x1]
    for (x0, y0, x1, y1), dx in PATCH_FROM_SIDE:
        img[y0:y1, x0:x1] = img[y0:y1, x0 + dx:x1 + dx]
    palm = palm_sprite(img)  # cut before the bottom band changes anything

    ex0, ey0, ex1, ey1 = EDGE_STRIP
    edge = img[ey0:ey1, ex0:ex1].copy()
    sx0, sy0, sx1, sy1 = STONE_TILE
    stone = img[sy0:sy1, sx0:sx1].copy()

    (rx0, ry0, rx1, ry1), dx = ROOF_FIX
    img[ry0:ry1, rx0:rx1] = img[ry0:ry1, rx0 + dx:rx1 + dx]

    bx0, by0, bx1, by1 = BOTTOM_BAND
    img[by0:by1, bx0:bx1] = tile(stone, by1 - by0, bx1 - bx0)

    ly0, ly1 = LANE_Y
    ew = edge.shape[1]
    for lx0, lx1 in LANES:
        h = ly1 - ly0
        img[ly0:ly1, lx0:lx1] = tile(stone, h, lx1 - lx0)
        img[ly0:ly1, lx0:lx0 + ew] = tile(edge, h, ew)
        img[ly0:ly1, lx1 - ew:lx1] = tile(edge[:, ::-1], h, ew)

    for base_x, base_y, scale, mirror in PALMS:
        paste(img, palm, base_x, base_y, scale, mirror)


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
    landscape(img, sand, rng)
    Image.fromarray(img.clip(0, 255).astype(np.uint8), "RGB").save(OUT / "market.png", optimize=True)
    print(f"wrote {OUT / 'market.png'} and {OUT / 'courier.png'} ({x1 - x0}x{y1 - y0})")


if __name__ == "__main__":
    main()
