package files

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"

	"github.com/comamessenger/comamessenger/core/internal/identity"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/comamessenger/comamessenger/core/internal/testdb"
)

// storedPhoto is a 600×300 photo as a phone stores it: red top half, blue
// bottom half and a green band at the left edge. With an EXIF tag the
// pixels stay as they are and the tag says how to turn them.
func storedPhoto(t *testing.T, orientation int, littleEndian bool) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, 600, 300))
	for y := 0; y < 300; y++ {
		for x := 0; x < 600; x++ {
			pixel := color.RGBA{R: 230, A: 255}
			if y >= 150 {
				pixel = color.RGBA{B: 230, A: 255}
			}
			if x < 60 {
				pixel = color.RGBA{G: 230, A: 255}
			}
			source.SetRGBA(x, y, pixel)
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, source, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	if orientation == 0 {
		return encoded.Bytes()
	}
	return withExifOrientation(encoded.Bytes(), orientation, littleEndian)
}

// withExifOrientation inserts an APP1 Exif segment with one IFD0 entry
// (an unrelated tag first, so the parser has to walk the entries).
func withExifOrientation(data []byte, orientation int, littleEndian bool) []byte {
	var order binary.AppendByteOrder = binary.BigEndian
	tiff := []byte("MM\x00\x2a")
	if littleEndian {
		order = binary.LittleEndian
		tiff = []byte("II\x2a\x00")
	}
	tiff = order.AppendUint32(tiff, 8)
	tiff = order.AppendUint16(tiff, 2)
	// ImageDescription-like ASCII entry pointing nowhere useful.
	tiff = order.AppendUint16(tiff, 0x010E)
	tiff = order.AppendUint16(tiff, 2)
	tiff = order.AppendUint32(tiff, 1)
	tiff = order.AppendUint32(tiff, 0)
	tiff = order.AppendUint16(tiff, 0x0112)
	tiff = order.AppendUint16(tiff, 3)
	tiff = order.AppendUint32(tiff, 1)
	tiff = order.AppendUint16(tiff, uint16(orientation))
	tiff = order.AppendUint16(tiff, 0)
	tiff = order.AppendUint32(tiff, 0)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	segment := []byte{0xFF, 0xE1}
	segment = binary.BigEndian.AppendUint16(segment, uint16(len(payload)+2))
	segment = append(segment, payload...)
	out := append([]byte{}, data[:2]...)
	out = append(out, segment...)
	return append(out, data[2:]...)
}

type colorName string

func nameOf(c color.Color) colorName {
	r, g, b, _ := c.RGBA()
	switch {
	case r > 0xA000 && g < 0x6000 && b < 0x6000:
		return "red"
	case b > 0xA000 && r < 0x6000 && g < 0x6000:
		return "blue"
	case g > 0xA000 && r < 0x6000 && b < 0x6000:
		return "green"
	}
	return "other"
}

func decodePreview(t *testing.T, data []byte) image.Image {
	t.Helper()
	preview, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return preview
}

func TestJPEGOrientationParsing(t *testing.T) {
	for orientation := 1; orientation <= 8; orientation++ {
		for _, little := range []bool{false, true} {
			if got := jpegOrientation(storedPhoto(t, orientation, little)); got != orientation {
				t.Fatalf("orientation %d (little endian %v) read as %d", orientation, little, got)
			}
		}
	}
	plain := storedPhoto(t, 0, false)
	broken := withExifOrientation(plain, 6, false)
	broken[2+2+2+6+4] = 0xFF // corrupt the IFD offset
	cases := map[string][]byte{
		"no EXIF":       plain,
		"empty":         nil,
		"PNG signature": []byte("\x89PNG\r\n\x1a\n"),
		"truncated":     withExifOrientation(plain, 6, false)[:20],
		"out of range":  withExifOrientation(plain, 9, false),
		"bad IFD":       broken,
	}
	for name, data := range cases {
		if got := jpegOrientation(data); got != 1 {
			t.Fatalf("%s: orientation = %d, want 1", name, got)
		}
	}
}

func TestImagePreviewIsUpright(t *testing.T) {
	// What a viewer sees after applying the tag to the stored photo above,
	// probed at the top, right, bottom and left middle of the preview.
	type probe struct{ top, right, bottom, left colorName }
	cases := []struct {
		orientation   int
		width, height int
		want          probe
	}{
		{0, 512, 256, probe{"red", "red", "blue", "green"}},
		{1, 512, 256, probe{"red", "red", "blue", "green"}},
		{2, 512, 256, probe{"red", "green", "blue", "blue"}},
		{3, 512, 256, probe{"blue", "green", "red", "red"}},
		{4, 512, 256, probe{"blue", "blue", "red", "green"}},
		{5, 256, 512, probe{"green", "blue", "blue", "red"}},
		{6, 256, 512, probe{"green", "red", "red", "blue"}},
		{7, 256, 512, probe{"red", "red", "green", "blue"}},
		{8, 256, 512, probe{"blue", "blue", "green", "red"}},
	}
	for _, tc := range cases {
		data, err := makeImagePreview(storedPhoto(t, tc.orientation, tc.orientation%2 == 0))
		if err != nil {
			t.Fatal(err)
		}
		preview := decodePreview(t, data)
		bounds := preview.Bounds()
		if bounds.Dx() != tc.width || bounds.Dy() != tc.height {
			t.Fatalf("orientation %d: preview %dx%d, want %dx%d", tc.orientation, bounds.Dx(), bounds.Dy(), tc.width, tc.height)
		}
		// Probes stay clear of the edges and of the band/half borders.
		got := probe{
			top:    nameOf(preview.At(bounds.Dx()*3/5, bounds.Dy()/50+2)),
			right:  nameOf(preview.At(bounds.Dx()-4, bounds.Dy()*2/5)),
			bottom: nameOf(preview.At(bounds.Dx()*3/5, bounds.Dy()-4)),
			left:   nameOf(preview.At(3, bounds.Dy()*3/5)),
		}
		if got != tc.want {
			t.Fatalf("orientation %d: preview edges %+v, want %+v", tc.orientation, got, tc.want)
		}
	}
}

func TestPreviewOrientationBackfillRebuildsTurnedPreviews(t *testing.T) {
	pool := testdb.New(t)
	seedFileActors(t, pool)
	store, err := storage.NewLocalBlobStore(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(pool, store, "", 4<<20, 2<<20, 1<<20, time.Hour, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	owner := identity.User{ActorID: testOwnerID, OrgID: testOrgID, OrgRole: "owner"}
	upload := func(name string, data []byte) string {
		t.Helper()
		created, err := service.CreateUpload(t.Context(), owner, CreateUploadInput{Name: name, MIME: "image/jpeg", Size: int64(len(data))})
		if err != nil {
			t.Fatal(err)
		}
		file, err := service.PutContent(t.Context(), owner, created.ID, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		return file.ID
	}
	turned := upload("turned.jpg", storedPhoto(t, 6, false))
	upright := upload("upright.jpg", storedPhoto(t, 1, false))
	// Previews as the old server made them: the stored pixels, unturned.
	for _, fileID := range []string{turned, upright} {
		var record processRecord
		if err := pool.QueryRow(t.Context(), `SELECT id, org_id, uploader_id, storage_key, mime, name, status, size FROM files WHERE id = $1`, fileID).Scan(
			&record.ID, &record.OrgID, &record.UploaderID, &record.Key, &record.MIME, &record.Name, &record.Status, &record.Size); err != nil {
			t.Fatal(err)
		}
		legacy, err := makeImagePreview(storedPhoto(t, 0, false))
		if err != nil {
			t.Fatal(err)
		}
		if err := service.savePreview(t.Context(), record, legacy, nil); err != nil {
			t.Fatal(err)
		}
	}
	// Migration 00063 marks such previews for checking.
	if _, err := pool.Exec(t.Context(), `UPDATE files SET preview_oriented = false WHERE id = ANY($1)`, []string{turned, upright}); err != nil {
		t.Fatal(err)
	}
	previewOf := func(fileID string) (string, image.Image) {
		t.Helper()
		var previewID, key string
		if err := pool.QueryRow(t.Context(), `
			SELECT preview.id, preview.storage_key FROM files f JOIN files preview ON preview.id = f.preview_file_id
			WHERE f.id = $1`, fileID).Scan(&previewID, &key); err != nil {
			t.Fatal(err)
		}
		reader, _, err := store.Open(t.Context(), key)
		if err != nil {
			t.Fatal(err)
		}
		defer reader.Close()
		preview, err := jpeg.Decode(reader)
		if err != nil {
			t.Fatal(err)
		}
		return previewID, preview
	}
	oldTurned, _ := previewOf(turned)
	oldUpright, _ := previewOf(upright)

	done, err := service.BackfillPreviewOrientationBatch(t.Context())
	if err != nil || done {
		t.Fatalf("first batch done = %v, err = %v", done, err)
	}
	done, err = service.BackfillPreviewOrientationBatch(t.Context())
	if err != nil || !done {
		t.Fatalf("second batch done = %v, err = %v", done, err)
	}

	newTurned, preview := previewOf(turned)
	if newTurned == oldTurned {
		t.Fatal("turned photo kept its sideways preview")
	}
	if bounds := preview.Bounds(); bounds.Dx() != 256 || bounds.Dy() != 512 {
		t.Fatalf("rebuilt preview %dx%d, want 256x512", bounds.Dx(), bounds.Dy())
	}
	if newUpright, _ := previewOf(upright); newUpright != oldUpright {
		t.Fatal("upright photo got a new preview it did not need")
	}
	// The replaced preview is no longer anyone's preview: the reconciler
	// removes it with the other unattached files.
	var referenced bool
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM files WHERE preview_file_id = $1)`, oldTurned).Scan(&referenced); err != nil || referenced {
		t.Fatalf("old preview still referenced = %v, err = %v", referenced, err)
	}
	var unchecked int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM files WHERE NOT preview_oriented`).Scan(&unchecked); err != nil || unchecked != 0 {
		t.Fatalf("unchecked previews = %d, err = %v", unchecked, err)
	}
}
