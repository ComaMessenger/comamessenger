package netguard

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func mustTargets(t *testing.T, value string) Targets {
	t.Helper()
	targets, err := ParseTargets(value)
	if err != nil {
		t.Fatal(err)
	}
	return targets
}

func TestValidateURLRejectsInternalAndMetadataDestinations(t *testing.T) {
	public := Policy{}
	for _, raw := range []string{
		"http://example.com/mcp",            // plain HTTP to a public host
		"https://127.0.0.1/mcp",             // loopback
		"https://[::1]/mcp",                 // IPv6 loopback
		"https://10.1.2.3/mcp",              // RFC 1918
		"https://192.168.1.10/mcp",          // RFC 1918
		"https://172.20.0.5/mcp",            // RFC 1918
		"https://100.64.1.1/mcp",            // CGNAT
		"https://169.254.169.254/latest",    // cloud metadata
		"https://168.63.129.16/",            // Azure WireServer
		"https://192.0.0.192/",              // metadata alias
		"https://[fd00:ec2::254]/",          // AWS IPv6 metadata
		"https://[::ffff:127.0.0.1]/",       // IPv4-mapped loopback
		"https://[::ffff:a9fe:a9fe]/",       // IPv4-mapped metadata in hex
		"https://[::7f00:1]/",               // IPv4-compatible loopback
		"https://[64:ff9b::a00:1]/",         // NAT64 to 10.0.0.1
		"https://[2002:a9fe:a9fe::]/",       // 6to4 to metadata
		"https://0.0.0.0/",                  // unspecified
		"https://localhost/mcp",             // name of loopback
		"https://erp.local/mcp",             // mDNS
		"https://erp.internal/mcp",          // internal suffix
		"https://intranet/mcp",              // single-label name
		"https://metadata.google.internal/", // metadata name
		"https://2130706433/",               // decimal IPv4
		"https://0x7f.1/",                   // hex IPv4
		"https://user:pass@example.com/",    // credentials
		"file:///etc/passwd",                // scheme
		"https://example.com/#fragment",     // fragment
	} {
		if _, err := public.ValidateURL(raw); !errors.Is(err, ErrForbidden) {
			t.Errorf("public policy accepted %q", raw)
		}
	}
	for _, raw := range []string{"https://mcp.example.com/rpc", "https://93.184.216.34/rpc", "https://[2606:4700::1111]/rpc"} {
		if _, err := public.ValidateURL(raw); err != nil {
			t.Errorf("public policy rejected %q: %v", raw, err)
		}
	}
}

