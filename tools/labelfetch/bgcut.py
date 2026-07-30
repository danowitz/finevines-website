# Removes an image's background locally (rembg / U^2-Net) and flattens the
# result onto white, so the downstream JPEG pipeline never meets transparency.
#
# Exists because the review sheet lets a human pick a bottle photographed in a
# scene: the pick is right, the setting is what the "no clean background" gate
# refuses. The Hub's backgroundcut.co account had no credits (HTTP 402,
# 2026-07-30), and a local model costs nothing per image and sends nothing
# anywhere.
#
#   python tools/labelfetch/bgcut.py <in> <out.png>
import sys

from PIL import Image
from rembg import remove

src, dst = sys.argv[1], sys.argv[2]
cut = remove(Image.open(src)).convert("RGBA")
flat = Image.new("RGB", cut.size, (255, 255, 255))
flat.paste(cut, mask=cut.split()[3])
flat.save(dst, "PNG")
print(f"bgcut: {src} -> {dst} {flat.size[0]}x{flat.size[1]}")
