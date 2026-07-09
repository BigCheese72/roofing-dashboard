#!/usr/bin/env python3
"""
geotiff_to_webmap.py — turn a drone orthomosaic GeoTIFF into a web-ready
image + the real-world GPS bounds RoofOps Field needs for a georeferenced
"Drone Orthomosaic" base map.

Why this exists: orthomosaic GeoTIFFs from photogrammetry software (DJI
Terra, DroneDeploy, Pix4D, OpenDroneMap/ODM, etc.) are often 100s of MB and
use a projected coordinate system (almost always WGS84 UTM). RoofOps Field
runs in a phone browser and never touches Firebase Storage (see
DEV_NOTES.md), so it can't accept a raw 300MB file — it needs a small JPG
and the four corner GPS coordinates. This script does that conversion
locally, once per orthomosaic, so the app itself never has to parse GeoTIFF
binary data.

Requirements:
  - Python 3 with Pillow  (already installed if you've used other tools here:
    `pip install pillow`)
  - ExifTool (https://exiftool.org) — used to read the GeoTIFF's
    georeferencing tags reliably rather than hand-parsing the TIFF spec.
    If you have DJI's image processing tools installed, it's often already
    bundled there; otherwise download the free Windows executable from
    exiftool.org and pass its path with --exiftool.

Usage (convert only — paste the printed bounds into the app's upload form yourself):
  python geotiff_to_webmap.py "C:\\path\\to\\orthophoto.tif" "C:\\path\\to\\output.jpg"
  python geotiff_to_webmap.py input.tif output.jpg --max-dim 3000 --exiftool "C:\\path\\to\\exiftool.exe"

Usage (convert AND upload in one step — for a building you fly regularly,
e.g. weekly, so you never have to open the app or retype coordinates):
  python geotiff_to_webmap.py input.tif output.jpg --upload \
      --building-id bld_xxxxx --company-cam-project-id 99347721 --pin 1234

  Get --building-id from the app: Building History -> admin mode -> open
  the building -> "Roof Base Map (admin)" card shows it with a Copy
  button. It never changes for a given building, so grab it once. Same
  for --company-cam-project-id (visible in CompanyCam's own project URL).

  Tip: since those don't change week to week, save your own wrapper
  script (a .bat file, a shell alias, whatever) with your specific
  --building-id/--company-cam-project-id/--pin baked in, so your actual
  weekly action is just running one command with the new file.

Output:
  - Writes the JPG.
  - Prints the four corner bounds (north/south/east/west, decimal degrees).
  - Without --upload: paste those into the app's "Drone Orthomosaic"
    upload form alongside the JPG.
  - With --upload: uploads the JPG to the linked CompanyCam project and
    sets it as the building's base map automatically — nothing left to
    do in the app.

Supported coordinate systems: WGS84 UTM (any zone, either hemisphere) and
plain geographic (lat/lon) GeoTIFFs. Anything else prints a clear error
instead of silently producing wrong coordinates.
"""

import argparse
import urllib.request
import urllib.error
import json
import math
import shutil
import subprocess
import sys
import re
from pathlib import Path

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None  # these are legitimate large orthomosaics, not decompression bombs
except ImportError:
    print("Pillow is required. Install it with: pip install pillow", file=sys.stderr)
    sys.exit(1)


def find_exiftool(explicit_path):
    if explicit_path:
        return explicit_path
    on_path = shutil.which("exiftool")
    if on_path:
        return on_path
    # Common bundled locations on this machine / typical DJI installs
    candidates = [
        r"C:\Users\Marks\OneDrive\Desktop\Documents\DJI\New folder\DJI_Image_Processor 1.4\exiftool.exe",
        r"C:\Program Files\exiftool\exiftool.exe",
        r"C:\exiftool\exiftool.exe",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    return None


def read_geotiff_metadata(exiftool_path, tif_path):
    # Deliberately NOT using -a (all) here: a pyramidal orthomosaic TIFF has
    # the same tag names (ImageWidth, PixelScale, ...) repeated in each
    # reduced-resolution IFD, and -a would report every occurrence. Plain -j
    # reports only the first (the primary, full-resolution IFD0) for each
    # tag name, which is exactly what we want for georeferencing.
    out = subprocess.run(
        [exiftool_path, "-j", str(tif_path)],
        capture_output=True, text=True, check=True
    )
    data = json.loads(out.stdout)[0]
    return data


def parse_pixel_scale(meta):
    raw = meta.get("PixelScale")
    if not raw:
        raise ValueError("No PixelScale tag found — this doesn't look like a georeferenced GeoTIFF.")
    parts = [float(x) for x in str(raw).split()]
    return parts[0], parts[1]  # scale_x, scale_y


def parse_tie_point(meta):
    raw = meta.get("ModelTiePoint")
    if not raw:
        raise ValueError("No ModelTiePoint tag found — this doesn't look like a georeferenced GeoTIFF.")
    parts = [float(x) for x in str(raw).split()]
    # Standard single-tiepoint GeoTIFF: I,J,K, X,Y,Z — pixel (I,J) maps to world (X,Y)
    return parts[3], parts[4]  # tie_x (easting/lon), tie_y (northing/lat)


def parse_utm_zone(meta):
    text = str(meta.get("GTCitation") or meta.get("ProjectedCSType") or "")
    m = re.search(r"UTM zone (\d+)\s*([NS])", text, re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1)), m.group(2).upper() == "N"


