package model

import "strings"

var foldTable = map[rune]string{
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a", 'æ': "ae",
	'ç': "c", 'è': "e", 'é': "e", 'ê': "e", 'ë': "e",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i",
	'ñ': "n", 'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o", 'ø': "o", 'œ': "oe",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u", 'ý': "y", 'ÿ': "y", 'ß': "ss",
}

// Slugify joins parts into a lowercase URL slug: accented Latin characters
// fold to ASCII, every other non-alphanumeric run collapses to one hyphen.
func Slugify(parts ...string) string {
	var b strings.Builder
	for _, part := range parts {
		for _, r := range strings.ToLower(part) {
			switch {
			case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
				b.WriteRune(r)
			default:
				if folded, ok := foldTable[r]; ok {
					b.WriteString(folded)
				} else {
					b.WriteByte('-')
				}
			}
		}
		b.WriteByte('-')
	}
	slug := b.String()
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	return strings.Trim(slug, "-")
}
