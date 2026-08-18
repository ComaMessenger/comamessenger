package password

import "testing"

func testHasher(t *testing.T) *Hasher {
	t.Helper()
	hasher, err := NewHasher(Params{MemoryKiB: 19 * 1024, Iterations: 2, Parallelism: 1})
	if err != nil {
		t.Fatalf("NewHasher() error = %v", err)
	}
	return hasher
}

func TestHashAndVerify(t *testing.T) {
	hasher := testHasher(t)
	encoded, err := hasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	matched, err := hasher.Verify(encoded, "correct horse battery staple")
	if err != nil || !matched {
		t.Fatalf("Verify() = %v, %v; want true, nil", matched, err)
	}
	matched, err = hasher.Verify(encoded, "not the password")
	if err != nil || matched {
		t.Fatalf("Verify(wrong) = %v, %v; want false, nil", matched, err)
	}
}

func TestHashUsesUniqueSalt(t *testing.T) {
	hasher := testHasher(t)
	first, _ := hasher.Hash("correct horse battery staple")
	second, _ := hasher.Hash("correct horse battery staple")
	if first == second {
		t.Fatal("Hash() produced identical encoded values")
	}
}

func TestVerifyRejectsUnsafeEncodedParameters(t *testing.T) {
	hasher := testHasher(t)
	encoded := "$argon2id$v=19$m=9999999,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"
	if _, err := hasher.Verify(encoded, "correct horse battery staple"); err == nil {
		t.Fatal("Verify() error = nil, want invalid parameter error")
	}
}
