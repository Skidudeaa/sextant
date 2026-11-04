#!/usr/bin/env python3
"""eye: a UI vision specialist any coding agent can shell out to.

Three jobs, three instruments:
  measure  code reads the pixels: spacing, alignment, padding, palette, contrast, diffs. Free.
  review   measure, then GPT-6.1 Terra and Gemini 4 Argon look at zoomed crops.
  ab       each model judges A/B in both orders. Order-dependent answers count as no signal.

  eye.py measure shot.png --ref design.png --tokens tokens.json --scale 2
  eye.py review  shot.png --ref design.png --brief "dense, warm, quiet" --scale 2
  eye.py ab      a.png b.png --brief "which reads calmer at a glance"
  eye.py check   http://localhost:3000/dashboard --focus ".filter-bar" --ref last.png --scale 2

Works on any screenshot (web, SwiftUI, macOS). Prints JSON and writes eye_out/annotated.png.
check opens the page itself (Playwright) and gates on red rows: exit 0 clean, 1 red rows, 2 tool error.
Env: OPENAI_API_KEY, GEMINI_API_KEY. Swap models with EYE_OPENAI_MODEL, EYE_GEMINI_MODEL.
Requires: pip install pillow numpy scipy; check also needs playwright plus one browser:
  pip install playwright && python3 -m playwright install chromium
"""
import argparse
import base64
import collections
import io
import json
import math
import os
import pathlib
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage, signal

OPENAI_MODEL = os.environ.get("EYE_OPENAI_MODEL", "gpt-6.1-terra")
GEMINI_MODEL = os.environ.get("EYE_GEMINI_MODEL", "gemini-4-argon")
OPENAI_BASE = os.environ.get("EYE_OPENAI_BASE", "https://api.openai.com")
GEMINI_BASE = os.environ.get("EYE_GEMINI_BASE", "https://generativelanguage.googleapis.com")
TIMEOUT = 900  # Google recommends at least 15 minutes for Argon.
MAX_CROPS = 8
MAX_PATCHES = 28000  # OpenAI rejects images above 30,000 32px patches.
CATEGORIES = ["spacing", "alignment", "color", "type", "hierarchy", "density",
              "contrast", "overflow", "clipping", "missing", "other"]

FINDINGS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "verdict"],
    "properties": {
        "verdict": {"type": "string"},
        "findings": {"type": "array", "items": {
            "type": "object",
            "additionalProperties": False,
            "required": ["region", "category", "severity", "what", "fix"],
            "properties": {
                "region": {"type": "string"},
                "category": {"type": "string", "enum": CATEGORIES},
                "severity": {"type": "string", "enum": ["high", "med", "low"]},
                "what": {"type": "string"},
                "fix": {"type": "string"},
            },
        }},
    },
}
AB_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["winner", "why"],
    "properties": {"winner": {"type": "integer", "enum": [1, 2]}, "why": {"type": "string"}},
}


# ---------------------------------------------------------------- pixels
def load(path):
    img = Image.open(path)
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(canvas, rgba)
    return img.convert("RGB")


def to_hex(rgb):
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb)