def utm_to_latlon(easting, northing, zone_number, northern):
    """Standard WGS84 UTM inverse projection (Snyder's formulas). Accurate
    to within centimeters for well-formed UTM coordinates — plenty for
    placing a base map image on a Leaflet map."""
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0 = 0.9996
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))

    x = easting - 500000.0
    y = northing if northern else northing - 10000000.0

    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))

    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu))

    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)

    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d ** 2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720
    )
    lon = (
        d - (1 + 2 * t1 + c1) * d ** 3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120
    ) / math.cos(phi1)

    lat_deg = math.degrees(lat)
    lon_deg = math.degrees(lon) + (zone_number * 6 - 183)
    return lat_deg, lon_deg


def compute_bounds(meta):
    model_type = meta.get("GTModelType", "")
    width = meta.get("ImageWidth")
    height = meta.get("ImageHeight")
    if not width or not height:
        raise ValueError("Couldn't read ImageWidth/ImageHeight from the file.")

    scale_x, scale_y = parse_pixel_scale(meta)
    tie_x, tie_y = parse_tie_point(meta)

    # Corners in the source coordinate system: top-left and bottom-right.
    # Standard GeoTIFF raster convention: X increases with pixel column,
    # Y (northing/lat) DECREASES with pixel row (row 0 is the top/north edge).
    tl_x, tl_y = tie_x, tie_y
    br_x, br_y = tie_x + width * scale_x, tie_y - height * scale_y

    if "Geographic" in str(model_type):
        # Already plain lat/lon — no projection to undo.
        nw_lat, nw_lon = tl_y, tl_x
        se_lat, se_lon = br_y, br_x
    elif "Projected" in str(model_type):
        zone = parse_utm_zone(meta)
        if not zone:
            raise ValueError(
                "This file uses a projected coordinate system this script doesn't recognize "
                "(only WGS84 UTM is supported). Found: "
                + str(meta.get("GTCitation") or meta.get("ProjectedCSType"))
            )
        zone_number, northern = zone
        nw_lat, nw_lon = utm_to_latlon(tl_x, tl_y, zone_number, northern)
        se_lat, se_lon = utm_to_latlon(br_x, br_y, zone_number, northern)
    else:
        raise ValueError(f"Unrecognized GTModelType: {model_type!r} — can't determine coordinates.")

    return {
        "north": max(nw_lat, se_lat),
        "south": min(nw_lat, se_lat),
        "east": max(nw_lon, se_lon),
        "west": min(nw_lon, se_lon),
    }


def pick_best_frame(img, max_dim):
    """Orthomosaic GeoTIFFs from photogrammetry tools usually ship a
    pyramid of pre-downsampled preview images (frame 0 = full res, each
    later frame roughly half the size). Pick the largest one that still
    fits within max_dim instead of decoding the full multi-hundred-MB
    image ourselves."""
    n_frames = getattr(img, "n_frames", 1)
    best = 0
    for i in range(n_frames):
        img.seek(i)
        if max(img.size) <= max_dim:
            best = i
            break
        best = i
    img.seek(best)
    return best


def call_app_api(app_url, function_name, body):
    """POST JSON to one of the app's Netlify functions using only the
    standard library — no extra dependency (requests) needed for a script
    that mostly just needs to run occasionally on someone's laptop."""
    url = app_url.rstrip("/") + "/.netlify/functions/" + function_name
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
            raise RuntimeError(err_body.get("error", str(e)))
        except (ValueError, KeyError):
            raise RuntimeError(f"{function_name} returned HTTP {e.code}")


