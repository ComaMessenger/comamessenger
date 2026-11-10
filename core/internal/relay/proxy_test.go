package relay

import (
	"net/http/httptest"
	"testing"
)

func TestClientIPBelievesOnlyTrustedProxies(t *testing.T) {
	trusted, err := ParseTrustedProxies("172.16.0.0/12, 127.0.0.1/32")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseTrustedProxies("not-a-prefix"); err == nil {
		t.Fatal("invalid prefix accepted")
	}
	cases := []struct {
		name, remote, forwarded, want string
		trust                         bool
	}{
		{"direct peer without proxies", "203.0.113.7:4000", "198.51.100.1", "203.0.113.7", false},
		{"untrusted peer cannot spoof", "203.0.113.7:4000", "198.51.100.1", "203.0.113.7", true},
		{"trusted proxy reports the client", "172.18.0.1:4000", "198.51.100.1", "198.51.100.1", true},
		{"client-supplied entries are ignored", "172.18.0.1:4000", "10.9.9.9, 198.51.100.1", "198.51.100.1", true},
		{"chain of trusted proxies", "172.18.0.1:4000", "198.51.100.1, 127.0.0.1", "198.51.100.1", true},
		{"trusted proxy without header", "172.18.0.1:4000", "", "172.18.0.1", true},
		{"garbage header falls back to the peer", "172.18.0.1:4000", "unknown", "172.18.0.1", true},
	}
	for _, test := range cases {
		server := &Server{}
		if test.trust {
			server.TrustProxies(trusted)
		}
		request := httptest.NewRequest("POST", "/v1/send", nil)
		request.RemoteAddr = test.remote
		if test.forwarded != "" {
			request.Header.Set("X-Forwarded-For", test.forwarded)
		}
		if got := server.clientIP(request); got != test.want {
			t.Errorf("%s: got %q, want %q", test.name, got, test.want)
		}
	}
}
