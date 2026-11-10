// Package netguard protects outgoing integration calls against server-side
// request forgery. Addresses are checked twice: the URL host when a
// connection is saved, and every IP the dialer actually connects to, so DNS
// rebinding between the check and the request cannot reach a forbidden
// network. Redirects and environment proxies are disabled for the same
// reason.
//
// Internal addresses are reachable only when two parties agree: the server
// operator lists them in Targets (CIDR blocks or host:port pairs from the
// deployment environment) and a workspace administrator marks the
// connection as an internal system (AllowPrivate). Cloud metadata,
// link-local, multicast and unspecified addresses are never reachable.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ErrForbidden reports a destination outside the allowed networks.
var ErrForbidden = errors.New("destination address is not allowed")

// Targets is the operator's allowlist of internal destinations.
type Targets struct {
	CIDRs     []netip.Prefix
	HostPorts map[string]struct{}
}

// ParseTargets reads a comma or whitespace separated list of CIDR blocks,
// single IP addresses and host:port pairs, e.g.
// "10.20.0.0/16, 192.168.1.15, erp.office.lan:8443".
func ParseTargets(value string) (Targets, error) {
	targets := Targets{HostPorts: map[string]struct{}{}}
	for _, item := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == ';' }) {
		if prefix, err := netip.ParsePrefix(item); err == nil {
			targets.CIDRs = append(targets.CIDRs, prefix.Masked())
			continue
		}
		if address, err := netip.ParseAddr(item); err == nil {
			address = address.Unmap()
			targets.CIDRs = append(targets.CIDRs, netip.PrefixFrom(address, address.BitLen()))
			continue
		}
		host, port, err := net.SplitHostPort(item)
		number, portErr := strconv.Atoi(port)
		if err != nil || host == "" || portErr != nil || number < 1 || number > 65535 {
			return Targets{}, fmt.Errorf("invalid private target %q: use CIDR, IP or host:port", item)
		}
		targets.HostPorts[hostPortKey(host, port)] = struct{}{}
	}
	return targets, nil
}

// Empty reports whether the operator allowed no internal destination.
func (targets Targets) Empty() bool { return len(targets.CIDRs) == 0 && len(targets.HostPorts) == 0 }

func hostPortKey(host, port string) string {
	return strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), ".")) + "|" + port
}

// Policy decides which destinations are reachable for one connection.
type Policy struct {
	// AllowPrivate is the connection's "internal system" switch.
	AllowPrivate bool
	// Targets is the operator allowlist; without AllowPrivate it is ignored.
	Targets Targets
	// trustedHost is set by ForURL when the URL's host:port is listed.
	trustedHost bool
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
	// Cloud metadata and host agents: AWS/GCP/Azure IMDS, ECS, Alibaba,
	// Azure WireServer, Oracle and the 192.0.0.192 alias.
	metadata = []netip.Addr{
		netip.MustParseAddr("169.254.169.254"), netip.MustParseAddr("169.254.170.2"),
		netip.MustParseAddr("100.100.100.200"), netip.MustParseAddr("fd00:ec2::254"),
		netip.MustParseAddr("168.63.129.16"), netip.MustParseAddr("192.0.0.192"),
	}
	metadataHosts = map[string]struct{}{
		"metadata": {}, "metadata.google.internal": {}, "metadata.goog": {}, "instance-data": {}, "instance-data.ec2.internal": {},
		"metadata.azure.com": {},
	}
)

// Embedded returns the IPv4 address carried inside IPv4-mapped,
// IPv4-compatible, NAT64 and 6to4 IPv6 addresses, or the address itself.
func Embedded(address netip.Addr) netip.Addr {
	address = address.Unmap()
	if !address.Is6() {
		return address
	}
	bytes := address.As16()
	switch {
	case nat64.Contains(address):
		return netip.AddrFrom4([4]byte{bytes[12], bytes[13], bytes[14], bytes[15]})
	case sixToFour.Contains(address):
		return netip.AddrFrom4([4]byte{bytes[2], bytes[3], bytes[4], bytes[5]})
	}
	// IPv4-compatible ::a.b.c.d (deprecated, still routed by some stacks).
	for _, value := range bytes[:12] {
		if value != 0 {
			return address
		}
	}
	if address == netip.IPv6Unspecified() || address == netip.IPv6Loopback() {
		return address
	}
	return netip.AddrFrom4([4]byte{bytes[12], bytes[13], bytes[14], bytes[15]})
}

