package files

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

func mp4TestBox(kind string, payload ...[]byte) []byte {
	body := bytes.Join(payload, nil)
	result := make([]byte, 8, 8+len(body))
	binary.BigEndian.PutUint32(result, uint32(8+len(body)))
	copy(result[4:], kind)
	return append(result, body...)
}

func mp4TestHeader(timescale, duration uint32) []byte {
	payload := make([]byte, 20)
	binary.BigEndian.PutUint32(payload[12:], timescale)
	binary.BigEndian.PutUint32(payload[16:], duration)
	return payload
}

func mp4TestTrack(handler string, timescale, duration uint32) []byte {
	return mp4TestTrackWith(handler, timescale, duration, "mp4a")
}

func mp4TestTrackWith(handler string, timescale, duration uint32, entries ...string) []byte {
	hdlr := make([]byte, 24)
	copy(hdlr[8:], handler)
	descriptions := make([]byte, 8)
	binary.BigEndian.PutUint32(descriptions[4:], uint32(len(entries)))
	for _, entry := range entries {
		descriptions = append(descriptions, mp4TestBox(entry, make([]byte, 28))...)
	}
	table := mp4TestBox("stbl", mp4TestBox("stsd", descriptions), mp4TestBox("stts", make([]byte, 8)))
	return mp4TestBox("trak", mp4TestBox("tkhd", make([]byte, 84)), mp4TestBox("mdia",
		mp4TestBox("mdhd", mp4TestHeader(timescale, duration)), mp4TestBox("hdlr", hdlr),
		mp4TestBox("minf", mp4TestBox("smhd", make([]byte, 8)), table)))
}

func mp4TestFtyp() []byte { return mp4TestBox("ftyp", []byte("M4A \x00\x00\x00\x00")) }

func mp4TestMoov(children ...[]byte) []byte {
	return mp4TestBox("moov", append([][]byte{mp4TestBox("mvhd", mp4TestHeader(1000, 4200))}, children...)...)
}

// mp4TestFile builds a minimal MP4 with moov after mdat, the layout phone
// recorders write.
func mp4TestFile(tracks ...[]byte) []byte {
	ftyp := mp4TestBox("ftyp", []byte("isom\x00\x00\x02\x00isomiso2mp41"))
	mdat := mp4TestBox("mdat", bytes.Repeat([]byte{0x21}, 64))
	moov := mp4TestBox("moov", append([][]byte{mp4TestBox("mvhd", mp4TestHeader(1000, 4200))}, tracks...)...)
	return bytes.Join([][]byte{ftyp, mdat, moov}, nil)
}

func voiceWaveform(value int) []int {
	result := make([]int, VoiceWaveformLength)
	for index := range result {
		result[index] = value
	}
	return result
}