def from_hex(value):
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def luminance(rgb):
    def channel(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def lab(rgb):
    def f(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (f(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    def g2(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = g2(x), g2(y), g2(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a, b):
    return math.dist(lab(a), lab(b))


def colors(arr, min_share=0.003, merge=8):
    """Dominant exact colors, with near-identical shades merged into the commoner one."""
    if arr.size == 0:
        return []
    packed = (arr[..., 0].astype(np.uint32) << 16) | (arr[..., 1].astype(np.uint32) << 8) | arr[..., 2]
    values, counts = np.unique(packed, return_counts=True)
    order = np.argsort(-counts)[:64]
    total = packed.size
    kept = []
    for i in order:
        v = int(values[i])
        rgb = ((v >> 16) & 255, (v >> 8) & 255, v & 255)
        for item in kept:
            if math.dist(item["rgb"], rgb) <= merge:
                item["count"] += int(counts[i])
                break
        else:
            kept.append({"rgb": rgb, "count": int(counts[i])})
    kept = [k for k in kept if k["count"] / total >= min_share]
    kept.sort(key=lambda k: -k["count"])
    return [{"hex": to_hex(k["rgb"]), "rgb": k["rgb"], "pct": round(100 * k["count"] / total, 2)} for k in kept]


def box_contrast(arr):
    """Background is the commonest color; foreground is the strongest-contrast color present.
    Reads the middle of the box, so a solid icon and its corners do not count as text."""
    h, w = arr.shape[:2]
    found = colors(arr[h // 6:h - h // 6, w // 12:w - w // 12], min_share=0.004)
    if len(found) < 2:
        return None
    bg = found[0]
    fg = max(found[1:], key=lambda c: contrast_ratio(c["rgb"], bg["rgb"]))
    return {"bg": bg["hex"], "fg": fg["hex"], "ratio": round(contrast_ratio(fg["rgb"], bg["rgb"]), 2)}


# ---------------------------------------------------------------- layout from pixels
def find_blocks(arr, offset=(0, 0), depth=0, max_depth=2, scale=1):
    """Recursive box finder. A panel is a filled or outlined surface; anything else is ink."""
    h, w = arr.shape[:2]
    if h < 12 or w < 12:
        return []
    border = np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]])
    packed = (border[:, 0].astype(np.uint32) << 16) | (border[:, 1].astype(np.uint32) << 8) | border[:, 2]
    values, counts = np.unique(packed, return_counts=True)
    v = int(values[np.argmax(counts)])
    bg = np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255])
    mask = np.abs(arr.astype(np.int16) - bg).max(axis=2) > 3  # Low enough for near-black surfaces.
    grow = max(3, int(3 * scale)) if depth == 0 else max(4, int(4 * scale))
    labels, _ = ndimage.label(ndimage.binary_dilation(mask, structure=np.ones((grow * 2 + 1, grow * 2 + 1))))
    blocks = []
    for index, slc in enumerate(ndimage.find_objects(labels), start=1):
        inner = (labels[slc] == index) & mask[slc]
        ys, xs = np.where(inner)
        if len(xs) == 0:
            continue
        y0, y1 = slc[0].start + int(ys.min()), slc[0].start + int(ys.max()) + 1
        x0, x1 = slc[1].start + int(xs.min()), slc[1].start + int(xs.max()) + 1
        bw, bh = x1 - x0, y1 - y0
        if bw * bh < 36 * scale * scale:
            continue
        # Rounded corners of the parent surface show up as specks touching two crop edges.
        touches_x, touches_y = x0 <= 1 or x1 >= w - 1, y0 <= 1 or y1 >= h - 1
        if depth and touches_x and touches_y and bw < 40 * scale and bh < 40 * scale:
            continue
        tight = mask[y0:y1, x0:x1]
        edges = min(tight[0].mean(), tight[-1].mean(), tight[:, 0].mean(), tight[:, -1].mean())
        panel = bool(bw >= 24 * scale and bh >= 16 * scale and (tight.mean() >= 0.6 or edges >= 0.8))
        if not panel and np.abs(arr[y0:y1, x0:x1].astype(np.int16) - bg).max() < 24:
            continue  # Too faint to read: shadow falloff, not content.
        block = {"x": x0 + offset[0], "y": y0 + offset[1], "w": bw, "h": bh, "panel": panel, "children": []}
        if depth < max_depth and panel and bw > 40 * scale and bh > 40 * scale:
            inset = max(2, int(3 * scale))  # Clears the panel's own border.
            block["inset"] = inset
            block["children"] = find_blocks(arr[y0 + inset:y1 - inset, x0 + inset:x1 - inset],
                                            (block["x"] + inset, block["y"] + inset), depth + 1,
                                            max_depth, scale)
        blocks.append(block)
    return blocks


def box(b):
    return [b["x"], b["y"], b["w"], b["h"]]


def near_misses(panels, tolerance, pt):
    """Surface edges that almost line up are drift. Exact or distant edges are intent.
    Text is excluded: glyph side bearings move ink by a pixel or two with no layout change."""
    issues = []
    for edge, read in (("left", lambda b: b["x"]), ("right", lambda b: b["x"] + b["w"]),
                       ("top", lambda b: b["y"]), ("bottom", lambda b: b["y"] + b["h"])):
        ordered = sorted(((read(b), i) for i, b in enumerate(panels)))
        for (first, i), (second, j) in zip(ordered, ordered[1:]):
            if 0 < second - first <= tolerance:
                issues.append({"edge": edge, "off_pt": pt(second - first),
                               "a": box(panels[i]), "b": box(panels[j])})
    return issues


def twin_groups(panels, scale):
    """Panels of one size are one repeated component, so they must agree with each other."""
    groups = collections.defaultdict(list)
    for b in panels:
        groups[(round(b["w"] / (4 * scale)), round(b["h"] / (4 * scale)))].append(b)
    return [g for g in groups.values() if len(g) >= 2]


def uneven_gaps(group, scale, pt):
    found = []
    for axis, start, size, cross, cross_size in (("h", "x", "w", "y", "h"), ("v", "y", "h", "x", "w")):
        lines = collections.defaultdict(list)
        for b in group:
            lines[round(b[cross] / (b[cross_size] * 0.5))].append(b)
        for line in lines.values():
            line.sort(key=lambda b: b[start])
            sizes = [b[start] - a[start] - a[size] for a, b in zip(line, line[1:])]
            if len(sizes) >= 2 and len(set(sizes)) > 1 and max(sizes) - min(sizes) <= 16 * scale:
                found.append({"axis": axis, "gaps_pt": [pt(g) for g in sizes], "boxes": [box(b) for b in line]})
    return found


def padding_of(b):
    kids = b["children"]
    return {"left": min(k["x"] for k in kids) - b["x"],
            "top": min(k["y"] for k in kids) - b["y"],
            "right": b["x"] + b["w"] - max(k["x"] + k["w"] for k in kids),
            "bottom": b["y"] + b["h"] - max(k["y"] + k["h"] for k in kids)}


def clipped_ink(b, scale, pt):
    """Ink flush against one edge of a padded surface is the signature of overflow or truncation."""
    rows = []
    limit = b.get("inset", 0) + scale
    roomy = 8 * scale
    for k in b["children"]:
        if k["panel"]:
            continue
        gaps_h = (k["x"] - b["x"], b["x"] + b["w"] - k["x"] - k["w"])
        gaps_v = (k["y"] - b["y"], b["y"] + b["h"] - k["y"] - k["h"])
        for side, near, far in (("right", gaps_h[1], gaps_h[0]), ("bottom", gaps_v[1], gaps_v[0])):
            if near <= limit and far >= roomy:
                rows.append({"side": side, "ink": box(k), "panel": box(b), "gap_pt": pt(near)})
    return rows


def analyze_layout(blocks, scale):
    pt = lambda v: round(v / scale, 1)
    report = {"near_misses": [], "uneven_gaps": [], "padding_drift": [], "clipped_ink": []}

    def walk(siblings):
        panels = [b for b in siblings if b["panel"]]
        report["near_misses"].extend(near_misses(panels, max(3, int(3 * scale)), pt))
        for group in twin_groups(panels, scale):
            report["uneven_gaps"].extend(uneven_gaps(group, scale, pt))
            pads = [(b, padding_of(b)) for b in group if b["children"]]
            if len(pads) >= 2:
                # Bottom and right depend on content length, so only top and left are compared.
                for side in ("left", "top"):
                    usual = collections.Counter(p[side] for _, p in pads).most_common(1)[0][0]
                    for b, pad in pads:
                        if abs(pad[side] - usual) > 2 * scale:  # Side bearings cover the rest.
                            report["padding_drift"].append({"box": box(b), "side": side, "pt": pt(pad[side]),
                                                            "siblings_pt": pt(usual)})
        for b in panels:
            report["clipped_ink"].extend(clipped_ink(b, scale, pt))
            walk(b["children"])

    walk(blocks)
    return report


# ---------------------------------------------------------------- diff against a reference
def fit_reference(ref, shot, notes):
    if ref.size == shot.size:
        return ref
    ratio = (ref.width / ref.height) / (shot.width / shot.height)
    if abs(ratio - 1) < 0.01:
        notes.append(f"reference {ref.size} rescaled to {shot.size}, so sub-pixel deltas are unreliable")
        return ref.resize(shot.size, Image.LANCZOS)
    notes.append(f"reference {ref.size} has a different aspect from {shot.size}: compared top-left overlap")
    canvas = Image.new("RGB", shot.size, (0, 0, 0))
    canvas.paste(ref, (0, 0))
    return canvas


def ink_mask(arr):
    gray = arr.astype(np.float32).mean(axis=2)
    return np.abs(gray - np.median(gray)) > 6


def estimate_shift(ref_arr, shot_arr, bbox, reach):
    """Finds the move that explains a region, on ink shape so a color change cannot hide it."""
    x, y, w, h = bbox
    H, W = shot_arr.shape[:2]
    x0, y0, x1, y1 = max(0, x - reach), max(0, y - reach), min(W, x + w + reach), min(H, y + h + reach)
    a, b = ink_mask(ref_arr[y0:y1, x0:x1]), ink_mask(shot_arr[y0:y1, x0:x1])
    if a.sum() < 8 or b.sum() < 8:
        return None
    corr = signal.fftconvolve(b.astype(np.float32), a[::-1, ::-1].astype(np.float32), mode="full")
    cy, cx = a.shape[0] - 1, a.shape[1] - 1
    top, left = max(0, cy - reach), max(0, cx - reach)
    window = corr[top:cy + reach + 1, left:cx + reach + 1]
    py, px = np.unravel_index(int(np.argmax(window)), window.shape)
    dy, dx = int(py + top - cy), int(px + left - cx)
    if (dx, dy) == (0, 0):
        return None

    def iou(mx, my):
        moved = np.zeros_like(a)
        moved[max(0, my):a.shape[0] + min(0, my), max(0, mx):a.shape[1] + min(0, mx)] = \
            a[max(0, -my):a.shape[0] - max(0, my), max(0, -mx):a.shape[1] - max(0, mx)]
        return (moved & b).sum() / max(1, (moved | b).sum())

    return [dx, dy] if iou(dx, dy) >= 0.5 and iou(dx, dy) > iou(0, 0) + 0.1 else None


def signature(arr):
    found = colors(arr, min_share=0.004)
    if not found:
        return None, None
    bg = found[0]
    fg = max(found[1:], key=lambda c: contrast_ratio(c["rgb"], bg["rgb"])) if len(found) > 1 else None
    return bg["hex"], fg["hex"] if fg else None


def diff_regions(ref, shot, scale):
    ref_arr, shot_arr = np.asarray(ref), np.asarray(shot)
    delta = np.abs(ref_arr.astype(np.int16) - shot_arr.astype(np.int16)).max(axis=2)
    mask = delta > 6
    size = max(9, int(9 * scale))
    labels, _ = ndimage.label(ndimage.binary_dilation(mask, structure=np.ones((size, size))))
    regions = []
    for index, slc in enumerate(ndimage.find_objects(labels), start=1):
        inner = (labels[slc] == index) & mask[slc]
        ys, xs = np.where(inner)
        if len(xs) < 4:
            continue
        y0, y1 = slc[0].start + int(ys.min()), slc[0].start + int(ys.max()) + 1
        x0, x1 = slc[1].start + int(xs.min()), slc[1].start + int(xs.max()) + 1
        bbox = [x0, y0, x1 - x0, y1 - y0]
        moved = estimate_shift(ref_arr, shot_arr, bbox, int(16 * scale))
        bg_before, ink_before = signature(ref_arr[y0:y1, x0:x1])
        bg_after, ink_after = signature(shot_arr[y0:y1, x0:x1])
        region = {"box": bbox, "changed_px": int(len(xs))}
        if moved:
            region["moved_pt"] = [round(moved[0] / scale, 1), round(moved[1] / scale, 1)]
        if bg_before != bg_after:
            region["fill"] = [bg_before, bg_after]
        if ink_before != ink_after:
            region["ink"] = [ink_before, ink_after]
        regions.append(region)
    regions.sort(key=lambda r: -r["changed_px"])
    return regions, round(100 * float(mask.mean()), 3)


# ---------------------------------------------------------------- tokens
def flatten_tokens(node, prefix=""):
    found = {}
    if isinstance(node, dict):
        for key, value in node.items():
            found.update(flatten_tokens(value, f"{prefix}.{key}" if prefix else key))
    elif isinstance(node, str) and node.startswith("#") and len(node) in (4, 7, 9):
        found[prefix] = node[:7]
    return found


def check_tokens(palette, tokens):
    rows = []
    for color in palette:
        name, value = min(tokens.items(), key=lambda kv: delta_e(color["rgb"], from_hex(kv[1])))
        de = delta_e(color["rgb"], from_hex(value))
        if de > 2.3 or (de > 0.7 and color["pct"] >= 1):  # 2.3 is about one just-noticeable difference.
            rows.append({"hex": color["hex"], "pct": color["pct"], "nearest": name,
                         "nearest_hex": value, "delta_e": round(de, 1)})
    return rows


# ---------------------------------------------------------------- measure
def measure(shot_path, ref_path=None, tokens_path=None, scale=1):
    shot = load(shot_path)
    arr = np.asarray(shot)
    notes = []
    blocks = find_blocks(arr, scale=scale)
    report = {
        "image": {"path": str(shot_path), "w": shot.width, "h": shot.height, "scale": scale},
        "palette": [{k: c[k] for k in ("hex", "pct")} for c in colors(arr)],
        "layout": analyze_layout(blocks, scale),
        "blocks": len(blocks),
        "low_contrast": [],
        "units": "*_pt fields are CSS px or points (image px / scale). Boxes are [x, y, w, h] in image px.",
        "notes": notes,
    }
    seen = set()

    def walk(items):
        for b in items:
            if b["children"]:
                walk(b["children"])
                continue
            c = box_contrast(arr[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]])
            if c and c["ratio"] < 4.5 and (c["bg"], c["fg"]) not in seen:
                seen.add((c["bg"], c["fg"]))
                report["low_contrast"].append({"box": box(b), **c})

    walk(blocks)
    if tokens_path:
        tokens = flatten_tokens(json.loads(pathlib.Path(tokens_path).read_text()))
        report["off_token_colors"] = check_tokens(colors(arr, merge=2), tokens) if tokens else []
    regions = []
    ref = None
    if ref_path:
        ref = fit_reference(load(ref_path), shot, notes)
        regions, pct = diff_regions(ref, shot, scale)
        report["diff"] = {"changed_pct": pct, "region_count": len(regions)}
        for i, region in enumerate(regions, start=1):
            region["id"] = f"R{i}"
    else:
        flat = sorted(blocks, key=lambda b: -(b["w"] * b["h"]))
        regions = [{"id": f"T{i}", "box": box(b)} for i, b in enumerate(flat, start=1)]
    report["regions"] = regions
    return report, shot, ref


# ---------------------------------------------------------------- what the models see
def zoom_crop(img, b, margin):
    x, y, w, h = b
    left, top = max(0, x - margin), max(0, y - margin)
    right, bottom = min(img.width, x + w + margin), min(img.height, y + h + margin)
    crop = img.crop((left, top, right, bottom))
    factor = max(1, min(4, 900 // max(crop.width, crop.height, 1)))
    return crop.resize((crop.width * factor, crop.height * factor), Image.NEAREST) if factor > 1 else crop


def crops_for_models(report, shot, ref, scale):
    margin = int(32 * scale)
    crops = []
    for region in report["regions"][:MAX_CROPS]:
        after = zoom_crop(shot, region["box"], margin)
        if ref is None:
            crops.append((f"{region['id']}: zoomed crop", after))
            continue
        before = zoom_crop(ref, region["box"], margin)
        gutter = 16
        sheet = Image.new("RGB", (before.width + after.width + gutter, max(before.height, after.height)), (255, 0, 255))
        sheet.paste(before, (0, 0))
        sheet.paste(after, (before.width + gutter, 0))
        crops.append((f"{region['id']}: REFERENCE on the left, CURRENT on the right, magenta divider", sheet))
    return crops


def annotate(report, shot, path):
    """Numbered boxes on the frame and a legend beside it, so labels never cover the UI."""
    marks = collections.OrderedDict()

    def add(bbox, color, label):
        marks.setdefault(tuple(bbox), (color, []))[1].append(label)

    layout = report["layout"]
    for row in layout["clipped_ink"]:
        add(row["ink"], (255, 120, 50), "clipped at " + row["side"])
    for row in layout["padding_drift"]:
        add(row["box"], (255, 214, 64), "%s padding %g vs %gpt on its twins" % (row["side"], row["pt"], row["siblings_pt"]))
    for row in layout["near_misses"]:
        add(row["b"], (80, 220, 255), "%s edge off by %gpt" % (row["edge"], row["off_pt"]))
    for row in layout["uneven_gaps"]:
        add(row["boxes"][-1], (120, 230, 120), "gaps %spt" % " / ".join("%g" % g for g in row["gaps_pt"]))
    for row in report["low_contrast"]:
        add(row["box"], (200, 160, 255), "contrast %g on %s" % (row["ratio"], row["bg"]))
    for region in report["regions"][:MAX_CROPS]:
        if "changed_px" not in region:
            continue
        parts = [region["id"]]
        if region.get("moved_pt"):
            parts.append("moved %g,%gpt" % tuple(region["moved_pt"]))
        if region.get("fill"):
            parts.append("fill %s to %s" % tuple(region["fill"]))
        if region.get("ink") and all(region["ink"]):
            parts.append("ink %s to %s" % tuple(region["ink"]))
        add(region["box"], (255, 92, 170), " ".join(parts))
    if not marks:
        shot.save(path)
        return
    scale = report["image"]["scale"]
    font = ImageFont.load_default(size=int(13 * scale))
    row_h, gutter = int(22 * scale), int(14 * scale)
    tag_w = int(24 * scale)
    lines = ["; ".join(labels) for _, labels in marks.values()]
    legend_w = gutter * 2 + tag_w + int(max(font.getlength(t) for t in lines)) + gutter
    height = max(shot.height, gutter * 2 + row_h * len(marks))
    canvas = Image.new("RGB", (shot.width + legend_w, height), (20, 20, 22))
    canvas.paste(shot, (0, 0))
    draw = ImageDraw.Draw(canvas)

    def tag(x, y, color, number):
        draw.rectangle((x, y, x + tag_w, y + int(16 * scale)), fill=color)
        draw.text((x + tag_w / 2, y + int(8 * scale)), str(number), fill=(0, 0, 0), font=font, anchor="mm")

    for number, ((x, y, w, h), (color, _)) in enumerate(marks.items(), start=1):
        draw.rectangle((x, y, x + w, y + h), outline=color, width=max(1, int(scale)))
    tag_h = int(16 * scale)
    used = []
    for number, ((x, y, w, h), (color, _)) in enumerate(marks.items(), start=1):
        tx, ty = x, max(0, y - tag_h)  # Sits above the box, stepping right past any earlier tag.
        while any(abs(tx - ux) < tag_w + 2 and abs(ty - uy) < tag_h for ux, uy in used):
            tx += tag_w + 2
        used.append((tx, ty))
        tag(tx, ty, color, number)
        row_y = gutter + (number - 1) * row_h
        tag(shot.width + gutter, row_y, color, number)
        draw.text((shot.width + gutter * 2 + tag_w, row_y + int(8 * scale)), lines[number - 1],
                  fill=(232, 232, 228), font=font, anchor="lm")
    canvas.save(path)


def png_b64(img):
    w, h = img.size
    patches = math.ceil(w / 32) * math.ceil(h / 32)
    if patches > MAX_PATCHES:
        shrink = math.sqrt(MAX_PATCHES / patches) * 0.98
        img = img.resize((int(w * shrink), int(h * shrink)), Image.LANCZOS)
    buffer = io.BytesIO()
    img.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


# ---------------------------------------------------------------- model calls
def post(url, headers, payload):
    request = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read())


def parse_json(text):
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in model output: {text[:200]!r}")
    return json.loads(text[start:end + 1])


def call_openai(images, prompt, schema, name):
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return {"model": OPENAI_MODEL, "error": "OPENAI_API_KEY not set"}

    def payload(detail):
        content = [{"type": "input_text", "text": prompt}]
        for label, img in images:
            content.append({"type": "input_text", "text": label})
            content.append({"type": "input_image", "image_url": "data:image/png;base64," + png_b64(img),
                            "detail": detail})
        return {"model": OPENAI_MODEL, "reasoning": {"effort": "high"},
                "text": {"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
                "input": [{"role": "user", "content": content}]}

    headers = {"Authorization": f"Bearer {key}"}
    url = f"{OPENAI_BASE}/v1/responses"
    try:
        detail = "original"
        try:
            data = post(url, headers, payload(detail))
        except urllib.error.HTTPError as err:
            if err.code != 400:
                raise
            detail = "high"  # GPT-6.1 Terra is missing from OpenAI's sizing table.
            data = post(url, headers, payload(detail))
        text = "".join(c.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                       for c in item.get("content", []) if c.get("type") == "output_text")
        return {"model": OPENAI_MODEL, "detail": detail, "usage": data.get("usage"), "result": parse_json(text)}
    except Exception as err:  # One failed eye must not blind the other.
        return {"model": OPENAI_MODEL, "error": describe(err)}


def call_gemini(images, prompt, schema, name):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return {"model": GEMINI_MODEL, "error": "GEMINI_API_KEY not set"}
    content = []
    for label, img in images:
        content.append({"type": "text", "text": label})
        content.append({"type": "image", "data": png_b64(img), "mime_type": "image/png", "resolution": "ultra_high"})
    shape = json.dumps(schema, separators=(",", ":"))
    content.append({"type": "text", "text": f"{prompt}\n\nReturn only one JSON object matching this schema:\n{shape}"})
    body = {"model": GEMINI_MODEL, "input": content, "generation_config": {"thinking_level": "high"}}
    headers = {"x-goog-api-key": key, "Api-Revision": "2026-05-20"}
    try:
        data = post(f"{GEMINI_BASE}/v1beta/interactions", headers, body)
        text = "".join(c.get("text", "") for step in data.get("steps", []) if step.get("type") == "model_output"
                       for c in step.get("content", []) if c.get("type") == "text")
        return {"model": GEMINI_MODEL, "usage": data.get("usage"), "result": parse_json(text)}
    except Exception as err:
        return {"model": GEMINI_MODEL, "error": describe(err)}


def describe(err):
    if isinstance(err, urllib.error.HTTPError):
        return f"HTTP {err.code}: {err.read()[:400].decode('utf-8', 'replace')}"
    return f"{type(err).__name__}: {err}"


# ---------------------------------------------------------------- review and A/B
REVIEW_PROMPT = """You are a senior product designer reviewing a rendered UI.

MEASURED is ground truth computed from the actual pixels. Use its numbers, and never estimate a pixel value or hex yourself.
The first image is the full frame. The others are zoomed crops labeled with a region id, enlarged with nearest-neighbour scaling.
{ref_note}
Report only what a designer would change. For each finding, cite the region id ("frame" if it spans the screen) and give a concrete fix.
Measurement owns distances, colors, and clipped ink. You own what numbers cannot settle: hierarchy, density, rhythm, grouping, overlapping elements, and whether the screen matches the brief.
Do not report a problem you cannot point to. An empty findings list is a valid answer.

BRIEF: {brief}

MEASURED:
{measured}
"""


def merge_findings(answers):
    """A finding two models reach independently outranks anything either says alone."""
    rank = {"high": 0, "med": 1, "low": 2}
    grouped = collections.OrderedDict()
    for answer in answers:
        for finding in (answer.get("result") or {}).get("findings", []):
            key = (finding["region"], finding["category"])
            grouped.setdefault(key, {"region": key[0], "category": key[1], "severity": finding["severity"],
                                     "seen_by": [], "notes": []})
            row = grouped[key]
            if answer["model"] not in row["seen_by"]:
                row["seen_by"].append(answer["model"])
            row["notes"].append({"model": answer["model"], "what": finding["what"], "fix": finding["fix"]})
            if rank[finding["severity"]] < rank[row["severity"]]:
                row["severity"] = finding["severity"]
    rows = list(grouped.values())
    for row in rows:
        row["confirmed"] = len(row["seen_by"]) >= 2
    rows.sort(key=lambda r: (not r["confirmed"], rank[r["severity"]]))
    return rows


def review_measured(report, shot, ref, brief, scale):
    images = [("Full frame", shot)] + crops_for_models(report, shot, ref, scale)
    ref_note = ("Each crop places the reference beside the current render: judge divergence from the reference."
                if ref else "No reference was supplied: judge against the brief.")
    prompt = REVIEW_PROMPT.format(ref_note=ref_note, brief=brief or "(none)",
                                  measured=json.dumps(report, separators=(",", ":")))
    with ThreadPoolExecutor(2) as pool:
        jobs = [pool.submit(call, images, prompt, FINDINGS_SCHEMA, "ui_review")
                for call in (call_openai, call_gemini)]
        answers = [job.result() for job in jobs]
    report["findings"] = merge_findings(answers)
    report["models"] = answers
    return report


def run_review(args):
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report, shot, ref = measure(args.shot, args.ref, args.tokens, args.scale)
    annotate(report, shot, out / "annotated.png")
    review_measured(report, shot, ref, args.brief, args.scale)
    report["annotated"] = str(out / "annotated.png")
    (out / "report.json").write_text(json.dumps(report, indent=2))
    return report


def settle_ab(rows):
    """Keeps a verdict only when a model holds it in both orders, and models do not split."""
    stable = {}
    for model, (first, second) in rows.items():
        if first in ("A", "B") and first == second:
            stable[model] = first
    votes = set(stable.values())
    verdict = votes.pop() if len(votes) == 1 else "no_call"
    return verdict, stable


def run_ab(args):
    a, b = load(args.a), load(args.b)
    prompt = ("Two versions of one UI. Judge only the visual design.\n"
              f"BRIEF: {args.brief or 'overall visual quality'}\n"
              "Pick the better image: 1 or 2. Base the choice on what you can see, never on the order shown.")
    orders = (("AB", [("Image 1", a), ("Image 2", b)], {1: "A", 2: "B"}),
              ("BA", [("Image 1", b), ("Image 2", a)], {1: "B", 2: "A"}))
    with ThreadPoolExecutor(4) as pool:
        jobs = [(tag, mapping, pool.submit(call, images, prompt, AB_SCHEMA, "ui_ab"))
                for call in (call_openai, call_gemini) for tag, images, mapping in orders]
        done = [(tag, mapping, job.result()) for tag, mapping, job in jobs]
    rows = collections.defaultdict(dict)
    detail = []
    for tag, mapping, answer in done:
        winner = str((answer.get("result") or {}).get("winner", ""))
        pick = mapping.get(int(winner)) if winner in ("1", "2") else None
        rows[answer["model"]][tag] = pick
        detail.append({"model": answer["model"], "order": tag, "picked": pick,
                       "why": (answer.get("result") or {}).get("why"), "error": answer.get("error")})
    verdict, stable = settle_ab({m: (o.get("AB"), o.get("BA")) for m, o in rows.items()})
    return {"verdict": verdict, "stable_models": stable, "calls": detail,
            "note": "no_call means the answer changed with image order or the models split."}


# ---------------------------------------------------------------- check: page in, verdict out
class CheckError(Exception):
    pass


def parse_viewport(value):
    try:
        w, h = (int(v) for v in value.lower().split("x"))
        if w < 200 or h < 200:
            raise ValueError
    except ValueError:
        raise CheckError(f"--viewport must look like 1440x900, got {value!r}")
    return w, h


def capture_page(args, out):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise CheckError("check needs Playwright: pip install playwright && python3 -m playwright install chromium")
    width, height = parse_viewport(args.viewport)
    console_errors = []
    with sync_playwright() as p:
        try:
            browser = getattr(p, args.browser).launch(headless=True)
        except Exception as err:
            raise CheckError(f"could not launch {args.browser} "
                             f"(run: python3 -m playwright install {args.browser}): {err}")
        try:
            page = browser.new_page(viewport={"width": width, "height": height},
                                    device_scale_factor=args.scale)
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: console_errors.append(str(err)))
            try:
                page.goto(args.url, wait_until="load", timeout=30000)
            except Exception as err:
                raise CheckError(f"could not load {args.url}: {err}")
            try:
                page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            try:
                if args.wait_for:
                    page.wait_for_selector(args.wait_for, timeout=10000)
                for selector in args.click:
                    page.click(selector)
                    page.wait_for_timeout(args.wait)
                for selector, text in args.fill:
                    page.fill(selector, text)
                    page.wait_for_timeout(args.wait)
                for selector in args.hover:
                    page.hover(selector)
                    page.wait_for_timeout(args.wait)
                page.wait_for_timeout(args.wait)
            except Exception as err:
                raise CheckError(f"could not trigger the requested state on {args.url}: {err}")
            page.screenshot(path=str(out / "page.png"))
            matched = 1
            if args.focus:
                matched = page.locator(args.focus).count()
                try:
                    page.locator(args.focus).first.wait_for(state="visible", timeout=10000)
                    page.locator(args.focus).first.screenshot(path=str(out / "crop.png"))
                except Exception as err:
                    raise CheckError(f"--focus selector not found or not visible: {args.focus!r} "
                                     f"({matched} match(es)): {err}")
            meta = {"url": args.url, "focus": args.focus, "matched": matched, "viewport": [width, height],
                    "device_scale_factor": args.scale, "title": page.title(),
                    "console_errors": console_errors[:20]}
        finally:
            browser.close()
    return meta


def red_rows(report):
    rows = []
    for key, kind in (("near_misses", "near_miss"), ("uneven_gaps", "uneven_gap"),
                      ("padding_drift", "padding_drift"), ("clipped_ink", "clipped_ink")):
        for row in report["layout"][key]:
            rows.append({"kind": kind, **row})
    for row in report["low_contrast"]:
        rows.append({"kind": "low_contrast", **row})
    for row in report.get("off_token_colors", []):
        rows.append({"kind": "off_token_color", **row})
    for finding in report.get("findings", []):
        if finding.get("confirmed"):
            rows.append({"kind": "confirmed_finding", "region": finding["region"], "category": finding["category"],
                         "severity": finding["severity"],
                         "what": finding["notes"][0]["what"] if finding["notes"] else ""})
    return rows


def run_check(args):
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    meta = capture_page(args, out)
    crop = out / "crop.png" if args.focus else out / "page.png"
    report, shot, ref = measure(str(crop), args.ref, args.tokens, args.scale)
    annotate(report, shot, out / "annotated.png")
    if args.review:
        review_measured(report, shot, ref, args.brief, args.scale)
    report["page"] = meta
    report["crop"] = str(crop)
    report["page_shot"] = str(out / "page.png")
    report["annotated"] = str(out / "annotated.png")
    red = red_rows(report)
    report["gate"] = {"passed": not red, "red_count": len(red), "red": red,
                      "exit_codes": {"clean": 0, "red_rows": 1, "tool_error": 2}}
    (out / "report.json").write_text(json.dumps(report, indent=2))
    return report, (1 if red else 0)


def main():
    parser = argparse.ArgumentParser(description="UI vision specialist")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("measure", "review"):
        p = sub.add_parser(name)
        p.add_argument("shot")
        p.add_argument("--ref")
        p.add_argument("--tokens", help="JSON of design tokens, flat or nested, with hex values")
        p.add_argument("--scale", type=float, default=1, help="device pixel ratio of the screenshot")
        p.add_argument("--out", default="eye_out")
        if name == "review":
            p.add_argument("--brief", default="")
    p = sub.add_parser("ab")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--brief", default="")
    p = sub.add_parser("check", help="open a page, screenshot one region, measure it, and gate on red rows")
    p.add_argument("url")
    p.add_argument("--focus", help="CSS selector of the region to check; without it the viewport is checked")
    p.add_argument("--ref", help="previous screenshot of the same region, for diffs")
    p.add_argument("--tokens", help="JSON of design tokens, flat or nested, with hex values")
    p.add_argument("--scale", type=float, default=2,
                   help="device pixel ratio to capture at (default 2); every *_pt value divides by this")
    p.add_argument("--viewport", default="1440x900", help="WxH, e.g. 1440x900")
    p.add_argument("--browser", default="chromium", choices=["chromium", "firefox", "webkit"])
    p.add_argument("--wait", type=int, default=250, help="ms to settle after load and after each action")
    p.add_argument("--wait-for", help="CSS selector that must appear before capturing")
    p.add_argument("--click", action="append", default=[], metavar="SELECTOR", help="repeatable")
    p.add_argument("--fill", action="append", nargs=2, default=[], metavar=("SELECTOR", "TEXT"), help="repeatable")
    p.add_argument("--hover", action="append", default=[], metavar="SELECTOR", help="repeatable")
    p.add_argument("--review", action="store_true", help="also send crops to both models (needs API keys)")
    p.add_argument("--brief", default="")
    p.add_argument("--out", default="eye_out")
    args = parser.parse_args()
    code = 0
    if args.command == "measure":
        report, shot, _ = measure(args.shot, args.ref, args.tokens, args.scale)
        out = pathlib.Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        annotate(report, shot, out / "annotated.png")
        report["annotated"] = str(out / "annotated.png")
    elif args.command == "review":
        report = run_review(args)
    elif args.command == "ab":
        report = run_ab(args)
    else:
        try:
            report, code = run_check(args)
        except CheckError as err:
            print(f"eye check: {err}", file=sys.stderr)
            sys.exit(2)
    json.dump(report, sys.stdout, indent=2)
    print()
    if args.command == "check":
        gate = report["gate"]
        print(f"eye check: {gate['red_count']} red row(s) -> exit {code}; annotated: {report['annotated']}",
              file=sys.stderr)
        sys.exit(code)


if __name__ == "__main__":
    main()
