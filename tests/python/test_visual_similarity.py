import importlib.util
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


SCRIPT = Path(__file__).parents[2] / "tools" / "labelfetch" / "visual-similarity.py"
SPEC = importlib.util.spec_from_file_location("visual_similarity", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RatioMatchesTest(unittest.TestCase):
    def test_sparse_neighbor_list_does_not_abort_comparison(self):
        # One train descriptor forces OpenCV to return one neighbor even though
        # k=2. This was the production canary crash exposed by the 10+5 window.
        query = np.zeros((2, 128), dtype=np.float32)
        train = np.zeros((1, 128), dtype=np.float32)
        self.assertEqual(MODULE.ratio_matches(query, train), [])

    def test_missing_descriptors_are_not_matches(self):
        self.assertEqual(MODULE.ratio_matches(None, None), [])

    def test_features_accept_a_16_bit_png(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sixteen-bit.png"
            image = np.zeros((640, 320, 3), dtype=np.uint16)
            cv2.rectangle(image, (90, 50), (230, 590), (65535, 65535, 65535), -1)
            self.assertTrue(cv2.imwrite(str(path), image))
            result = MODULE.features(path)
            self.assertEqual(result["gray"].dtype, np.uint8)


if __name__ == "__main__":
    unittest.main()
