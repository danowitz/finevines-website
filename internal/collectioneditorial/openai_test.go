package collectioneditorial

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAIResearcherUsesCatalogBriefAndParsesDraft(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request["input"] == nil || request["tools"] == nil {
			t.Fatalf("request missing input or web search: %#v", request)
		}
		_, _ = w.Write([]byte(`{"output_text":"{\"publishable\":true,\"changed\":true,\"eyebrow\":\"Inside the Region\",\"heading\":\"Burgundy rewards attention to place\",\"paragraphs\":[\"Burgundy is organized around precisely defined places, where growers work with Pinot Noir and Chardonnay across a compact landscape. Village names and vineyard boundaries matter because slope, exposure, drainage, and local farming choices can shape wines made only a short distance apart. This structure gives buyers a practical way to compare origin without relying on broad style claims or scores.\",\"The FineVines selection connects that geography to producers working across several appellations and vineyard settings. Reading the portfolio by region makes it easier to move from a general Burgundy bottling toward village and site-specific examples, while producer pages reveal how individual cellars interpret related places. Together, those paths support useful comparisons for restaurant lists, thoughtful retail shelves, and staff education.\"],\"sources\":[{\"label\":\"Wine board\",\"url\":\"https://example.com/source\"}]}"}`))
	}))
	defer server.Close()

	researcher := NewOpenAIResearcher("key", "gpt-test", server.URL, server.Client())
	draft, err := researcher.Research(context.Background(), Assignment{Reason: NewCollection, Candidate: Candidate{Kind: Region, Name: "Burgundy", Slug: "burgundy"}})
	if err != nil {
		t.Fatal(err)
	}
	if !draft.Publishable || draft.Heading != "Burgundy rewards attention to place" {
		t.Fatalf("draft = %+v", draft)
	}
}

func TestParseDraftRejectsCopyOutsideTheEditorialWordRange(t *testing.T) {
	_, err := parseDraft(`{"publishable":true,"changed":true,"heading":"Too short","paragraphs":["Only a few words.","Still far too short."],"sources":[{"label":"Authority","url":"https://example.com"}]}`)
	if err == nil {
		t.Fatal("short generated copy was accepted")
	}
}