def upload_and_set_base_map(app_url, project_id, building_id, pin, image_path, bounds):
    import base64

    print(f"Uploading {image_path.name} to CompanyCam project {project_id}...")
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    upload_result = call_app_api(app_url, "companycam", {
        "action": "upload_document",
        "project_id": project_id,
        "name": image_path.name,
        "attachment": b64,
    })
    url = (upload_result.get("document") or {}).get("url")
    if not url:
        raise RuntimeError("CompanyCam upload succeeded but returned no document URL — can't continue.")
    print(f"  uploaded: {url}")

    print(f"Setting it as the base map for building {building_id}...")
    call_app_api(app_url, "admin", {
        "action": "set_building_roof_map",
        "pin": pin,
        "buildingId": building_id,
        "roof_base_map_type": "drone_ortho",
        "roof_base_map_url": url,
        "roof_base_map_bounds": bounds,
    })
    print("  done — the building's roof map is updated.")


def main():
    # Windows' default console encoding (cp1252) mangles the em-dashes used
    # in this script's output; UTF-8 output is safe everywhere Python 3.7+ runs.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="Path to the orthomosaic GeoTIFF")
    ap.add_argument("output", help="Path to write the web-ready JPG")
    ap.add_argument("--max-dim", type=int, default=3000, help="Max width/height in pixels (default 3000)")
    ap.add_argument("--quality", type=int, default=85, help="JPEG quality 1-95 (default 85)")
    ap.add_argument("--exiftool", default=None, help="Path to exiftool.exe if not on PATH")
    ap.add_argument("--upload", action="store_true",
                     help="Also upload to CompanyCam and set as the building's base map (needs --building-id, "
                          "--company-cam-project-id, --pin)")
    ap.add_argument("--building-id", default=None, help="Building ID, from the app's admin Roof Base Map card")
    ap.add_argument("--company-cam-project-id", default=None, help="CompanyCam project ID linked to that building")
    ap.add_argument("--pin", default=None, help="The app's admin PIN")
    ap.add_argument("--app-url", default="https://leak-work-orders.netlify.app",
                     help="App base URL (default: production). Use the dev--... URL to test first.")
    args = ap.parse_args()

    if args.upload and not (args.building_id and args.company_cam_project_id and args.pin):
        print("--upload requires --building-id, --company-cam-project-id, and --pin.", file=sys.stderr)
        sys.exit(1)

    exiftool_path = find_exiftool(args.exiftool)
    if not exiftool_path:
        print(
            "Couldn't find ExifTool. Install it from https://exiftool.org and re-run with "
            "--exiftool \"C:\\path\\to\\exiftool.exe\", or add it to your PATH.",
            file=sys.stderr,
        )
        sys.exit(1)

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"Input file not found: {in_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading GeoTIFF metadata with ExifTool ({exiftool_path})...")
    meta = read_geotiff_metadata(exiftool_path, in_path)

    print("Computing real-world bounds...")
    bounds = compute_bounds(meta)

    print("Extracting a web-sized preview image (this can take a minute for large files)...")
    img = Image.open(in_path)
    frame_index = pick_best_frame(img, args.max_dim)
    img.load()
    print(f"  using embedded overview level {frame_index}, size {img.size}")

    if img.mode in ("RGBA", "LA"):
        # Flatten transparency (orthomosaic edges are often transparent
        # where the stitched area doesn't fully cover a rectangle) onto
        # white, since JPEG has no alpha channel.
        background = Image.new("RGB", img.size, (255, 255, 255))
        background.paste(img, mask=img.split()[-1])
        img = background
    else:
        img = img.convert("RGB")

    if max(img.size) > args.max_dim:
        ratio = args.max_dim / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "JPEG", quality=args.quality)

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print()
    print(f"Wrote {out_path} ({size_mb:.1f} MB, {img.size[0]}x{img.size[1]})")
    if size_mb > 25:
        print("WARNING: this is close to CompanyCam's ~30MB upload limit — consider a lower --max-dim.")
    print()

    if args.upload:
        print(f"Uploading and setting as base map (app: {args.app_url})...")
        try:
            upload_and_set_base_map(
                args.app_url, args.company_cam_project_id, args.building_id, args.pin, out_path, bounds
            )
        except Exception as e:
            print(f"Upload failed: {e}", file=sys.stderr)
            print(
                "The JPG and bounds above are still valid — you can paste them into the app's "
                "upload form by hand instead.",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        print("Paste these into the app's 'Drone Orthomosaic' upload form:")
        print(f"  North: {bounds['north']:.7f}")
        print(f"  South: {bounds['south']:.7f}")
        print(f"  East:  {bounds['east']:.7f}")
        print(f"  West:  {bounds['west']:.7f}")


if __name__ == "__main__":
    main()