// Forbidden reports addresses that are never reachable.
func Forbidden(address netip.Addr) bool {
	address = Embedded(address)
	if !address.IsValid() || address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() || address.IsInterfaceLocalMulticast() {
		return true
	}
	for _, blocked := range metadata {
		if address == blocked {
			return true
		}
	}
	return address.Is4() && (thisNetwork.Contains(address) || reserved.Contains(address) || address == netip.AddrFrom4([4]byte{255, 255, 255, 255}))
}

// Internal reports private, loopback and other non-public addresses.
func Internal(address netip.Addr) bool {
	address = Embedded(address)
	if address.IsLoopback() || address.IsPrivate() || cgnat.Contains(address) || ietfProtocol.Contains(address) || benchmarking.Contains(address) {
		return true
	}
	for _, prefix := range documentation {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

// AllowedAddr reports whether a connection to address is permitted.
func (policy Policy) AllowedAddr(address netip.Addr) bool {
	if Forbidden(address) {
		return false
	}
	if !Internal(address) {
		return true
	}
	if !policy.AllowPrivate {
		return false
	}
	if policy.trustedHost {
		return true
	}
	plain, embedded := address.Unmap(), Embedded(address)
	for _, prefix := range policy.Targets.CIDRs {
		if prefix.Contains(plain) || prefix.Contains(embedded) {
			return true
		}
	}
	return false
}

// PrivateCIDRs lists the internal ranges this connection may reach, for a
// runtime that enforces the same policy after its own DNS lookups.
func (policy Policy) PrivateCIDRs() []string {
	if !policy.AllowPrivate {
		return []string{}
	}
	if policy.trustedHost {
		return []string{"0.0.0.0/0", "::/0"}
	}
	result := make([]string, len(policy.Targets.CIDRs))
	for index, prefix := range policy.Targets.CIDRs {
		result[index] = prefix.String()
	}
	return result
}

// ForURL validates an endpoint and returns the policy to dial it with. Plain
// HTTP and internal destinations require the connection switch and an
// operator allowlist entry.
func (policy Policy) ForURL(raw string) (Policy, *url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return policy, nil, fmt.Errorf("%w: empty or too long URL", ErrForbidden)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.Opaque != "" {
		return policy, nil, fmt.Errorf("%w: malformed URL", ErrForbidden)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return policy, nil, fmt.Errorf("%w: unsupported scheme", ErrForbidden)
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return policy, nil, fmt.Errorf("%w: credentials or fragment in URL", ErrForbidden)
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" {
		return policy, nil, fmt.Errorf("%w: empty host", ErrForbidden)
	}
	if _, blocked := metadataHosts[host]; blocked {
		return policy, nil, fmt.Errorf("%w: metadata host", ErrForbidden)
	}
	port := parsed.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[parsed.Scheme]
	}
	scoped := policy
	scoped.trustedHost = false
	if policy.AllowPrivate {
		_, scoped.trustedHost = policy.Targets.HostPorts[hostPortKey(host, port)]
	}
	internalTarget := scoped.trustedHost
	if address, err := netip.ParseAddr(host); err == nil {
		if !scoped.AllowedAddr(address) {
			return policy, nil, fmt.Errorf("%w: %s", ErrForbidden, address)
		}
		internalTarget = internalTarget || Internal(address)
	} else {
		if legacyNumericHost(host) {
			return policy, nil, fmt.Errorf("%w: ambiguous numeric host", ErrForbidden)
		}
		if internalName(host) && !scoped.trustedHost {
			return policy, nil, fmt.Errorf("%w: internal host name", ErrForbidden)
		}
	}
	if parsed.Scheme == "http" && !internalTarget {
		return policy, nil, fmt.Errorf("%w: plain HTTP is allowed only for listed internal systems", ErrForbidden)
	}
	return scoped, parsed, nil
}

// ValidateURL checks a configured endpoint before it is stored.
func (policy Policy) ValidateURL(raw string) (*url.URL, error) {
	_, parsed, err := policy.ForURL(raw)
	return parsed, err
}

func internalName(host string) bool {
	return host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".lan") || strings.HasSuffix(host, ".home.arpa") ||
		!strings.Contains(host, ".")
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

// Client returns an HTTP client for integration calls under the policy. Use
// the policy returned by ForURL so listed host:port entries are honoured.
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

// ListableInternal reports whether raw names an internal destination that
// would become reachable if the operator listed it. It lets callers explain
// a refusal instead of reporting a generic invalid address.
func ListableInternal(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	port := parsed.Port()
	if port == "" {
		port = map[string]string{"https": "443", "http": "80"}[parsed.Scheme]
	}
	everything := Targets{
		CIDRs:     []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")},
		HostPorts: map[string]struct{}{hostPortKey(parsed.Hostname(), port): {}},
	}
	_, err = Policy{AllowPrivate: true, Targets: everything}.ValidateURL(raw)
	return err == nil
}
