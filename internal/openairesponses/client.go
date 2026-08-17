// Package openairesponses contains the shared OpenAI Responses API transport.
// Domain modules own their prompts and parsing; this module owns request shape,
// authentication, web-search tool wiring, HTTP errors, and output extraction.
package openairesponses

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Client struct {
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

type Request struct {
	Instructions    string
	Input           string
	MaxOutputTokens int
	WebSearch       bool
}

func New(apiKey, model, baseURL string, hc *http.Client) *Client {
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{apiKey: apiKey, model: model, baseURL: strings.TrimSuffix(baseURL, "/"), http: hc}
}

func (c *Client) Call(ctx context.Context, request Request) (string, error) {
	if request.MaxOutputTokens <= 0 {
		request.MaxOutputTokens = 2000
	}
	body := map[string]any{
		"model":             c.model,
		"instructions":      request.Instructions,
		"input":             request.Input,
		"max_output_tokens": request.MaxOutputTokens,
	}
	if request.WebSearch {
		body["tools"] = []map[string]string{{"type": "web_search"}}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/responses", bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(httpRequest)
	if err != nil {
		return "", fmt.Errorf("openai responses: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return "", fmt.Errorf("openai responses: read body: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("openai responses: HTTP %d: %s", response.StatusCode, snippet(data))
	}
	return outputText(data)
}

func outputText(data []byte) (string, error) {
	var parsed struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return "", fmt.Errorf("openai responses: decode: %w", err)
	}
	if strings.TrimSpace(parsed.OutputText) != "" {
		return parsed.OutputText, nil
	}
	var output strings.Builder
	for _, item := range parsed.Output {
		if item.Type != "message" {
			continue
		}
		for _, content := range item.Content {
			if content.Type == "output_text" {
				output.WriteString(content.Text)
			}
		}
	}
	if strings.TrimSpace(output.String()) == "" {
		return "", fmt.Errorf("openai responses: response contained no output text")
	}
	return output.String(), nil
}

func snippet(data []byte) string {
	const max = 300
	if len(data) > max {
		return string(data[:max]) + "..."
	}
	return string(data)
}
