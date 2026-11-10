// Package netguard protects outgoing integration calls against server-side
// request forgery. Addresses are checked twice: the URL host when a
// connection is saved, and every IP the dialer actually connects to, so DNS
// rebinding between the check and the request cannot reach a forbidden
// network. Redirects and environment proxies are disabled for the same
// reason.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// ErrForbidden reports a destination outside the allowed networks.
var ErrForbidden = errors.New("destination address is not allowed")

// Policy decides which destinations are reachable. AllowPrivate is the
// explicit switch for trusted systems inside the organization's network
// (loopback, RFC 1918, CGNAT, unique-local IPv6). Link-local, cloud metadata,
// multicast and unspecified addresses stay forbidden even then.
type Policy struct {
	AllowPrivate bool
}

var (
	cgnat         = netip.MustParsePrefix("100.64.0.0/10")
	thisNetwork   = netip.MustParsePrefix("0.0.0.0/8")
	ietfProtocol  = netip.MustParsePrefix("192.0.0.0/24")
	benchmarking  = netip.MustParsePrefix("198.18.0.0/15")
	reserved      = netip.MustParsePrefix("240.0.0.0/4")
	documentation = []netip.Prefix{
		netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("2001:db8::/32"),
	}
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
	metadata  = []netip.Addr{
		netip.MustParseAddr("169.254.169.254"), netip.MustParseAddr("169.254.170.2"),
		netip.MustParseAddr("100.100.100.200"), netip.MustParseAddr("fd00:ec2::254"),
	}
	metadataHosts = map[string]struct{}{
		"metadata": {}, "metadata.google.internal": {}, "metadata.goog": {}, "instance-data": {}, "instance-data.ec2.internal": {},
	}
)

// AllowedAddr reports whether a connection to address is permitted.
func (policy Policy) AllowedAddr(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() || address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() || address.IsInterfaceLocalMulticast() {
		return false
	}
	for _, blocked := range metadata {
		if address == blocked {
			return false
		}
	}
	if address.Is4() && (thisNetwork.Contains(address) || reserved.Contains(address) || address == netip.AddrFrom4([4]byte{255, 255, 255, 255})) {
		return false
	}
	// Embedded IPv4 in NAT64 and 6to4 is judged by the address it reaches.
	if address.Is6() && (nat64.Contains(address) || sixToFour.Contains(address)) {
		bytes := address.As16()
		var embedded netip.Addr
		if nat64.Contains(address) {
			embedded = netip.AddrFrom4([4]byte{bytes[12], bytes[13], bytes[14], bytes[15]})
		} else {
			embedded = netip.AddrFrom4([4]byte{bytes[2], bytes[3], bytes[4], bytes[5]})
		}
		return policy.AllowedAddr(embedded)
	}
	internal := address.IsLoopback() || address.IsPrivate() || cgnat.Contains(address) || ietfProtocol.Contains(address) || benchmarking.Contains(address)
	for _, prefix := range documentation {
		internal = internal || prefix.Contains(address)
	}
	return !internal || policy.AllowPrivate
}

// ValidateURL checks a configured endpoint before it is stored. Plain HTTP is
// accepted only together with AllowPrivate, for systems inside the network.
func (policy Policy) ValidateURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return nil, fmt.Errorf("%w: empty or too long URL", ErrForbidden)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.Opaque != "" {
		return nil, fmt.Errorf("%w: malformed URL", ErrForbidden)
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		if !policy.AllowPrivate {
			return nil, fmt.Errorf("%w: plain HTTP requires the private network switch", ErrForbidden)
		}
	default:
		return nil, fmt.Errorf("%w: unsupported scheme", ErrForbidden)
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, fmt.Errorf("%w: credentials or fragment in URL", ErrForbidden)
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" {
		return nil, fmt.Errorf("%w: empty host", ErrForbidden)
	}
	if _, blocked := metadataHosts[host]; blocked {
		return nil, fmt.Errorf("%w: metadata host", ErrForbidden)
	}
	if address, err := netip.ParseAddr(host); err == nil {
		if !policy.AllowedAddr(address) {
			return nil, fmt.Errorf("%w: %s", ErrForbidden, address)
		}
		return parsed, nil
	}
	if legacyNumericHost(host) {
		return nil, fmt.Errorf("%w: ambiguous numeric host", ErrForbidden)
	}
	if !policy.AllowPrivate && (host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".lan") || strings.HasSuffix(host, ".home.arpa") || !strings.Contains(host, ".")) {
		return nil, fmt.Errorf("%w: internal host name", ErrForbidden)
	}
	return parsed, nil
}

// legacyNumericHost catches forms such as 2130706433, 0x7f.1 or 017700000001
// that some resolvers still interpret as IPv4 addresses.
func legacyNumericHost(host string) bool {
	for _, label := range strings.Split(host, ".") {
		if label == "" {
			continue
		}
		numeric := true
		for index, character := range label {
			if (character < '0' || character > '9') && !(index == 1 && (character == 'x' || character == 'X')) &&
				!((character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
				numeric = false
				break
			}
		}
		if numeric && (label[0] >= '0' && label[0] <= '9') {
			continue
		}
		return false
	}
	return true
}

// Control rejects a socket whose resolved address is forbidden. It runs after
// DNS resolution for every connection attempt, including retries.
func (policy Policy) Control(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return ErrForbidden
	}
	parsed, err := netip.ParseAddr(host)
	if err != nil || !policy.AllowedAddr(parsed) {
		return fmt.Errorf("%w: %s", ErrForbidden, host)
	}
	return nil
}

// DialContext dials with the policy enforced on the connected address.
func (policy Policy) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second, Control: policy.Control}
	return dialer.DialContext(ctx, network, address)
}

// ErrRedirect is returned for any redirect response; a redirect could point a
// trusted endpoint at a forbidden one.
var ErrRedirect = errors.New("redirects are disabled for integration calls")

// Client returns an HTTP client for integration calls under the policy.
func (policy Policy) Client(timeout time.Duration) *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           policy.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return ErrRedirect
		},
	}
}
