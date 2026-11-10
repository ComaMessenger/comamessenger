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

func TestValidateURLRejectsInternalAndMetadataDestinations(t *testing.T) {
	public := Policy{}
	for _, raw := range []string{
		"http://example.com/mcp",            // plain HTTP outside the private switch
		"https://127.0.0.1/mcp",             // loopback
		"https://[::1]/mcp",                 // IPv6 loopback
		"https://10.1.2.3/mcp",              // RFC 1918
		"https://192.168.1.10/mcp",          // RFC 1918
		"https://172.20.0.5/mcp",            // RFC 1918
		"https://100.64.1.1/mcp",            // CGNAT
		"https://169.254.169.254/latest",    // cloud metadata
		"https://[fd00:ec2::254]/",          // AWS IPv6 metadata
		"https://[::ffff:127.0.0.1]/",       // IPv4-mapped loopback
		"https://[64:ff9b::a00:1]/",         // NAT64 to 10.0.0.1
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
	private := Policy{AllowPrivate: true}
	for _, raw := range []string{"http://10.0.0.5:8080/mcp", "https://erp.internal/mcp", "http://localhost:9000/mcp", "http://192.168.10.2/mcp"} {
		if _, err := private.ValidateURL(raw); err != nil {
			t.Errorf("private policy rejected %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://169.254.169.254/latest/meta-data", "http://[fe80::1]/", "http://metadata.google.internal/", "http://224.0.0.1/"} {
		if _, err := private.ValidateURL(raw); !errors.Is(err, ErrForbidden) {
			t.Errorf("private policy accepted %q", raw)
		}
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
		// Simulate a resolver that returned 127.0.0.1 for rebind.example.
		return Policy{}.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
	}
	_, err := client.Get("http://rebind.example:" + port + "/")
	if err == nil || !errors.Is(err, ErrForbidden) {
		t.Fatalf("rebinding dial error = %v", err)
	}
	allowed := Policy{AllowPrivate: true}.Client(2 * time.Second)
	response, err := allowed.Get(server.URL)
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
	_, err := Policy{AllowPrivate: true}.Client(2 * time.Second).Get(redirector.URL)
	if !errors.Is(err, ErrRedirect) {
		t.Fatalf("redirect error = %v", err)
	}
}

func TestAllowedAddrMatrix(t *testing.T) {
	cases := map[string][2]bool{ // address: {public, private}
		"8.8.8.8":         {true, true},
		"10.0.0.1":        {false, true},
		"127.0.0.1":       {false, true},
		"100.64.0.1":      {false, true},
		"fd12::1":         {false, true},
		"169.254.169.254": {false, false},
		"169.254.10.10":   {false, false},
		"fe80::1":         {false, false},
		"100.100.100.200": {false, false},
		"255.255.255.255": {false, false},
		"240.0.0.1":       {false, false},
		"::":              {false, false},
		"2002:a00:1::":    {false, true},
	}
	for raw, expected := range cases {
		address := netip.MustParseAddr(raw)
		if got := (Policy{}).AllowedAddr(address); got != expected[0] {
			t.Errorf("public %s = %v", raw, got)
		}
		if got := (Policy{AllowPrivate: true}).AllowedAddr(address); got != expected[1] {
			t.Errorf("private %s = %v", raw, got)
		}
	}
}
