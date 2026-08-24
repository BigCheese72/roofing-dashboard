# -*- coding: utf-8 -*-
"""
Generates RoofOps app icons (prod + dev) from the source logo.
Run manually with: python gen_icons.py
Not part of the app build -- a one-off asset-generation script kept here
for reproducibility if the logo changes again later.
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "roofops-logo-source.png")
DEV_DIR = os.path.join(HERE, "..", "dev")
PROD_DIR = os.path.join(HERE, "..", "prod")

BLACK = (0, 0, 0)

# Bounding box of the "RO" house monogram only (excludes the "ROOF OPS"
# wordmark below it), found by scanning the source for non-black content
# bands. Small extra margin added around the tight bbox.
MONO_BOX = (142, 210, 1119, 820)  # left, top, right, bottom

MASTER_SIZE = 1024
MARGIN_FRAC = 0.14  # fraction of canvas kept empty on the tight side


def build_master():
    im = Image.open(SRC).convert("RGB")
    crop = im.crop(MONO_BOX)
    cw, ch = crop.size
    canvas = Image.new("RGB", (MASTER_SIZE, MASTER_SIZE), BLACK)
    target_w = int(MASTER_SIZE * (1 - 2 * MARGIN_FRAC))
    scale = target_w / cw
    new_w, new_h = int(cw * scale), int(ch * scale)
    if new_h > MASTER_SIZE * (1 - 2 * MARGIN_FRAC):
        scale = (MASTER_SIZE * (1 - 2 * MARGIN_FRAC)) / ch
        new_w, new_h = int(cw * scale), int(ch * scale)
    resized = crop.resize((new_w, new_h), Image.LANCZOS)
    x = (MASTER_SIZE - new_w) // 2
    y = (MASTER_SIZE - new_h) // 2
    canvas.paste(resized, (x, y))
    return canvas


def add_dev_badge(master):
    im = master.copy()
    draw = ImageDraw.Draw(im)
    # Diagonal ribbon banner across the bottom-left corner -- that area of
    # the monogram (below the house, left of the "R" leg) is clear black
    # background in the crop, so the ribbon doesn't cover any logo detail.
    ribbon_color = (196, 30, 30)
    text_color = (255, 255, 255)
    w = h = MASTER_SIZE
    band_w = int(w * 0.62)
    band_h = int(h * 0.115)
    ribbon = Image.new("RGBA", (band_w, band_h), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(ribbon)
    rdraw.rectangle([0, 0, band_w, band_h], fill=ribbon_color + (255,))
    try:
        font = ImageFont.truetype("arialbd.ttf", int(band_h * 0.62))
    except Exception:
        font = ImageFont.load_default()
    text = "DEV"
    bbox = rdraw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    rdraw.text(((band_w - tw) / 2 - bbox[0], (band_h - th) / 2 - bbox[1]),
                text, font=font, fill=text_color + (255,))
    rotated = ribbon.rotate(35, expand=True, resample=Image.BICUBIC)
    rw, rh = rotated.size
    # Anchor near bottom-left corner, angled like a corner-flag ribbon.
    px = int(w * -0.06)
    py = int(h * 0.62)
    im.paste(rotated, (px, py), rotated)
    return im


def save_sizes(master, out_dir, prefix):
    os.makedirs(out_dir, exist_ok=True)
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")]:
        resized = master.resize((size, size), Image.LANCZOS)
        resized.save(os.path.join(out_dir, name))
    print("wrote", prefix, "icons to", out_dir)


if __name__ == "__main__":
    master = build_master()
    master.save(os.path.join(HERE, "monogram-master-1024.png"))
    save_sizes(master, PROD_DIR, "prod")

    dev_master = add_dev_badge(master)
    dev_master.save(os.path.join(HERE, "monogram-dev-master-1024.png"))
    save_sizes(dev_master, DEV_DIR, "dev")
