#!/usr/bin/env python3
"""Makes the app icons from one square, full-bleed source image: by
default the vector source, app/build/icon.svg.

    app/scripts/make-icons.py [source.svg | source.png]

Writes:
  app/build/icon.png            1024px macOS icon: the artwork in Apple's
                                rounded-square shape, inset on the standard
                                grid with a soft shadow. electron-builder
                                turns it into the .icns.
  app/build/icons/<n>x<n>.png   the same shape at Linux icon sizes.
  docs/images/icon.png          256px, for the top of the README.

Needs Pillow, and rsvg-convert (librsvg) for an SVG source.
"""

import io
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
CANVAS = 1024
# Apple's macOS icon grid: an 824px shape centered on the 1024px canvas.
SHAPE = 824
# A superellipse this steep is close to Apple's continuous-corner square.
EXPONENT = 5
LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def squircle_mask(size: int, supersample: int = 4) -> Image.Image:
    big = size * supersample
    mask = Image.new("L", (big, big), 0)
    r = big / 2
    points = []
    steps = 2000
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / EXPONENT), c)
        y = r + r * math.copysign(abs(s) ** (2 / EXPONENT), s)
        points.append((x, y))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def shaped(source: Image.Image) -> Image.Image:
    """The artwork cut to the rounded-square shape, SHAPE pixels across."""
    art = source.convert("RGBA").resize((SHAPE, SHAPE), Image.LANCZOS)
    art.putalpha(ImageChops.multiply(art.getchannel("A"), squircle_mask(SHAPE)))
    return art


def macos_icon(art: Image.Image) -> Image.Image:
    mask = art.getchannel("A")
    offset = (CANVAS - SHAPE) // 2
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_alpha = Image.new("L", (CANVAS, CANVAS), 0)
    shadow_alpha.paste(mask.point(lambda a: a * 0.3), (offset, offset + 10))
    shadow.putalpha(shadow_alpha.filter(ImageFilter.GaussianBlur(12)))

    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    icon.alpha_composite(shadow)
    icon.alpha_composite(art, (offset, offset))
    return icon


def load(path: Path) -> Image.Image:
    if path.suffix == ".svg":
        png = subprocess.run(
            ["rsvg-convert", "-w", str(CANVAS), "-h", str(CANVAS), str(path)], check=True, capture_output=True
        ).stdout
        return Image.open(io.BytesIO(png))
    return Image.open(path)


def main() -> None:
    if len(sys.argv) > 2:
        sys.exit(__doc__)
    source = load(Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "app" / "build" / "icon.svg")
    if source.width != source.height:
        sys.exit(f"the source should be square; it's {source.width}x{source.height}")

    art = shaped(source)
    icon = macos_icon(art)
    build = ROOT / "app" / "build"
    (build / "icons").mkdir(parents=True, exist_ok=True)
    icon.save(build / "icon.png")
    # Linux icons drop the macOS margin and shadow: the shape fills its square.
    for n in LINUX_SIZES:
        art.resize((n, n), Image.LANCZOS).save(build / "icons" / f"{n}x{n}.png")
    icon.resize((256, 256), Image.LANCZOS).save(ROOT / "docs" / "images" / "icon.png")
    print(f"Wrote {build / 'icon.png'}, {len(LINUX_SIZES)} Linux sizes, and docs/images/icon.png")


if __name__ == "__main__":
    main()
