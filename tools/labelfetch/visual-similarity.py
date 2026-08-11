"""Report pairwise bottle/label similarity using only local OpenCV features.

This is a ranking signal, never an identity verdict. It is intentionally free:
no network and no model API. The caller still needs one readable anchor per
cluster and must reject visible/source vintage conflicts.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def structural_similarity(left, right):
    """Windowed SSIM without the large scikit-image/scipy runtime dependency."""
    left = left.astype(np.float32)
    right = right.astype(np.float32)
    mu_left = cv2.GaussianBlur(left, (11, 11), 1.5)
    mu_right = cv2.GaussianBlur(right, (11, 11), 1.5)
    left_sq = mu_left * mu_left
    right_sq = mu_right * mu_right
    both = mu_left * mu_right
    sigma_left = cv2.GaussianBlur(left * left, (11, 11), 1.5) - left_sq
    sigma_right = cv2.GaussianBlur(right * right, (11, 11), 1.5) - right_sq
    sigma_both = cv2.GaussianBlur(left * right, (11, 11), 1.5) - both
    c1 = 6.5025
    c2 = 58.5225
    score = ((2 * both + c1) * (2 * sigma_both + c2)) / (
        (left_sq + right_sq + c1) * (sigma_left + sigma_right + c2)
    )
    return float(np.mean(score))


def foreground_crop(image):
    # Retailer originals can be enormous. Layout comparison does not need
    # 20-megapixel pixels, so bound work before building a full-size mask.
    longest = max(image.shape[0], image.shape[1])
    if longest > 1600:
        scale = 1600 / longest
        image = cv2.resize(image, (round(image.shape[1] * scale), round(image.shape[0] * scale)))
    if image.shape[2] == 4:
        alpha = image[:, :, 3]
        mask = alpha > 12
        bgr = image[:, :, :3]
    else:
        bgr = image[:, :, :3]
        corners = np.concatenate((bgr[:8, :8], bgr[:8, -8:], bgr[-8:, :8], bgr[-8:, -8:]), axis=0)
        ground = np.median(corners.reshape(-1, 3), axis=0)
        distance = np.max(np.abs(bgr.astype(np.float32) - ground), axis=2)
        mask = distance > 18
    points = cv2.findNonZero(mask.astype(np.uint8))
    if points is None:
        return bgr
    x, y, width, height = cv2.boundingRect(points)
    if width < 20 or height < 40:
        return bgr
    return bgr[y:y + height, x:x + width]


def letterbox(image, width=320, height=640):
    scale = min(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(image, (max(1, round(image.shape[1] * scale)), max(1, round(image.shape[0] * scale))))
    canvas = np.full((height, width, 3), 255, dtype=np.uint8)
    x = (width - resized.shape[1]) // 2
    y = (height - resized.shape[0]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def features(path):
    image = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"cannot decode {path}")
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
    crop = letterbox(foreground_crop(image))
    label = crop[220:560, 35:285]
    gray = cv2.cvtColor(label, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=500, contrastThreshold=0.025)
    keypoints, descriptors = sift.detectAndCompute(gray, None)
    hsv = cv2.cvtColor(label, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram)
    return {
        "gray": cv2.resize(gray, (160, 240)),
        "descriptors": descriptors,
        "keypoints": len(keypoints),
        "histogram": histogram,
    }


def compare(left, right):
    good = 0
    if left["descriptors"] is not None and right["descriptors"] is not None:
        matcher = cv2.BFMatcher(cv2.NORM_L2)
        for first, second in matcher.knnMatch(left["descriptors"], right["descriptors"], k=2):
            if first.distance < 0.72 * second.distance:
                good += 1
    denominator = max(1, min(left["keypoints"], right["keypoints"]))
    sift_ratio = good / denominator
    histogram = float(cv2.compareHist(left["histogram"], right["histogram"], cv2.HISTCMP_CORREL))
    ssim = structural_similarity(left["gray"], right["gray"])
    score = 0.60 * min(1.0, good / 18.0) + 0.25 * max(0.0, histogram) + 0.15 * max(0.0, ssim)
    return {
        "sift_matches": good,
        "sift_ratio": round(sift_ratio, 4),
        "histogram": round(histogram, 4),
        "ssim": round(ssim, 4),
        "score": round(score, 4),
    }


def main(paths):
    cached = [features(Path(path)) for path in paths]
    pairs = []
    for left in range(len(paths)):
        for right in range(left + 1, len(paths)):
            pairs.append({"a": left, "b": right, **compare(cached[left], cached[right])})
    pairs.sort(key=lambda pair: pair["score"], reverse=True)
    print(json.dumps({"files": paths, "pairs": pairs}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: visual-similarity.py image image [more images]")
    main(sys.argv[1:])
