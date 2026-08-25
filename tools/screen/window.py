#!/usr/bin/env python3
"""
Find the emulator window through CoreGraphics, not accessibility.

Accessibility (System Events) was the obvious route and it is not dependable:
it intermittently reports that mGBA has zero windows while the window is
plainly on screen, which came back as a calibration failure at random. It also
needs a permission grant that CoreGraphics does not.

CGWindowListCopyWindowInfo is read-only, needs no permission beyond the screen
recording grant we already have, and returns the window's id. The id is worth
more than the bounds: `screencapture -l <id>` captures that window's own
content, so a window that moves does not invalidate anything, and nothing has
to be recalibrated because the user dragged it.

Reached through ctypes because pyobjc is not installed.
"""

import ctypes
import ctypes.util

CFIndex = ctypes.c_long
CGFloat = ctypes.c_double


class CGPoint(ctypes.Structure):
    _fields_ = [("x", CGFloat), ("y", CGFloat)]


class CGSize(ctypes.Structure):
    _fields_ = [("width", CGFloat), ("height", CGFloat)]


class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


_cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
_cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))

_cf.CFArrayGetCount.restype = CFIndex
_cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
_cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
_cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, CFIndex]
_cf.CFDictionaryGetValue.restype = ctypes.c_void_p
_cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_cf.CFStringCreateWithCString.restype = ctypes.c_void_p
_cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
_cf.CFStringGetCString.restype = ctypes.c_bool
_cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, CFIndex, ctypes.c_uint32]
_cf.CFNumberGetValue.restype = ctypes.c_bool
_cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
_cf.CFRelease.argtypes = [ctypes.c_void_p]

_cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
_cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
_cg.CGRectMakeWithDictionaryRepresentation.restype = ctypes.c_bool
_cg.CGRectMakeWithDictionaryRepresentation.argtypes = [ctypes.c_void_p, ctypes.POINTER(CGRect)]

kCFStringEncodingUTF8 = 0x08000100
kCGWindowListOptionAll = 0
kCGWindowListOptionOnScreenOnly = 1
kCGNullWindowID = 0
kCFNumberIntType = 9


def _cfstr(s):
    return _cf.CFStringCreateWithCString(None, s.encode("utf-8"), kCFStringEncodingUTF8)


def _to_str(ref):
    if not ref:
        return None
    buf = ctypes.create_string_buffer(512)
    if not _cf.CFStringGetCString(ref, buf, 512, kCFStringEncodingUTF8):
        return None
    return buf.value.decode("utf-8", "replace")


def _to_int(ref):
    if not ref:
        return None
    v = ctypes.c_int()
    if not _cf.CFNumberGetValue(ref, kCFNumberIntType, ctypes.byref(v)):
        return None
    return v.value


def windows(owner=None, on_screen_only=False):
    """Windows as dicts: id, owner, title, x, y, w, h (logical points).

    Defaults to EVERY window, not just on-screen ones. "On screen" excludes any
    window on another Space, so with a fullscreen app active the emulator
    vanishes from the list entirely -- which is the same reason accessibility
    kept reporting zero windows.
    """
    option = kCGWindowListOptionOnScreenOnly if on_screen_only else kCGWindowListOptionAll
    arr = _cg.CGWindowListCopyWindowInfo(option, kCGNullWindowID)
    if not arr:
        return []
    k_owner, k_num, k_name, k_bounds = (
        _cfstr("kCGWindowOwnerName"),
        _cfstr("kCGWindowNumber"),
        _cfstr("kCGWindowName"),
        _cfstr("kCGWindowBounds"),
    )
    out = []
    try:
        for i in range(_cf.CFArrayGetCount(arr)):
            d = _cf.CFArrayGetValueAtIndex(arr, i)
            name = _to_str(_cf.CFDictionaryGetValue(d, k_owner))
            if owner and name != owner:
                continue
            rect = CGRect()
            if not _cg.CGRectMakeWithDictionaryRepresentation(
                _cf.CFDictionaryGetValue(d, k_bounds), ctypes.byref(rect)
            ):
                continue
            out.append(
                {
                    "id": _to_int(_cf.CFDictionaryGetValue(d, k_num)),
                    "owner": name,
                    "title": _to_str(_cf.CFDictionaryGetValue(d, k_name)),
                    "x": int(rect.origin.x),
                    "y": int(rect.origin.y),
                    "w": int(rect.size.width),
                    "h": int(rect.size.height),
                }
            )
    finally:
        for ref in (arr, k_owner, k_num, k_name, k_bounds):
            _cf.CFRelease(ref)
    return out


def emulator_window(owner="mGBA"):
    """The emulator's main window: the largest one that is actually ON SCREEN.

    On-screen first, and this matters more than it sounds. mGBA owns about
    eleven windows, most of them stale or never displayed, and picking the
    largest across ALL of them returned one reporting (0,-28) while the window
    the user was looking at sat at x=405. Capture then photographed the wrong
    part of the screen and every frame failed its alignment check, which looked
    like an occlusion problem for a while and was not.

    Falling back to every window keeps the case this list was widened for: with
    a fullscreen app in front, the emulator is on another Space and drops off
    the on-screen list entirely. A rect from that fallback cannot be trusted for
    a region capture, but the window id is still right, and capture verifies the
    pixels it gets regardless.

    Largest rather than first, because the app also owns small transient windows
    -- the settings sheet, dialogs -- that must never be mistaken for the game.
    """
    def biggest(ws):
        cands = [w for w in ws if w["w"] > 100 and w["h"] > 100]
        return max(cands, key=lambda w: w["w"] * w["h"]) if cands else None

    return biggest(windows(owner, on_screen_only=True)) or biggest(windows(owner))


if __name__ == "__main__":
    import json
    import sys

    owner = sys.argv[1] if len(sys.argv) > 1 else "mGBA"
    w = emulator_window(owner)
    if w is None:
        print(f"no on-screen window found for {owner!r}", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(w, indent=2))