func TestPrivateDestinationsNeedOperatorAllowlistAndConnectionSwitch(t *testing.T) {
	targets := mustTargets(t, "10.20.0.0/16, 192.168.1.15 erp.office.lan:8443")
	// The connection switch alone is not enough.
	if _, err := (Policy{AllowPrivate: true}).ValidateURL("http://10.20.1.5:8080/mcp"); !errors.Is(err, ErrForbidden) {
		t.Fatal("private address allowed without an operator allowlist")
	}
	// The operator list alone is not enough either.
	if _, err := (Policy{Targets: targets}).ValidateURL("http://10.20.1.5:8080/mcp"); !errors.Is(err, ErrForbidden) {
		t.Fatal("private address allowed without the connection switch")
	}
	private := Policy{AllowPrivate: true, Targets: targets}
	for _, raw := range []string{"http://10.20.1.5:8080/mcp", "https://192.168.1.15/mcp", "http://erp.office.lan:8443/mcp"} {
		if _, err := private.ValidateURL(raw); err != nil {
			t.Errorf("listed target rejected %q: %v", raw, err)
		}
	}
	for _, raw := range []string{
		"http://10.21.0.1/mcp",               // outside the CIDR
		"http://192.168.1.16/mcp",            // neighbour of a single IP
		"http://erp.office.lan:9000/mcp",     // listed host, other port
		"http://postgres:5432/",              // compose service name
		"http://169.254.169.254/latest",      // metadata never
		"http://[fe80::1]/",                  // link-local never
		"http://metadata.google.internal/",   // metadata name never
		"http://example.com/mcp",             // plain HTTP to a public host
		"http://[::ffff:10.21.0.1]:8080/mcp", // mapped address outside the CIDR
	} {
		if _, err := private.ValidateURL(raw); !errors.Is(err, ErrForbidden) {
			t.Errorf("private policy accepted %q", raw)
		}
	}
	scoped, _, err := private.ForURL("http://erp.office.lan:8443/mcp")
	if err != nil || strings.Join(scoped.PrivateCIDRs(), ",") != "0.0.0.0/0,::/0" {
		t.Fatalf("trusted host CIDRs = %v, err=%v", scoped.PrivateCIDRs(), err)
	}
	if scoped.AllowedAddr(netip.MustParseAddr("169.254.169.254")) {
		t.Fatal("a trusted host name may not resolve to metadata")
	}
	byCIDR, _, _ := private.ForURL("http://10.20.1.5:8080/mcp")
	if strings.Join(byCIDR.PrivateCIDRs(), ",") != "10.20.0.0/16,192.168.1.15/32" || byCIDR.AllowedAddr(netip.MustParseAddr("10.30.0.1")) {
		t.Fatalf("CIDR policy = %v", byCIDR.PrivateCIDRs())
	}
	if _, err := ParseTargets("erp.lan"); err == nil {
		t.Fatal("host without port accepted")
	}
	if !(Targets{}).Empty() || mustTargets(t, "").Empty() == false {
		t.Fatal("empty allowlist misreported")
	}
}

func TestDialerChecksResolvedAddress(t *testing.T) {
	// The dialer judges the address it connects to, not the host name, so a
	// public-looking name that resolves to loopback (DNS rebinding) fails.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	client := Policy{}.Client(2 * time.Second)
	client.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return Policy{}.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
	}
	_, err := client.Get("http://rebind.example:" + port + "/")
	if err == nil || !errors.Is(err, ErrForbidden) {
		t.Fatalf("rebinding dial error = %v", err)
	}
	scoped, _, err := Policy{AllowPrivate: true, Targets: mustTargets(t, "127.0.0.1/32")}.ForURL(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response, err := scoped.Client(2 * time.Second).Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
}

func TestClientRefusesRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("secret")) }))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirector.Close()
	_, err := Policy{AllowPrivate: true, Targets: mustTargets(t, "127.0.0.1/32")}.Client(2 * time.Second).Get(redirector.URL)
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("redirect error = %v", err)
	}
}

func TestAllowedAddrMatrix(t *testing.T) {
	everything := Policy{AllowPrivate: true, Targets: mustTargets(t, "0.0.0.0/0 ::/0")}
	cases := map[string][2]bool{ // address: {public policy, allow-everything private policy}
		"8.8.8.8":            {true, true},
		"10.0.0.1":           {false, true},
		"127.0.0.1":          {false, true},
		"100.64.0.1":         {false, true},
		"fd12::1":            {false, true},
		"169.254.169.254":    {false, false},
		"169.254.10.10":      {false, false},
		"168.63.129.16":      {false, false},
		"192.0.0.192":        {false, false},
		"fe80::1":            {false, false},
		"100.100.100.200":    {false, false},
		"255.255.255.255":    {false, false},
		"240.0.0.1":          {false, false},
		"::":                 {false, false},
		"::ffff:a9fe:a9fe":   {false, false},
		"::a9fe:a9fe":        {false, false},
		"::7f00:1":           {false, true},
		"64:ff9b::a9fe:a9fe": {false, false},
		"2002:a00:1::":       {false, true},
	}
	for raw, expected := range cases {
		address := netip.MustParseAddr(raw)
		if got := (Policy{}).AllowedAddr(address); got != expected[0] {
			t.Errorf("public %s = %v", raw, got)
		}
		if got := everything.AllowedAddr(address); got != expected[1] {
			t.Errorf("private %s = %v", raw, got)
		}
	}
}
