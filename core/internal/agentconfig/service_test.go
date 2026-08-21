package agentconfig

import "testing"

func TestCredentialEncryptionUsesOrganizationAndAgentAAD(t *testing.T) {
	service, err := NewService(nil, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	nonce, ciphertext, err := service.seal("org-one", "agent-one", "provider-secret")
	if err != nil {
		t.Fatal(err)
	}
	if string(ciphertext) == "provider-secret" {
		t.Fatal("credential was stored as plaintext")
	}
	plain, err := service.open("org-one", "agent-one", nonce, ciphertext)
	if err != nil || plain != "provider-secret" {
		t.Fatalf("round trip = %q, err=%v", plain, err)
	}
	if _, err := service.open("org-two", "agent-one", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another organization")
	}
	if _, err := service.open("org-one", "agent-two", nonce, ciphertext); err == nil {
		t.Fatal("credential decrypted for another agent")
	}
}
