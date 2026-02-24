#!/usr/bin/env bash
# build-images.sh – Responsive AVIF + WEBP + JPG variants for FlatWiki landing page
# Sources: <name>-1400.jpg  →  <name>-{480,560,640,760,880,960,1400}.{avif,webp,jpg}
# Originals (*-1400.jpg) are NEVER overwritten.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMGDIR="${1:-"$SCRIPT_DIR/../_homepage/sites/assets/images"}"
AVIF_Q=50   # visually clean, strong compression (q45-55 range)
WEBP_Q=85   # visually loss-light for UI screenshots
JPG_Q=72    # good UI legibility (q68-75), progressive

# ── Tool check ────────────────────────────────────────────────────────────────
if [[ ! -d "$IMGDIR" ]]; then
  echo "ERROR: image directory not found: $IMGDIR" >&2
  echo "Usage: $0 [image-dir]" >&2
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found" >&2; exit 1
fi

if ! python3 - <<'CHECK_PIL'
try:
    from PIL import Image
except ImportError:
    import sys; print("ERROR: Pillow not installed", file=sys.stderr); sys.exit(1)
print(f"Tools OK: Pillow {__import__('PIL').__version__}")
CHECK_PIL
then
  exit 1
fi

USE_AVIFENC=0
AVIFENC_BIN=""
if command -v avifenc >/dev/null 2>&1; then
  USE_AVIFENC=1
  AVIFENC_BIN="$(command -v avifenc)"
  echo "AVIF encoder: avifenc ($AVIFENC_BIN)"
else
  echo "AVIF encoder: avifenc not found, trying Pillow AVIF fallback"
  if ! python3 - <<'CHECK_AVIF'
import io, sys
from PIL import Image
try:
    import pillow_avif  # noqa: F401
except Exception as e:
    print(f"ERROR: pillow-avif-plugin not available ({e})", file=sys.stderr)
    sys.exit(1)
img = Image.new("RGB", (2, 2))
buf = io.BytesIO()
try:
    img.save(buf, format="AVIF")
except Exception as e:
    print(f"ERROR: AVIF encode failed via Pillow ({e})", file=sys.stderr)
    sys.exit(1)
print("AVIF encoder: Pillow fallback ready")
CHECK_AVIF
  then
    echo "Fix options:" >&2
    echo "  1) Install libavif CLI: avifenc (e.g. brew install libavif)" >&2
    echo "  2) Or install Python plugin: pip3 install pillow-avif-plugin" >&2
    exit 1
  fi
fi

# ── Generate variants ─────────────────────────────────────────────────────────
python3 - "$IMGDIR" "$AVIF_Q" "$WEBP_Q" "$JPG_Q" "$USE_AVIFENC" "$AVIFENC_BIN" <<'PYEOF'
import glob
import os
import subprocess
import sys
import tempfile
from PIL import Image

IMGDIR  = sys.argv[1]
AVIF_Q  = int(sys.argv[2])
WEBP_Q  = int(sys.argv[3])
JPG_Q   = int(sys.argv[4])
USE_AVIFENC = bool(int(sys.argv[5]))
AVIFENC_BIN = sys.argv[6]
BASES   = ["ui-home-dark", "ui-article", "ui-editor", "ui-admin", "ui-comments", "psi-desktop"]
WIDTHS  = [480, 560, 640, 760, 880, 960, 1400]

def verify_avif(path):
    """Check ftyp box for AVIF brand – rejects mislabelled JPEGs."""
    with open(path, "rb") as f:
        hdr = f.read(24)
    return b"ftyp" in hdr and any(b in hdr for b in (b"avif", b"avis", b"MA1B", b"MA1A"))

def to_quantizer(quality):
    # Map Pillow-like quality 0..100 to avifenc quantizer 63..0 (lower is better).
    q = round((100 - quality) * 0.63)
    return max(0, min(63, int(q)))

try:
    resample = Image.Resampling.LANCZOS
except AttributeError:
    resample = Image.LANCZOS

