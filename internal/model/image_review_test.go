package model

import "testing"

func TestReopenImageReviewClearsImageProvenanceAndRecomputesScore(t *testing.T) {
	wine := Wine{
		ImagePath: "assets/img/wines/wrong.jpg", ImageSource: ImageScrapedWeb,
		Sources:       map[string]FieldSource{"image": SourceFound, "description": SourceFound},
		MetadataScore: MetadataScore(map[string]FieldSource{"image": SourceFound, "description": SourceFound}),
	}

	wine.ReopenImageReview("assets/img/wines/wine.svg")

	if wine.ImagePath != "assets/img/wines/wine.svg" || wine.ImageSource != ImageGeneratedLabel {
		t.Fatalf("fallback image was not recorded: %+v", wine)
	}
	if wine.Sources["image"] != SourceDerived {
		t.Fatalf("image source = %q, want derived", wine.Sources["image"])
	}
	if wine.MetadataScore != MetadataScore(wine.Sources) {
		t.Fatalf("metadata score = %d, want recomputed %d", wine.MetadataScore, MetadataScore(wine.Sources))
	}
}
