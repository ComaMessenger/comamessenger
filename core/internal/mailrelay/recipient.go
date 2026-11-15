package mailrelay

import (
	"strings"

	"golang.org/x/net/idna"
)

// CanonicalRecipient is the form limits and suppressions are keyed by: one
// mailbox, one key. The letter still goes to the address as given.
// Sub-addressing («name+tag@») is dropped for every domain, Gmail ignores
// dots, and IDN domains are compared in punycode.
func CanonicalRecipient(address string) string {
	address = strings.ToLower(strings.TrimSpace(address))
	at := strings.LastIndex(address, "@")
	if at <= 0 {
		return address
	}
	local, domain := address[:at], strings.TrimSuffix(address[at+1:], ".")
	if ascii, err := idna.Lookup.ToASCII(domain); err == nil {
		domain = ascii
	}
	if plus := strings.IndexByte(local, '+'); plus > 0 {
		local = local[:plus]
	}
	if domain == "googlemail.com" {
		domain = "gmail.com"
	}
	if domain == "gmail.com" {
		local = strings.ReplaceAll(local, ".", "")
	}
	return local + "@" + domain
}
