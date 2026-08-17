// Command sfusers prints a read-only inventory of Salesforce User records and
// the metadata useful for deciding which records belong on the public team
// page. It does not apply selection rules or write website data.
//
//	go run ./tools/sfusers
//	go run ./tools/sfusers -active-only
//	go run ./tools/sfusers -website-only
//	go run ./tools/sfusers -json
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/gritautomation/finevines-website/internal/config"
	"github.com/gritautomation/finevines-website/internal/salesforce"
)

const userFields = `Id, Name, FirstName, LastName, Email, Title, Department,
 Division, CompanyName, IsActive, UserType, Profile.Name, UserRole.Name,
 Manager.Name, Phone, MobilePhone, City, State, Country, LastLoginDate, CreatedDate`

type userSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FirstName     string `json:"firstName,omitempty"`
	LastName      string `json:"lastName,omitempty"`
	Email         string `json:"email,omitempty"`
	Title         string `json:"title,omitempty"`
	Department    string `json:"department,omitempty"`
	Division      string `json:"division,omitempty"`
	Company       string `json:"company,omitempty"`
	Active        bool   `json:"active"`
	UserType      string `json:"userType,omitempty"`
	Profile       string `json:"profile,omitempty"`
	Role          string `json:"role,omitempty"`
	Manager       string `json:"manager,omitempty"`
	Phone         string `json:"phone,omitempty"`
	MobilePhone   string `json:"mobilePhone,omitempty"`
	City          string `json:"city,omitempty"`
	State         string `json:"state,omitempty"`
	Country       string `json:"country,omitempty"`
	LastLoginDate string `json:"lastLoginDate,omitempty"`
	CreatedDate   string `json:"createdDate,omitempty"`
}

func main() {
	activeOnly := flag.Bool("active-only", false, "show only active Salesforce users")
	websiteOnly := flag.Bool("website-only", false, "show the active website roster selected by approved roles and temporary exceptions")
	asJSON := flag.Bool("json", false, "print normalized JSON instead of the readable log")
	flag.Parse()

	cfg, err := config.Load(".env")
	if err != nil {
		fatal(err)
	}
	for _, req := range [][2]string{
		{"FINEVINES_SF_BASE_URL", cfg.SFBaseURL},
		{"FINEVINES_SF_CLIENT_ID", cfg.SFClientID},
		{"FINEVINES_SF_CLIENT_SECRET", cfg.SFClientSecret},
	} {
		if req[1] == "" {
			fatal(fmt.Errorf("%s is not set in .env", req[0]))
		}
	}

	client := salesforce.NewClient(salesforce.Config{
		BaseURL:      cfg.SFBaseURL,
		ClientID:     cfg.SFClientID,
		ClientSecret: cfg.SFClientSecret,
		APIVersion:   cfg.SFAPIVersion,
	}, &http.Client{Timeout: 90 * time.Second})
	if *websiteOnly {
		users, err := client.TeamRoster(context.Background())
		if err != nil {
			fatal(err)
		}
		if *asJSON {
			out, err := json.MarshalIndent(users, "", "  ")
			if err != nil {
				fatal(err)
			}
			fmt.Println(string(out))
			return
		}
		fmt.Printf("Salesforce website team: %d active qualifying users\n", len(users))
		for _, user := range users {
			fmt.Printf("  %-12s | %-24s | %-30s | %s\n", user.Role, user.Name, user.Email, user.ID)
		}
		return
	}

	soql := "SELECT " + strings.Join(strings.Fields(userFields), " ") + " FROM User"
	if *activeOnly {
		soql += " WHERE IsActive = true"
	}
	soql += " ORDER BY IsActive DESC, UserType, Name"

	rows, err := client.Query(context.Background(), soql)
	if err != nil {
		fatal(err)
	}
	users := summarize(rows)
	if *asJSON {
		out, err := json.MarshalIndent(users, "", "  ")
		if err != nil {
			fatal(err)
		}
		fmt.Println(string(out))
		return
	}
	printUsers(users)
}

func summarize(rows []map[string]any) []userSummary {
	users := make([]userSummary, 0, len(rows))
	for _, row := range rows {
		users = append(users, userSummary{
			ID:            text(row, "Id"),
			Name:          text(row, "Name"),
			FirstName:     text(row, "FirstName"),
			LastName:      text(row, "LastName"),
			Email:         text(row, "Email"),
			Title:         text(row, "Title"),
			Department:    text(row, "Department"),
			Division:      text(row, "Division"),
			Company:       text(row, "CompanyName"),
			Active:        boolean(row, "IsActive"),
			UserType:      text(row, "UserType"),
			Profile:       relationshipText(row, "Profile", "Name"),
			Role:          relationshipText(row, "UserRole", "Name"),
			Manager:       relationshipText(row, "Manager", "Name"),
			Phone:         text(row, "Phone"),
			MobilePhone:   text(row, "MobilePhone"),
			City:          text(row, "City"),
			State:         text(row, "State"),
			Country:       text(row, "Country"),
			LastLoginDate: text(row, "LastLoginDate"),
			CreatedDate:   text(row, "CreatedDate"),
		})
	}
	return users
}

func printUsers(users []userSummary) {
	active := 0
	types := make(map[string]int)
	for _, user := range users {
		if user.Active {
			active++
		}
		types[valueOrDash(user.UserType)]++
	}
	fmt.Printf("Salesforce users: %d total, %d active, %d inactive\n", len(users), active, len(users)-active)
	keys := make([]string, 0, len(types))
	for key := range types {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Printf("  %-20s %d\n", key, types[key])
	}

	for _, user := range users {
		status := "INACTIVE"
		if user.Active {
			status = "ACTIVE"
		}
		fmt.Printf("\n[%s] %s <%s>\n", status, valueOrDash(user.Name), valueOrDash(user.Email))
		fmt.Printf("  id=%s type=%s profile=%s role=%s\n",
			valueOrDash(user.ID), valueOrDash(user.UserType), valueOrDash(user.Profile), valueOrDash(user.Role))
		fmt.Printf("  title=%s department=%s division=%s company=%s manager=%s\n",
			valueOrDash(user.Title), valueOrDash(user.Department), valueOrDash(user.Division),
			valueOrDash(user.Company), valueOrDash(user.Manager))
		fmt.Printf("  phone=%s mobile=%s location=%s lastLogin=%s created=%s\n",
			valueOrDash(user.Phone), valueOrDash(user.MobilePhone), location(user),
			valueOrDash(user.LastLoginDate), valueOrDash(user.CreatedDate))
	}
}

func text(row map[string]any, key string) string {
	value, _ := row[key].(string)
	return value
}

func boolean(row map[string]any, key string) bool {
	value, _ := row[key].(bool)
	return value
}

func relationshipText(row map[string]any, relationship, key string) string {
	nested, _ := row[relationship].(map[string]any)
	return text(nested, key)
}

func valueOrDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func location(user userSummary) string {
	parts := make([]string, 0, 3)
	for _, value := range []string{user.City, user.State, user.Country} {
		if value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) == 0 {
		return "-"
	}
	return strings.Join(parts, ", ")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "sfusers:", err)
	os.Exit(1)
}
