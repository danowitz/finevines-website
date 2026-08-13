import importlib.util
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
