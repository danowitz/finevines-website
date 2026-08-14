"""Build one model image containing a readable label and the full product shot.

The API still receives one image per candidate. This replaces whitespace and
capsule pixels with a locally enlarged, edge-selected label band, then adds a
small inset of the complete frame so multi-bottle shots remain visible. It adds
no model call and keeps the output dimensions fixed.
"""
import sys
from pathlib import Path

import cv2
import numpy as np


def foreground(image):
    if image.shape[2] == 4:
        mask = image[:, :, 3] > 12
        bgr = image[:, :, :3]
    else:
        bgr = image[:, :, :3]
        corners = np.concatenate((bgr[:8, :8], bgr[:8, -8:], bgr[-8:, :8], bgr[-8:, -8:]), axis=0)
        ground = np.median(corners.reshape(-1, 3), axis=0)
        mask = np.max(np.abs(bgr.astype(np.float32) - ground), axis=2) > 18
    points = cv2.findNonZero(mask.astype(np.uint8))
    if points is None:
        return bgr
    x, y, width, height = cv2.boundingRect(points)
    return bgr[y:y + height, x:x + width] if width >= 20 and height >= 40 else bgr


def letterbox(image, width=400, height=800):
    scale = min(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(image, (max(1, round(image.shape[1] * scale)), max(1, round(image.shape[0] * scale))))
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    x = (width - resized.shape[1]) // 2
    y = (height - resized.shape[0]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def label_band(bottle):
    """Choose the most text-dense vertical band instead of assuming one label position."""
    gray = cv2.cvtColor(bottle, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    x_gradient = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    y_gradient = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    energy = cv2.magnitude(x_gradient, y_gradient)[:, 25:375].mean(axis=1)
    # Product identity is normally on the body, not the capsule. A mild lower
    # bias keeps embossed shoulders eligible without letting the neck dominate.
    first, last, window = 130, 760, 240
    scores = np.convolve(energy, np.ones(window, dtype=np.float32), mode="valid")
    starts = np.arange(scores.shape[0])
    eligible = (starts >= first) & (starts + window <= last)
    weighted = scores * np.linspace(0.85, 1.15, scores.shape[0])
    weighted[~eligible] = -1
    start = int(np.argmax(weighted)) if np.any(eligible) else 260
    start = max(80, start - 35)
    end = min(790, start + window + 70)
    return bottle[start:end, 25:375]


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: label-crop.py INPUT OUTPUT")
    image = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
    if image is None:
        raise SystemExit(f"cannot decode {sys.argv[1]}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
    bottle = letterbox(foreground(image))
    crop = label_band(bottle)
    crop = cv2.resize(crop, (700, 980), interpolation=cv2.INTER_CUBIC)
    inset = letterbox(foreground(image), width=170, height=330)
    # The inset occupies a bounded corner of the same image. A white keyline
    # keeps it distinct from label artwork without hiding the main text area.
    crop[8:346, 8:186] = 255
    crop[12:342, 12:182] = inset
    output = Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output), crop):
        raise SystemExit(f"cannot write {output}")


if __name__ == '__main__':
    main()
