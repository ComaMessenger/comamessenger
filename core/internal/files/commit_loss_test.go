package files

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

// commitDropProxy forwards PostgreSQL traffic; when armed it forwards the
// first COMMIT and cuts the connection before the server's answer reaches
// the client: the commit is applied but the client sees an error.
type commitDropProxy struct {
	listener net.Listener
	target   string
	armed    atomic.Bool
	fired    atomic.Bool
}

func newCommitDropProxy(t *testing.T, target string) *commitDropProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &commitDropProxy{listener: listener, target: target}
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go proxy.serve(client)
		}
	}()
	t.Cleanup(func() { listener.Close() })
	return proxy
}

func (p *commitDropProxy) serve(client net.Conn) {
	server, err := net.Dial("tcp", p.target)
	if err != nil {
		client.Close()
		return
	}
	var once sync.Once
	closeBoth := func() { once.Do(func() { client.Close(); server.Close() }) }
	var cut atomic.Bool
	go func() {
		buffer := make([]byte, 64<<10)
		for {
			n, err := server.Read(buffer)
			if n > 0 && !cut.Load() {
				if _, werr := client.Write(buffer[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		closeBoth()
	}()
	buffer := make([]byte, 64<<10)
	for {
		n, err := client.Read(buffer)
		if n > 0 {
			chunk := buffer[:n]
			if _, werr := server.Write(chunk); werr != nil {
				closeBoth()
				return
			}
			if p.armed.Load() && bytes.Contains(bytes.ToLower(chunk), []byte("commit")) && p.fired.CompareAndSwap(false, true) {
				cut.Store(true)
				time.Sleep(300 * time.Millisecond) // the server commits
				closeBoth()
				return
			}
		}
		if err != nil {
			closeBoth()
			return
		}
	}
}

// proxiedService builds a file service whose database connections go
// through a commitDropProxy.
func proxiedService(t *testing.T, pool *pgxpool.Pool, store storage.BlobStore) (*Service, *commitDropProxy) {
	t.Helper()
	config := pool.Config()
	proxy := newCommitDropProxy(t, net.JoinHostPort(config.ConnConfig.Host, strconv.Itoa(int(config.ConnConfig.Port))))
	proxiedConfig := config.Copy()
	proxiedConfig.ConnConfig.Host = "127.0.0.1"
	proxiedConfig.ConnConfig.Port = uint16(proxy.listener.Addr().(*net.TCPAddr).Port)
	proxied, err := pgxpool.NewWithConfig(t.Context(), proxiedConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxied.Close)
	service, err := NewService(proxied, store, "", 64<<20, 32<<20, 1<<20, time.Hour, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return service, proxy
}

// A COMMIT that the server applied but whose answer was lost must not
// delete the object the committed row points to.
func TestLostCommitAnswerKeepsTheReadyObject(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	harness := fakeSealHarness(t)
	service, proxy := proxiedService(t, pool, harness.store)
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	body := bytes.Repeat([]byte("hello "), 50)
	upload, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "a.txt", MIME: "text/plain", Size: int64(len(body))})
	if err != nil {
		t.Fatal(err)
	}
	harness.put(t, upload, body)
	proxy.armed.Store(true)
	if _, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil); err == nil || !proxy.fired.Load() {
		t.Fatalf("complete with a lost COMMIT answer: err = %v, fired = %v", err, proxy.fired.Load())
	}
	// The client retries, as web and mobile do, and gets the committed file.
	file, err := service.CompleteUpload(t.Context(), owner, upload.ID, nil)
	if err != nil || file.Status != "ready" {
		t.Fatalf("retry = %+v, %v", file, err)
	}
	var key string
	if err := pool.QueryRow(t.Context(), `SELECT storage_key FROM files WHERE id = $1 AND status = 'ready'`, upload.File.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.store.Stat(t.Context(), key); err != nil {
		t.Fatalf("object %s of the committed ready file: %v", key, err)
	}
}

// The same holds when a new avatar's COMMIT answer is lost.
func TestLostCommitAnswerKeepsTheNewAvatar(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, proxy := proxiedService(t, pool, store)
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	buffer := new(bytes.Buffer)
	source := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := range 32 {
		for x := range 32 {
			source.Set(x, y, color.RGBA{R: 40, G: uint8(x * 4), B: uint8(y * 4), A: 255})
		}
	}
	if err := png.Encode(buffer, source); err != nil {
		t.Fatal(err)
	}
	proxy.armed.Store(true)
	if _, err := service.PutAvatar(t.Context(), owner, testOwnerID, "image/png", bytes.NewReader(buffer.Bytes())); err == nil || !proxy.fired.Load() {
		t.Fatalf("avatar with a lost COMMIT answer: err = %v, fired = %v", err, proxy.fired.Load())
	}
	var key string
	if err := pool.QueryRow(t.Context(), `
		SELECT f.storage_key FROM actors a JOIN files f ON f.org_id = a.org_id AND f.id = a.avatar_file_id
		WHERE a.id = $1`, testOwnerID).Scan(&key); err != nil {
		t.Fatalf("committed avatar row: %v", err)
	}
	if _, err := store.Stat(t.Context(), key); err != nil {
		t.Fatalf("object %s of the committed avatar: %v", key, err)
	}
}