func TestMP4AudioDurationAcceptsOnlyAudioOnlyMP4(t *testing.T) {
	recorded, err := os.ReadFile("testdata/voice.m4a")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := MP4AudioDurationMs(recorded); err != nil || got < 1300 || got > 1600 {
		t.Fatalf("AVFoundation m4a duration = %d, err = %v, want about 1400", got, err)
	}
	if got, err := MP4AudioDurationMs(mp4TestFile(mp4TestTrack("soun", 44100, 44100*4))); err != nil || got != 4200 {
		t.Fatalf("moov-last duration = %d, err = %v, want 4200 from mvhd", got, err)
	}
	cases := map[string][]byte{
		"empty":            nil,
		"png":              []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01"),
		"html":             []byte("<!doctype html><script>alert(1)</script>"),
		"video track":      mp4TestFile(mp4TestTrack("soun", 1000, 4200), mp4TestTrack("vide", 1000, 4200)),
		"no tracks":        mp4TestFile(),
		"not aac":          mp4TestFile(mp4TestTrackWith("soun", 1000, 4200, "Opus")),
		"aac and other":    mp4TestFile(mp4TestTrackWith("soun", 1000, 4200, "mp4a", "ac-3")),
		"no sample entry":  mp4TestFile(mp4TestTrackWith("soun", 1000, 4200)),
		"fragmented moov":  bytes.Join([][]byte{mp4TestFtyp(), mp4TestMoov(mp4TestTrack("soun", 1000, 4200), mp4TestBox("mvex"))}, nil),
		"moof":             append(mp4TestFile(mp4TestTrack("soun", 1000, 4200)), mp4TestBox("moof")...),
		"two moov":         append(mp4TestFile(mp4TestTrack("soun", 1000, 4200)), mp4TestMoov(mp4TestTrack("soun", 1000, 4200))...),
		"stray trak":       append(mp4TestFile(mp4TestTrack("soun", 1000, 4200)), mp4TestTrack("vide", 1000, 4200)...),
		"two mvhd":         bytes.Join([][]byte{mp4TestFtyp(), mp4TestMoov(mp4TestTrack("soun", 1000, 4200), mp4TestBox("mvhd", mp4TestHeader(1000, 4200)))}, nil),
		"ftyp not first":   bytes.Join([][]byte{mp4TestBox("free"), mp4TestFtyp(), mp4TestMoov(mp4TestTrack("soun", 1000, 4200))}, nil),
		"unknown box":      append(mp4TestFile(mp4TestTrack("soun", 1000, 4200)), mp4TestBox("html", []byte("<script>"))...),
		"truncated":        mp4TestFile(mp4TestTrack("soun", 1000, 4200))[:60],
		"no moov":          bytes.Join([][]byte{mp4TestBox("ftyp", []byte("M4A \x00\x00\x00\x00")), mp4TestBox("mdat", []byte{1, 2, 3})}, nil),
		"lying box size":   append(mp4TestBox("ftyp", []byte("M4A \x00\x00\x00\x00")), 0xff, 0xff, 0xff, 0xff, 'm', 'o', 'o', 'v'),
		"zero timescales":  bytes.Join([][]byte{mp4TestBox("ftyp", []byte("M4A \x00\x00\x00\x00")), mp4TestBox("moov", mp4TestBox("mvhd", mp4TestHeader(0, 10)), mp4TestTrack("soun", 0, 10))}, nil),
		"many empty boxes": append(mp4TestFile(mp4TestTrack("soun", 1000, 4200)), bytes.Repeat(mp4TestBox("free"), 100)...),
		"many moov boxes":  bytes.Join([][]byte{mp4TestFtyp(), mp4TestMoov(append([][]byte{mp4TestTrack("soun", 1000, 4200)}, bytes.Repeat(mp4TestBox("free"), maxMP4ChildBoxes))...)}, nil),
	}
	for name, data := range cases {
		if _, err := MP4AudioDurationMs(data); err == nil {
			t.Errorf("%s: MP4AudioDurationMs() error = nil, want rejection", name)
		}
	}
}