for base in BASES:
    src = os.path.join(IMGDIR, f"{base}-1400.jpg")
    if not os.path.exists(src):
        # fallback: largest JPG that is not a generated variant
        candidates = sorted(glob.glob(os.path.join(IMGDIR, f"{base}-[0-9]*.jpg")))
        originals  = [f for f in candidates
                      if not any(f.endswith(f"-{w}.jpg") for w in WIDTHS)]
        if not originals:
            print(f"WARNING: no source for '{base}' – skipped", file=sys.stderr)
            continue
        src = originals[-1]
        print(f"WARNING: '{base}' using fallback {os.path.basename(src)}", file=sys.stderr)

    print(f"\n[{base}]  source: {os.path.basename(src)}  ({os.path.getsize(src)//1024} K)")

    with Image.open(src) as img:
        img.load()
        orig_w, orig_h = img.size
        rgb = img.convert("RGB")

    for w in WIDTHS:
        if w > orig_w:
            print(f"  ··  {w}px  (source {orig_w}px, skip)")
            continue

        h     = round(orig_h * w / orig_w)
        thumb = rgb.resize((w, h), resample)

        # AVIF – slightly tighter for ui-article mobile
        aq = (AVIF_Q - 3) if (base == "ui-article" and w <= 640) else AVIF_Q
        ap = os.path.join(IMGDIR, f"{base}-{w}.avif")
        if USE_AVIFENC:
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                tmp_path = tmp.name
            try:
                thumb.save(tmp_path, format="PNG", optimize=True)
                quantizer = to_quantizer(aq)
                subprocess.run(
                    [
                        AVIFENC_BIN,
                        "--min", str(quantizer),
                        "--max", str(quantizer),
                        "--speed", "5",
                        tmp_path,
                        ap,
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
            except subprocess.CalledProcessError as e:
                msg = e.stderr.decode("utf-8", "replace").strip()
                print(f"ERROR: avifenc failed for {base}-{w}: {msg}", file=sys.stderr)
                sys.exit(1)
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        else:
            thumb.save(ap, format="AVIF", quality=aq, speed=5)
        if not verify_avif(ap):
            print(f"ERROR: {ap} failed AVIF magic check!", file=sys.stderr)
            sys.exit(1)
        print(f"  OK  {base}-{w}.avif  {os.path.getsize(ap)//1024:>4} K  q={aq}")

        # WEBP – visually loss-light fallback for browsers without AVIF
        wp = os.path.join(IMGDIR, f"{base}-{w}.webp")
        thumb.save(wp, format="WEBP", quality=WEBP_Q, method=6)
        print(f"  OK  {base}-{w}.webp  {os.path.getsize(wp)//1024:>4} K  q={WEBP_Q}")

        # JPG – progressive, chroma subsampling 4:2:0
        jp = os.path.join(IMGDIR, f"{base}-{w}.jpg")
        thumb.save(jp, format="JPEG", quality=JPG_Q,
                   progressive=True, optimize=True, subsampling=2)
        print(f"  OK  {base}-{w}.jpg   {os.path.getsize(jp)//1024:>4} K  q={JPG_Q} progressive")

print("\nAll done.")

# Also create sidecar WEBP files for any remaining JPG/JPEG/PNG in the image dir.
print("\nGenerating WEBP sidecars for remaining JPG/JPEG/PNG files...")
sidecar_sources = []
for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
    sidecar_sources.extend(glob.glob(os.path.join(IMGDIR, pattern)))

for src in sorted(set(sidecar_sources)):
    stem, _ext = os.path.splitext(src)
    dst = f"{stem}.webp"
    with Image.open(src) as img:
        img.load()
        # Keep alpha when present (PNG), otherwise write as RGB.
        mode = "RGBA" if "A" in img.getbands() else "RGB"
        img.convert(mode).save(dst, format="WEBP", quality=WEBP_Q, method=6)
    print(f"  OK  {os.path.basename(dst)}  (from {os.path.basename(src)})")

print("\nWEBP sidecar pass done.")
PYEOF
