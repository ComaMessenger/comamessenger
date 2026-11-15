package mailtemplate

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"golang.org/x/net/idna"
	"golang.org/x/net/publicsuffix"
)

// CanonicalHost returns the host of u in one spelling: lower case, IDN in
// punycode, no trailing dot and no default port. Limits, blocks and link
// checks compare hosts in this form, so «Chat.example.ru:443» and
// «chat.example.ru.» are the same installation.
func CanonicalHost(u *url.URL) (string, error) {
	hostname := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if hostname == "" {
		return "", errors.New("empty host")
	}
	if net.ParseIP(hostname) == nil {
		ascii, err := idna.Lookup.ToASCII(hostname)
		if err != nil {
			return "", errors.New("invalid host name")
		}
		hostname = ascii
	}
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port == "" {
		if strings.Contains(hostname, ":") {
			return "[" + hostname + "]", nil
		}
		return hostname, nil
	}
	return net.JoinHostPort(hostname, port), nil
}

// Site is the registrable domain (eTLD+1) of a canonical host. Installations
// of one site share their limits and blocks: subdomains are free to create.
func Site(host string) string {
	hostname := host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		hostname = parsed
	}
	hostname = strings.Trim(hostname, "[]")
	if net.ParseIP(hostname) != nil {
		return hostname
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(hostname)
	if err != nil {
		return hostname
	}
	return site
}
