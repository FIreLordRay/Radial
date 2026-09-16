"""One-off script: generate Radial's PWA icons (concentric-circle mark on a
Dark Ember background, same gradient as the in-app brand mark). Run once;
the output PNGs are committed, this script is not imported by the app."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "web" / "static" / "icons"
BG = (16, 12, 10, 255)  # #100c0a
EMBER = (245, 158, 11)  # #f59e0b
ROSE = (244, 63, 94)  # #f43f5e


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient_color(t: float) -> tuple[int, int, int]:
    return (lerp(EMBER[0], ROSE[0], t), lerp(EMBER[1], ROSE[1], t), lerp(EMBER[2], ROSE[2], t))


def make_icon(size: int) -> Image.Image:
    scale = 4  # supersample for smooth anti-aliased circles
    big = size * scale
    img = Image.new("RGBA", (big, big), BG)
    draw = ImageDraw.Draw(img)
    cx = cy = big / 2

    # Three concentric rings/dot, same proportions as the in-app SVG mark
    # (r=3/7/10.5 on a 24-wide viewBox -> scale to this canvas's safe zone).
    unit = big / 24
    specs = [
        (10.5 * unit, 1.25 * unit / 2, 0.3),
        (7 * unit, 1.5 * unit / 2, 0.6),
        (3 * unit, None, 1.0),  # filled dot
    ]
    for radius, stroke_w, t in specs:
        color = gradient_color(t)
        if stroke_w is None:
            draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color + (255,))
        else:
            # Alpha-blend the ring color toward BG to mimic the SVG's opacity.
            alpha = int(255 * (0.3 + 0.4 * t))
            draw.ellipse(
                [cx - radius, cy - radius, cx + radius, cy + radius],
                outline=color + (alpha,),
                width=max(1, round(stroke_w)),
            )
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        icon = make_icon(size)
        path = OUT_DIR / f"icon-{size}.png"
        icon.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
