#!/usr/bin/env python3
"""
Capture + calibrate: turn whatever mGBA is showing into a canonical 240x160 frame.

Everything downstream works on that canonical frame, so it is independent of
window size, retina scaling, and where the window happens to sit.

Two decisions worth knowing about:

**We capture the WINDOW, not a screen rectangle.** `screencapture -l <id>`
takes the window's own content, so dragging or moving the window cannot
invalidate anything and there is no stored rectangle to go stale. It also means
we never photograph anything except the emulator, which matters because the
alternative was full-screen captures of a machine someone is also using for
other things.

**Calibration is per frame and derived, not stored.** The GBA framebuffer is
240x160 and the window is kept at an exact integer multiple, so the game area
is simply the bottom 3:2 region of the captured window, and the scale factor
falls out of its size. A stored calibration would be one more thing to be
wrong; this way a resized window self-heals on the next frame.

What is verified every time: the region really is an integer upscale of
240x160 (`block_error`). A wrong crop smears block boundaries and the error
jumps, which is what stops a bad frame being read as plausible garbage.

Usage:
    capture.py --check              report what it sees, verify, save a record
    capture.py --frame out.png      write one normalized 240x160 frame
    capture.py --bench [n]          measure sustained capture rate
"""

import json
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import window as winmod

GBA_W, GBA_H = 240, 160
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CALIB_PATH = os.path.join(REPO, ".checkpoints", "screen-calib.json")
SCRATCH = "/private/tmp/claude-501/-Users-omerbalak/screen"
os.makedirs(SCRATCH, exist_ok=True)
FRAME_PATH = os.path.join(SCRATCH, "frame.png")

BLOCK_ERROR_MAX = 0.02


class NotVisible(Exception):
    """The window exists but macOS handed us an empty frame.

    mGBA renders through OpenGL, so a window on an inactive Space (any
    fullscreen app in front counts) composites as blank rather than failing.
    Reading that as a game frame would be worse than stopping.
    """


def grab_window(win_id, path=FRAME_PATH):
    """The window's own pixels, PHYSICAL resolution, title bar included."""
    subprocess.run(
        ["/usr/sbin/screencapture", "-x", "-o", f"-l{win_id}", "-t", "png", path],
        check=True,
    )
    return Image.open(path).convert("RGB")


def game_area(img):
    """Crop the title bar off: the game view is full width and bottom aligned.

    Its height comes from the 3:2 aspect rather than a hardcoded chrome height,
    so this survives a change in title bar size.
    """
    w, h = img.size
    gh = round(w * GBA_H / GBA_W)
    if gh > h:
        return None
    return img.crop((0, h - gh, w, h))


def measure_scale(img):
    w, h = img.size
    if w % GBA_W or h % GBA_H:
        return None
    sx, sy = w // GBA_W, h // GBA_H
    return sx if sx == sy else None


def block_error(img, scale):
    """Distance from a clean NxN block upscale, 0..1.

    Take the centre pixel of every block, expand it back, and compare. Aligned
    integer scaling gives ~0; a misaligned crop gives a visibly larger number.
    """
    a = np.asarray(img, dtype=np.int16)
    centres = a[scale // 2 :: scale, scale // 2 :: scale][:GBA_H, :GBA_W]
    rebuilt = np.repeat(np.repeat(centres, scale, axis=0), scale, axis=1)
    rebuilt = rebuilt[: a.shape[0], : a.shape[1]]
    return float(np.abs(a - rebuilt).mean() / 255.0)


def looks_blank(img):
    """An uncomposited window: a couple of flat chrome colours and nothing else."""
    a = np.asarray(img.resize((60, 40), Image.NEAREST)).reshape(-1, 3)
    return len(np.unique(a, axis=0)) <= 4


def raw_frame():
    """(game_area image, scale, window dict). Raises if it cannot be trusted."""
    win = winmod.emulator_window()
    if win is None:
        raise SystemExit("mGBA is not running (no window found)")
    img = grab_window(win["id"])
    game = game_area(img)
    if game is None:
        raise SystemExit(f"captured {img.size}, too short to contain a 3:2 game area")
    if looks_blank(game):
        raise NotVisible(
            "mGBA's window is not being composited. Bring it to the front "
            "(a fullscreen app on another Space will do this)."
        )
    scale = measure_scale(game)
    if scale is None:
        raise SystemExit(
            f"game area is {game.size[0]}x{game.size[1]}, not an integer multiple of "
            f"{GBA_W}x{GBA_H}. Set width/height in ~/.config/mgba/config.ini to a "
            f"multiple (960x640 is 4x) with mGBA CLOSED."
        )
    err = block_error(game, scale)
    if err > BLOCK_ERROR_MAX:
        raise SystemExit(
            f"block error {err:.4f} exceeds {BLOCK_ERROR_MAX}: the capture is not a "
            f"clean integer upscale, so the crop is wrong. Refusing to emit a frame."
        )
    return game, scale, win


def frame():
    """One canonical 240x160 frame.

    Nearest neighbour on the way down: this is integer-scaled pixel art, and any
    smoothing filter invents colours that are not in the framebuffer.
    """
    game, _, _ = raw_frame()
    return game.resize((GBA_W, GBA_H), Image.NEAREST)


def check():
    win = winmod.emulator_window()
    if win is None:
        print("FAIL: mGBA is not running", file=sys.stderr)
        return False
    print(f"window   id={win['id']}  {win['w']}x{win['h']} at ({win['x']},{win['y']})")
    try:
        game, scale, _ = raw_frame()
    except NotVisible as e:
        print(f"BLANK: {e}", file=sys.stderr)
        return False
    err = block_error(game, scale)
    print(f"game area {game.size[0]}x{game.size[1]} physical -> integer scale {scale}x")
    print(f"block error {err:.4f}  (PASS, threshold {BLOCK_ERROR_MAX})")
    rec = {
        "window": win,
        "game_px": list(game.size),
        "scale": scale,
        "block_error": round(err, 5),
        "when": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    os.makedirs(os.path.dirname(CALIB_PATH), exist_ok=True)
    with open(CALIB_PATH, "w") as f:
        json.dump(rec, f, indent=2)
    print(f"recorded {CALIB_PATH}")
    return True


def bench(n=20):
    t0 = time.time()
    for _ in range(n):
        frame()
    dt = time.time() - t0
    print(f"{n} frames in {dt:.2f}s  ->  {dt / n * 1000:.1f} ms/frame, {n / dt:.1f} Hz")
    print(f"at 3x speed, ~{0.33 * n / dt:.1f} frames per battle message")


if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if not args or args[0] == "--check":
            sys.exit(0 if check() else 1)
        elif args[0] == "--frame":
            out = args[1] if len(args) > 1 else "frame240.png"
            frame().save(out)
            print(f"wrote {out}")
        elif args[0] == "--bench":
            bench(int(args[1]) if len(args) > 1 else 20)
        else:
            raise SystemExit(__doc__)
    except NotVisible as e:
        print(f"BLANK: {e}", file=sys.stderr)
        sys.exit(2)