// The parser reads the first 64 KiB in one request, then at most one ranged
// read per header past them and one for moov; media data is never read and
// floods of empty boxes stop early.
func TestMP4ParserReadsOnlyHeadersAndMoov(t *testing.T) {
	recorded, err := os.ReadFile("testdata/voice.m4a")
	if err != nil {
		t.Fatal(err)
	}
	type call struct{ offset, length int64 }
	parse := func(file []byte) (int, []call, error) {
		calls := []call{}
		got, err := mp4AudioDuration(func(offset, length int64) ([]byte, error) {
			calls = append(calls, call{offset, length})
			return file[offset : offset+length], nil
		}, int64(len(file)))
		return got, calls, err
	}
	// iOS layout (moov before mdat) after a 1 MiB mdat: one request.
	mdat := mp4TestBox("mdat", bytes.Repeat([]byte{0x5a}, 1<<20))
	ios := bytes.Join([][]byte{recorded, mdat}, nil)
	if got, calls, err := parse(ios); err != nil || got < 1300 || got > 1600 || len(calls) != 1 || calls[0].length != mp4HeadBytes {
		t.Fatalf("moov-first: duration %d, calls %v, err %v; want one 64 KiB read", got, calls, err)
	}
	// Android layout (moov after mdat): head, the moov header, moov itself.
	moovAt := bytes.Index(recorded, []byte("moov")) - 4
	android := bytes.Join([][]byte{recorded[:28], mdat, recorded[moovAt : moovAt+int(binary.BigEndian.Uint32(recorded[moovAt:]))]}, nil)
	got, calls, err := parse(android)
	if err != nil || got < 1300 || got > 1600 || len(calls) != 3 {
		t.Fatalf("moov-last: duration %d, calls %v, err %v; want three reads", got, calls, err)
	}
	var total int64
	for _, item := range calls {
		total += item.length
	}
	if total > mp4HeadBytes+4096 {
		t.Fatalf("moov-last read %d bytes of %d", total, len(android))
	}

	// Two million empty boxes: refused within the first read.
	flood := append(mp4TestFtyp(), bytes.Repeat(mp4TestBox("free"), 2_000_000)...)
	if _, calls, err := parse(flood); err == nil || len(calls) != 1 {
		t.Fatalf("empty-box flood: err = %v after %d reads", err, len(calls))
	}
	// Empty boxes spread past the head cost one read each, up to 16 boxes.
	spread := bytes.Join([][]byte{mp4TestFtyp(), mp4TestBox("free", make([]byte, 70<<10))}, nil)
	for range 20 {
		spread = append(spread, mp4TestBox("free", make([]byte, 64))...)
	}
	if _, calls, err := parse(spread); err == nil || len(calls) > maxMP4TopLevelBoxes {
		t.Fatalf("spread boxes: err = %v after %d reads", err, len(calls))
	}

	innerFlood := bytes.Join([][]byte{mp4TestFtyp(), mp4TestBox("moov", bytes.Repeat(mp4TestBox("free"), 200_000))}, nil)
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	if _, err := MP4AudioDurationMs(innerFlood); err == nil {
		t.Fatal("moov flood accepted")
	}
	runtime.ReadMemStats(&after)
	// The moov payload is a slice of the input; parsing stops after
	// maxMP4ChildBoxes boxes and keeps no per-box list.
	if grown := after.TotalAlloc - before.TotalAlloc; grown > 256<<10 {
		t.Fatalf("parsing a moov flood allocated %d bytes", grown)
	}

	big := bytes.Join([][]byte{mp4TestFtyp(), mp4TestMoov(mp4TestTrack("soun", 1000, 4200), mp4TestBox("free", make([]byte, maxMoovBytes)))}, nil)
	if _, err := MP4AudioDurationMs(big); err == nil {
		t.Fatal("moov over the limit accepted")
	}
}

func TestDurationMsRejectsOverflow(t *testing.T) {
	if got, ok := durationMs(1000, 4200); !ok || got != 4200 {
		t.Fatalf("durationMs(1000, 4200) = %d, %v", got, ok)
	}
	if got, ok := durationMs(44100, 44100*3/2); !ok || got != 1500 {
		t.Fatalf("durationMs(44100, 1.5 s) = %d, %v", got, ok)
	}
	// 2^64/1000 wraps to a small number with a 64-bit multiply.
	for _, duration := range []uint64{1<<64/1000 + 1, 1 << 63, ^uint64(0) - 1} {
		if got, ok := durationMs(1000, duration); ok {
			t.Fatalf("durationMs(1000, %d) = %d, want rejection", duration, got)
		}
	}
	if _, ok := durationMs(1, 1<<40); ok {
		t.Fatal("a duration beyond int32 milliseconds was accepted")
	}
}

