"""Turn art/market_reference.png into the live scene's assets.

    python3 art/prepare_scene.py

Steps (all coordinates are source pixels of the 2816x1536 reference):
1. Cut sprites from the untouched art: the crate courier and the player.
2. Remove baked-in UI (fake bid bubbles, checkmark, "Task Delivery" label),
   passers-by and scattered clutter from the plaza.
3. Remove the unused shops along the beach and rebuild sea, shoreline and
   beach behind them; remove the empty fourth stall and the right-edge clutter.
4. Turn brick walkways into sand: yards keep the plaza sand, former walkways
   become lighter trodden-sand paths, and paths run between the stalls.
5. Plant palm trees.

Writes web/public/art/market.png, courier.png and player.png.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "art" / "market_reference.png"
OUT = ROOT / "web" / "public" / "art"

SAND_SAMPLE = (1780, 1060)              # plaza sand, very uniform (+-2)
GROUND = np.array([226.0, 190.0, 138.0])  # one warm sand for the whole plaza
WALK = np.array([240.0, 212.0, 162.0])    # lighter, trodden sand for walkways
SHORE_COL = 1425                          # a clean column: sea, foam, wet sand, beach

# Sprites: (box, seed on the body, rows/cols to drop as (y_from, x_to) corner or None)
# (box, seed on the body, sand distance threshold)
COURIER = ((1640, 986, 1748, 1112), (1690, 1040), 12)
PLAYER = ((836, 1079, 934, 1212), (885, 1140), 20)  # 20 drops the pale stepping stones behind her

# Painted "Vendor" signs: their white text and black outline go (plates replace them).
LABEL_BOXES = [(476, 928, 828, 984), (983, 928, 1342, 984), (1663, 928, 1968, 984), (2099, 928, 2414, 984)]
# Speech bubbles and labels to remove; tails get their own boxes so nothing
# touches the characters standing just below.
UI_BOXES = [
    (692, 998, 1083, 1072), (872, 1066, 903, 1079),     # "Bid: 0.05 tokens | Qual: 95"
    (940, 1101, 1256, 1175), (1090, 1168, 1121, 1186),  # "Bid: 0.12 ... | Qual: 91"
    (1876, 1024, 2007, 1162), (1926, 1155, 1956, 1164), # checkmark over Task Delivery
    (1778, 1310, 2045, 1392),                            # painted "Task Delivery" label
]
# Clutter on plain plaza sand.
CLUTTER_BOXES = [
    (585, 955, 690, 1078),     # man with scroll
    (655, 1055, 935, 1265),    # walking girl (becomes the player) + stepping stones
    (440, 1130, 515, 1198),    # starfish by the dock
    (622, 1200, 684, 1266),    # starfish by the pond
    (668, 1262, 716, 1310),    # gem
    (688, 1310, 820, 1384),    # shells
    (1140, 960, 1285, 1110),   # girl with pearl
    (1060, 1172, 1200, 1322),  # kid with shell
    (2000, 1050, 2220, 1235),  # stepping stones and sparkles (right)
    (2040, 830, 2110, 920),    # crate between the cheap stalls
    (2372, 1150, 2448, 1218),  # starfish on the pond rim
    (2218, 1226, 2278, 1290),  # gem
    (2080, 1296, 2262, 1385),  # shells and coral
]
# The second courier straddles the sand/stone edge: patch from the rows below.
PATCH_FROM_BELOW = [((1550, 1075, 1680, 1212), 140)]

# Beach strip: shops between sea and promenade are replaced by rebuilt sea and
# sand. KEEP boxes (dolphin, fish, Tasks Hub) are left untouched.
BEACH_REBUILD = (210, 128, 2816, 540)
BEACH_KEEP = [(1255, 128, 1428, 258), (1538, 128, 1692, 248), (1372, 336, 1728, 660)]
SEA_SAMPLE_COLS = [*range(1215, 1250), *range(1430, 1535)]
SHORE_TOP = 262        # rows from here down follow SHORE_COL, with a wavy offset
PROMENADE_Y = 400      # below this the rebuilt strip is plaza ground
# Other removals, filled with plaza ground.
REMOVE = [
    (2100, 600, 2445, 988),    # empty fourth stall and its sign
    (1960, 625, 2012, 752),    # torch between the stalls
    (2425, 470, 2816, 1072),   # fruit stand, table, crabs, passer-by on the right
    (380, 1398, 2690, 1536),   # busy bottom row (awnings, hut, people)
    (2120, 1372, 2500, 1398),  # red roof poking into the plaza
    (185, 380, 430, 540),      # barrels and surfboards by the dock
]
# Brick becomes sand everywhere below the beach, except inside these boxes.
BRICK_Y = 395
PROTECT = [
    (0, 0, 185, 1536),         # ship
    (0, 1000, 180, 1150),      # cannon
    (425, 1192, 632, 1375),    # left pond
    (2248, 1236, 2458, 1378),  # right pond
    (1788, 1150, 1995, 1305),  # officer, table and orb
    (2528, 1160, 2640, 1278),  # inspection chest
    (420, 770, 525, 895),      # grey cabinet by the captain
]
# Old plaza edges thick enough to survive erase_thin_lines: (band, boxes to skip).
EDGE_BANDS = [
    ((1585, 760, 1625, 1405), []),
    ((1270, 990, 1310, 1405), []),
    ((420, 735, 2460, 772), [(500, 0, 925, 9999), (1045, 0, 1345, 9999), (1600, 0, 1965, 9999)]),
    ((380, 1368, 2690, 1412), [(420, 0, 636, 9999), (2244, 0, 2462, 9999)]),
    ((925, 685, 995, 725), []), ((1995, 660, 2065, 725), []),  # orange sparkle specks
]
# Walkways (x0, y0, x1, y1): between the stalls, and a main street in front of them.
WALKWAYS = [(930, 740, 1030, 1536), (1995, 740, 2095, 1536), (240, 1004, 2720, 1088)]
WALK_EDGE = 7  # px of soft blend at each walkway edge

PALM_BOX = (270, 25, 480, 348)
# (base x, base y, scale, mirror)
PALMS = [
    (372, 350, 1.0, False), (2365, 352, 1.02, True), (1300, 505, 0.85, False),
    (1800, 505, 0.85, True), (2275, 925, 1.0, False), (2455, 905, 0.8, True),
    (2760, 845, 1.0, True), (470, 1536, 0.95, False), (1180, 1530, 1.0, True),
    (1440, 1536, 0.9, False), (2130, 1534, 1.0, True), (2560, 1536, 0.92, False),
]


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


def fill_holes(body: np.ndarray) -> np.ndarray:
    padded = np.pad(~body, 1, constant_values=True)
    return ~flood(padded, (0, 0))[1:-1, 1:-1]


def cut_sprite(img: np.ndarray, sand: np.ndarray, spec, name: str) -> np.ndarray:
    """Key a character off plain sand. Returns its mask in full-image coords."""
    (x0, y0, x1, y1), (sx, sy), threshold = spec
    box = img[y0:y1, x0:x1]
    not_sand = np.linalg.norm(box - sand, axis=2) > threshold
    body = fill_holes(flood(not_sand, (sx - x0, sy - y0)))
    if name == "player":
        body[:, :17] = False  # edge of a stepping stone left of her arm
    Image.fromarray(np.dstack([box, body * 255.0]).astype(np.uint8), "RGBA").save(OUT / f"{name}.png")
    full = np.zeros(img.shape[:2], dtype=bool)
    full[y0:y1, x0:x1] = body
    return full


def palm_sprite(img: np.ndarray) -> np.ndarray:
    """Cut the top-left palm out of its sky/sea/sand background as RGBA."""
    x0, y0, x1, y1 = PALM_BOX
    box = img[y0:y1, x0:x1]
    r, g, b = box[..., 0], box[..., 1], box[..., 2]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    palm = ((g > r + 10) & (g > b + 18)) | (lum < 70) | ((r > g) & (g > b) & (r - b > 45) & (lum < 170))
    yy, xx = np.mgrid[0:box.shape[0], 0:box.shape[1]]
    palm &= ~((yy > 150) & (xx > 118))                # "HAPPY FISH" sign and thatch
    palm &= ~((yy > 140) & (yy < 228) & (xx < 72))    # bunting string
    palm &= ~((yy > 230) & (xx < 45))                 # surfboard
    palm &= ~((yy > 185) & (xx > 103))                # thatch edge beside the trunk
    palm &= ~(yy > 314)                               # sand line at the foot
    body = fill_holes(flood(palm, (110, 55)))
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
    yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    shadow = (((xx - base_x) / 46.0) ** 2 + ((yy - (base_y - 6)) / 12.0) ** 2) < 1
    img[shadow] *= 0.78
    img[cy0:cy1, cx0:cx1] = img[cy0:cy1, cx0:cx1] * (1 - alpha) + region[..., :3] * alpha


def grain(rng: np.random.Generator, shape: tuple[int, ...]) -> np.ndarray:
    return rng.integers(-3, 4, size=(*shape, 1))


def rebuild_beach(img: np.ndarray, original: np.ndarray, rng: np.random.Generator) -> None:
    x0, y0, x1, y1 = BEACH_REBUILD
    rows = np.median(original[:, SEA_SAMPLE_COLS], axis=1)  # per-row sea colour
    rows[SHORE_TOP:PROMENADE_Y] = np.median(original[SHORE_TOP:PROMENADE_Y, SHORE_COL:SHORE_COL + 6], axis=1)
    keep = np.zeros(img.shape[:2], dtype=bool)
    for kx0, ky0, kx1, ky1 in BEACH_KEEP:
        keep[ky0:ky1, kx0:kx1] = True
    xs = np.arange(x0, x1)
    wave = np.round(6 * np.sin(xs / 41.0) + 3 * np.sin(xs / 13.0 + 1.3)).astype(int)
    for y in range(y0, y1):
        if y >= PROMENADE_Y:
            line = GROUND + grain(rng, (x1 - x0,))
        elif y >= SHORE_TOP:
            src = np.clip(y - wave, y0, PROMENADE_Y - 1)  # wavy shoreline
            line = rows[src]
        else:
            line = np.repeat(rows[y][None, :], x1 - x0, axis=0)
        target = ~keep[y, x0:x1]
        img[y, x0:x1][target] = line[target]
    # sparkles on the water: short light dashes
    sparkle = rows[140] + 60
    for _ in range(90):
        sx = int(rng.integers(x0, x1 - 12))
        sy = int(rng.integers(y0 + 6, SHORE_TOP - 10))
        if not keep[sy, sx:sx + 12].any():
            img[sy, sx:sx + int(rng.integers(5, 12))] = np.clip(sparkle, 0, 255)


def brick_to_sand(img: np.ndarray, yard: np.ndarray, rng: np.random.Generator) -> None:
    """Brick, walkway edges and the old plaza sand all become one ground sand."""
    rgb = img[BRICK_Y:]
    spread = rgb.max(axis=2) - rgb.min(axis=2)
    lum = rgb @ np.array([0.3, 0.59, 0.11])
    brick = (spread < 34) & (lum > 55) & (lum < 225)
    # The brown line that edges every walkway goes too; the path edge is redrawn.
    border = (np.abs(rgb - np.array([147.0, 114.0, 99.0])).max(axis=2) < 16)
    mask = np.zeros(img.shape[:2], dtype=bool)
    mask[BRICK_Y:] = brick | border
    for px0, py0, px1, py1 in PROTECT:
        mask[py0:py1, px0:px1] = False
    # Flat sand (old plaza yards, the old beach strip behind the stalls) is safe
    # to recolour everywhere, protected boxes included.
    old_yard = np.abs(rgb - yard).max(axis=2) < 8
    old_beach = (np.abs(rgb - np.array([246.0, 202.0, 118.0])).max(axis=2) < 22)
    old_beach[: max(0, 540 - BRICK_Y)] = False  # the real beach stays yellow
    mask[BRICK_Y:] |= old_yard | old_beach
    img[mask] = GROUND + grain(rng, (int(mask.sum()),))


def box_mean(mask: np.ndarray, r: int) -> np.ndarray:
    """Fraction of True pixels in the (2r+1)^2 window around each pixel."""
    c = np.pad(mask.astype(float), r).cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def erase_thin_lines(img: np.ndarray, rng: np.random.Generator) -> None:
    """Ghost outlines of the old plaza (1-2px lines) and specks surrounded by
    sand become sand. Solid objects, even 3px stall posts, are dense enough to stay."""
    for _ in range(2):
        ground = np.abs(img - GROUND).max(axis=2) < 7
        stray = (~ground) & (box_mean(ground, 3) > 0.66)
        stray[:540] = False
        for px0, py0, px1, py1 in PROTECT:
            stray[py0:py1, px0:px1] = False
        img[stray] = GROUND + grain(rng, (int(stray.sum()),))


def clear_edge_bands(img: np.ndarray, rng: np.random.Generator) -> None:
    for (x0, y0, x1, y1), skips in EDGE_BANDS:
        band = np.abs(img[y0:y1, x0:x1] - GROUND).max(axis=2) >= 7
        for sx0, _, sx1, _ in skips:
            band[:, max(0, sx0 - x0):max(0, sx1 - x0)] = False
        img[y0:y1, x0:x1][band] = GROUND + grain(rng, (int(band.sum()),))


def paint_walkways(img: np.ndarray, rng: np.random.Generator) -> None:
    """Lighter trodden sand with soft edges, only over plain ground (never objects)."""
    ground = np.abs(img - GROUND).max(axis=2) < 6
    weight = np.zeros(img.shape[:2])
    for x0, y0, x1, y1 in WALKWAYS:
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.minimum.reduce([xx - x0, x1 - 1 - xx, yy - y0, y1 - 1 - yy]).astype(float)
        weight[y0:y1, x0:x1] = np.maximum(weight[y0:y1, x0:x1], np.clip((d + 1) / WALK_EDGE, 0, 1))
    weight *= ground
    walk = WALK + grain(rng, img.shape[:2])
    img[:] = img * (1 - weight[..., None]) + walk * weight[..., None]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    original = np.asarray(Image.open(SRC).convert("RGB")).astype(float)
    img = original.copy()
    yard = original[SAND_SAMPLE[1], SAND_SAMPLE[0]]
    rng = np.random.default_rng(7)

    # 1. sprites (from untouched art)
    courier = cut_sprite(original, yard, COURIER, "courier")
    cut_sprite(original, yard, PLAYER, "player")
    palm = palm_sprite(original)

    # 2. UI, courier and plaza clutter -> plaza sand
    mask = dilate(courier, 4)
    lum = original @ np.array([0.3, 0.59, 0.11])
    for x0, y0, x1, y1 in LABEL_BOXES:
        text_px = (lum[y0:y1, x0:x1] > 225) | (lum[y0:y1, x0:x1] < 50)
        mask[y0:y1, x0:x1] |= dilate(text_px, 1)
    for x0, y0, x1, y1 in UI_BOXES + CLUTTER_BOXES:
        mask[y0:y1, x0:x1] = True
    img[mask] = yard + grain(rng, (int(mask.sum()),))
    for (x0, y0, x1, y1), dy in PATCH_FROM_BELOW:
        img[y0:y1, x0:x1] = img[y0 + dy:y1 + dy, x0:x1]

    # 3. beach shops, empty stall, right-edge clutter, bottom row
    rebuild_beach(img, original, rng)
    for x0, y0, x1, y1 in REMOVE:
        img[y0:y1, x0:x1] = GROUND + grain(rng, (y1 - y0, x1 - x0))

    # 4. brick -> sand, walkways between stalls
    brick_to_sand(img, yard, rng)
    erase_thin_lines(img, rng)
    clear_edge_bands(img, rng)
    paint_walkways(img, rng)

    # 5. palms, back to front
    for base_x, base_y, scale, mirror in sorted(PALMS, key=lambda p: p[1]):
        paste(img, palm, base_x, base_y, scale, mirror)

    Image.fromarray(img.clip(0, 255).astype(np.uint8), "RGB").save(OUT / "market.png", optimize=True)
    print(f"wrote market.png, courier.png, player.png to {OUT}")


if __name__ == "__main__":
    main()
