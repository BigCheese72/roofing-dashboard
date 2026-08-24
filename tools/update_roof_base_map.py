#!/usr/bin/env python3
"""
update_roof_base_map.py — interactive wrapper around geotiff_to_webmap.py's
--upload pipeline. Double-click Update Roof Base Map.bat (or drag a .tif
file onto it) instead of typing the full command by hand.

Remembers buildings you've updated before (name, building ID, CompanyCam
project ID) in buildings_config.json next to this script, and lets you add
a new one on the fly — so this isn't tied to any one building.

buildings_config.json is gitignored on purpose: it holds your admin PIN.
Don't remove it from .gitignore, and don't commit that file.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from geotiff_to_webmap import (  # noqa: E402
    find_exiftool, read_geotiff_metadata, compute_bounds, pick_best_frame,
    upload_and_set_base_map,
)
from PIL import Image  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

CONFIG_PATH = Path(__file__).parent / "buildings_config.json"
DEFAULT_APP_URL = "https://leak-work-orders.netlify.app"


def load_config():
    if CONFIG_PATH.exists():
        return json.loads(CONFIG_PATH.read_text())
    return {"app_url": DEFAULT_APP_URL, "pin": None, "buildings": []}


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def prompt(text, default=None):
    suffix = f" [{default}]" if default else ""
    val = input(f"{text}{suffix}: ").strip()
    return val or default


def pick_building(cfg):
    buildings = cfg["buildings"]
    print("\nKnown buildings:")
    for i, b in enumerate(buildings, 1):
        print(f"  {i}) {b['name']}")
    print(f"  {len(buildings) + 1}) Add a new building")

    while True:
        choice = input(f"Pick a number (1-{len(buildings) + 1}): ").strip()
        if not choice.isdigit():
            print("Enter a number.")
            continue
        n = int(choice)
        if 1 <= n <= len(buildings):
            return buildings[n - 1]
        if n == len(buildings) + 1:
            return add_building(cfg)
        print("Out of range.")


def add_building(cfg):
    print("\nAdding a new building.")
    print("Find the Building ID in the app: Building History -> admin mode -> ")
    print("open the building -> 'Roof Base Map (admin)' card -> Copy button.")
    print("Find the CompanyCam project ID in CompanyCam's own project URL.\n")
    name = prompt("Building name (just a label for this menu)")
    building_id = prompt("Building ID (starts with bld_)")
    project_id = prompt("CompanyCam project ID")
    b = {"name": name, "building_id": building_id, "company_cam_project_id": project_id}
    cfg["buildings"].append(b)
    save_config(cfg)
    print(f"Saved '{name}' for next time.\n")
    return b


def get_pin(cfg):
    if cfg.get("pin"):
        use_saved = prompt(f"Use saved admin PIN? (Y/n)", "Y")
        if use_saved.lower().startswith("y"):
            return cfg["pin"]
    # Deliberately plain input(), not getpass.getpass() — getpass reads
    # directly from the console on Windows regardless of how stdin is
    # wired up, which hangs in some environments instead of failing
    # loudly. The PIN is a shared admin convenience gate, not a real
    # secret (see DEV_NOTES.md), so masking it isn't worth that risk.
    pin = prompt("Admin PIN").strip()
    remember = prompt("Remember this PIN for next time? (Y/n)", "Y")
    if remember.lower().startswith("y"):
        cfg["pin"] = pin
        save_config(cfg)
    return pin


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    print("=== RoofOps Field — Roof Base Map Updater ===\n")
    cfg = load_config()

    if len(sys.argv) > 1:
        in_path = Path(sys.argv[1])
    else:
        in_path = Path(prompt("Path to the drone orthomosaic .tif file (or drag it onto this window)").strip('"'))
    if not in_path.exists():
        print(f"File not found: {in_path}")
        input("Press Enter to close...")
        sys.exit(1)

    building = pick_building(cfg)
    pin = get_pin(cfg)
    app_url = cfg.get("app_url") or DEFAULT_APP_URL

    confirm = prompt(f"\nUpdate the roof base map for '{building['name']}' using {in_path.name}? (Y/n)", "Y")
    if not confirm.lower().startswith("y"):
        print("Cancelled.")
        input("Press Enter to close...")
        return

    exiftool_path = find_exiftool(None)
    if not exiftool_path:
        print("Couldn't find ExifTool. Install it from https://exiftool.org.")
        input("Press Enter to close...")
        sys.exit(1)

    try:
        print("\nReading GeoTIFF metadata...")
        meta = read_geotiff_metadata(exiftool_path, in_path)
        bounds = compute_bounds(meta)

        print("Extracting a web-sized preview image (this can take a minute)...")
        img = Image.open(in_path)
        pick_best_frame(img, 3000)
        img.load()
        if img.mode in ("RGBA", "LA"):
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
        if max(img.size) > 3000:
            ratio = 3000 / max(img.size)
            img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)

        out_path = Path(__file__).parent / "_last_upload_preview.jpg"
        img.save(out_path, "JPEG", quality=85)

        upload_and_set_base_map(
            app_url, building["company_cam_project_id"], building["building_id"], pin, out_path, bounds
        )
        print(f"\nDone. '{building['name']}' now has this week's roof map.")
    except Exception as e:
        print(f"\nFailed: {e}")
        input("Press Enter to close...")
        sys.exit(1)

    input("\nPress Enter to close...")


if __name__ == "__main__":
    main()