// Voice checks share four slots; a check waits for one at most
// voiceSlotWait, and an actor runs one check at a time.
func TestVerifyVoiceBoundsWaitingAndOneCheckPerActor(t *testing.T) {
	service := &Service{voiceChecks: make(chan struct{}, maxConcurrentVoiceChecks), voiceSlotWait: 50 * time.Millisecond}
	claim := func(actor string) uploadClaim {
		return uploadClaim{File: File{UploaderID: actor, Voice: &Voice{DurationMs: 1000}}}
	}
	for range maxConcurrentVoiceChecks {
		service.voiceChecks <- struct{}{}
	}
	started := time.Now()
	if _, err := service.verifyVoice(t.Context(), claim("a")); !errors.Is(err, ErrBusy) {
		t.Fatalf("verifyVoice with every slot taken = %v, want ErrBusy", err)
	}
	if waited := time.Since(started); waited > time.Second {
		t.Fatalf("waited %v for a slot, want about voiceSlotWait", waited)
	}
	if _, running := service.voiceActors.Load("a"); running {
		t.Fatal("a busy check left its actor marked as running")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	service.voiceSlotWait = time.Minute
	if _, err := service.verifyVoice(cancelled, claim("a")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("cancelled wait = %v, want ErrUnavailable", err)
	}

	service.voiceActors.Store("b", struct{}{})
	if _, err := service.verifyVoice(t.Context(), claim("b")); !errors.Is(err, ErrTooManyChecks) {
		t.Fatalf("second check of one actor = %v, want ErrTooManyChecks", err)
	}
}

func TestVoiceLimitStaysBelowDefaultMultipartThreshold(t *testing.T) {
	// config.FILE_MULTIPART_THRESHOLD_BYTES defaults to 16 MiB; CreateUpload
	// also keeps voice single-part when an operator lowers it.
	if MaxVoiceBytes >= 16<<20 {
		t.Fatalf("MaxVoiceBytes = %d, want below the 16 MiB multipart default", MaxVoiceBytes)
	}
}

func TestValidateVoiceRejectsUntrustedMetadata(t *testing.T) {
	good := &Voice{DurationMs: 4200, Waveform: voiceWaveform(128)}
	if err := validateVoice(good, "voice.m4a", "audio/x-m4a", 1<<20); err != nil {
		t.Fatalf("valid voice rejected: %v", err)
	}
	short := voiceWaveform(1)[:63]
	tooLoud := voiceWaveform(10)
	tooLoud[5] = 256
	negative := voiceWaveform(10)
	negative[0] = -1
	cases := []struct {
		name, file, mime string
		size             int64
		voice            *Voice
	}{
		{"image type", "voice.m4a", "image/png", 100, good},
		{"mp3", "voice.mp3", "audio/mpeg", 100, good},
		{"wrong extension", "voice.html", "audio/mp4", 100, good},
		{"too large", "voice.m4a", "audio/mp4", MaxVoiceBytes + 1, good},
		{"too long", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: MaxVoiceDurationMs + 1, Waveform: voiceWaveform(1)}},
		{"too short", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: 10, Waveform: voiceWaveform(1)}},
		{"short waveform", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: 4200, Waveform: short}},
		{"long waveform", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: 4200, Waveform: append(voiceWaveform(1), 1)}},
		{"waveform over 255", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: 4200, Waveform: tooLoud}},
		{"negative waveform", "voice.m4a", "audio/mp4", 100, &Voice{DurationMs: 4200, Waveform: negative}},
	}
	for _, item := range cases {
		if err := validateVoice(item.voice, item.file, item.mime, item.size); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: validateVoice() = %v, want ErrInvalid", item.name, err)
		}
	}
}

