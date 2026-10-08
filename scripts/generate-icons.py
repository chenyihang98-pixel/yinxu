"""Rebuild the original Muse vector-derived icons. Requires Python and Pillow.

The SVG is the editable source; PNG/ICO are committed so packaging needs no Python.
The mark combines an M silhouette with five equalizer bars.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "electron" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

SIZE = 512
SCALE = 4
DARK = "#101112"
ACCENT = "#bca5f7"
BARS = [(126, 224, 148, 322), (181, 143, 211, 356), (247, 206, 277, 290), (313, 143, 343, 356), (376, 224, 398, 322)]

svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
       '<rect x="16" y="16" width="480" height="480" rx="116" fill="#101112"/>',
       '<rect x="17" y="17" width="478" height="478" rx="115" fill="none" stroke="#32372b" stroke-width="2"/>']
for x1, y1, x2, y2 in BARS:
    svg.append(f'<rect x="{x1}" y="{y1}" width="{x2-x1}" height="{y2-y1}" rx="{(x2-x1)/2}" fill="{ACCENT}"/>')
svg.append('</svg>')
(ASSETS / "muse.svg").write_text("\n".join(svg) + "\n", encoding="utf-8")

image = Image.new("RGBA", (SIZE*SCALE, SIZE*SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
def rect(bounds, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(tuple(int(v*SCALE) for v in bounds), radius=int(radius*SCALE), fill=fill, outline=outline, width=width*SCALE)
rect((16, 16, 496, 496), 116, DARK)
rect((17, 17, 495, 495), 115, None, "#32372b", 2)
for x1, y1, x2, y2 in BARS:
    rect((x1, y1, x2, y2), (x2-x1)/2, ACCENT)
image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
image.save(ASSETS / "muse.png")
image.save(ASSETS / "muse.ico", format="ICO", sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print(f"Created original Muse icons in {ASSETS}")