func TestVoiceUploadVerifiesContentDurationAndAccess(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, store, "", 64<<20, 32<<20, 16<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	member := identity.User{ActorID: testMemberID, OrgID: testOrgID, OrgRole: "member"}
	recorded, err := os.ReadFile("testdata/voice.m4a")
	if err != nil {
		t.Fatal(err)
	}
	upload := func(name, mime string, body []byte, voice *Voice) (File, error) {
		t.Helper()
		created, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: name, MIME: mime, Size: int64(len(body)), Voice: voice})
		if err != nil {
			return File{}, err
		}
		return service.PutContent(t.Context(), owner, created.ID, bytes.NewReader(body))
	}

	waveform := voiceWaveform(0)
	waveform[3] = 255
	ready, err := upload("voice.m4a", "audio/x-m4a", recorded, &Voice{DurationMs: 2000, Waveform: waveform})
	if err != nil {
		t.Fatal(err)
	}
	if ready.MIME != "audio/mp4" || ready.Voice == nil || ready.Voice.DurationMs < 1300 || ready.Voice.DurationMs > 1600 || ready.Voice.Waveform[3] != 255 {
		t.Fatalf("voice upload = %+v voice=%+v, want audio/mp4 with the container duration", ready, ready.Voice)
	}
	stored, err := service.Get(t.Context(), owner, ready.ID)
	if err != nil || stored.Voice == nil || stored.Voice.DurationMs != ready.Voice.DurationMs || len(stored.Voice.Waveform) != VoiceWaveformLength {
		t.Fatalf("stored voice = %+v, err = %v", stored.Voice, err)
	}

	// Only the uploader and members of a chat the file was sent to see it.
	if _, err := service.Download(t.Context(), member, ready.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider download error = %v, want ErrNotFound", err)
	}
	attachFileForMember(t, pool, ready.ID)
	download, err := service.Download(t.Context(), member, ready.ID)
	if err != nil {
		t.Fatalf("chat member download: %v", err)
	}
	_ = download.Reader.Close()

	// Content is checked by signature, not the declared type.
	if _, err := upload("voice.m4a", "audio/mp4", []byte("<!doctype html><script>alert(1)</script>"), &Voice{DurationMs: 2000, Waveform: waveform}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("HTML as voice error = %v, want ErrInvalid", err)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	if _, err := upload("voice.m4a", "audio/mp4", png, &Voice{DurationMs: 2000, Waveform: waveform}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("PNG as voice error = %v, want ErrInvalid", err)
	}
	video := mp4TestFile(mp4TestTrack("soun", 1000, 4200), mp4TestTrack("vide", 1000, 4200))
	if _, err := upload("voice.m4a", "audio/mp4", video, &Voice{DurationMs: 4200, Waveform: waveform}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("video as voice error = %v, want ErrInvalid", err)
	}
	// A claim far from the encoded duration is refused.
	if _, err := upload("voice.m4a", "audio/mp4", recorded, &Voice{DurationMs: 9000, Waveform: waveform}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("lying duration error = %v, want ErrInvalid", err)
	}
	// Size, duration and waveform are refused before any byte is stored.
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "voice.m4a", MIME: "audio/mp4", Size: MaxVoiceBytes + 1, Voice: &Voice{DurationMs: 2000, Waveform: waveform}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversize voice error = %v, want ErrInvalid", err)
	}
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "voice.m4a", MIME: "audio/mp4", Size: 100, Voice: &Voice{DurationMs: MaxVoiceDurationMs + 1, Waveform: waveform}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("overlong voice error = %v, want ErrInvalid", err)
	}
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "voice.m4a", MIME: "audio/mp4", Size: 100, Voice: &Voice{DurationMs: 2000, Waveform: []int{1, 2, 3}}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("garbage waveform error = %v, want ErrInvalid", err)
	}
	if _, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: "voice.webm", MIME: "audio/webm", Size: 100, Voice: &Voice{DurationMs: 2000, Waveform: waveform}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("webm voice error = %v, want ErrInvalid", err)
	}
	// Failed voice uploads keep no blob and release their reservation.
	var failed, reserved int64
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM files WHERE status = 'failed'`).Scan(&failed); err != nil || failed != 4 {
		t.Fatalf("failed voice files = %d, err = %v, want 4", failed, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT reserved_bytes FROM organization_storage_usage WHERE org_id = $1`, testOrgID).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatalf("reserved bytes after failures = %d, err = %v", reserved, err)
	}
	// An audio file without voice metadata stays an ordinary file.
	plain, err := upload("song.m4a", "audio/mp4", recorded, nil)
	if err != nil || plain.Voice != nil {
		t.Fatalf("plain audio = %+v, err = %v", plain, err)
	}
	if strings.Contains(ready.Name, "/") {
		t.Fatalf("unsafe name %q", ready.Name)
	}
}
