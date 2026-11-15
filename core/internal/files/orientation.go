package files

import (
	"encoding/binary"
	"image"
)

// jpegOrientation reads the EXIF Orientation tag (1-8) of a JPEG. Phones
// store photos as the sensor saw them and put the turn into this tag;
// Go's decoder ignores it, so a preview made from the pixels alone lies on
// its side. Anything that is not a JPEG with a readable tag is 1 (as
// stored). Only the header is needed: the tag lives in APP1 before the
// image data.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for offset := 2; offset+4 <= len(data); {
		if data[offset] != 0xFF {
			return 1
		}
		marker := data[offset+1]
		// Fill bytes and markers without a length.
		if marker == 0xFF {
			offset++
			continue
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			offset += 2
			continue
		}
		// Start of scan or end of image: no EXIF before the pixels.
		if marker == 0xDA || marker == 0xD9 {
			return 1
		}
		length := int(binary.BigEndian.Uint16(data[offset+2:]))
		if length < 2 || offset+2+length > len(data) {
			return 1
		}
		segment := data[offset+4 : offset+2+length]
		if marker == 0xE1 && len(segment) >= 6 && string(segment[:6]) == "Exif\x00\x00" {
			if value := tiffOrientation(segment[6:]); value != 0 {
				return value
			}
		}
		offset += 2 + length
	}
	return 1
}

// tiffOrientation finds tag 0x0112 in IFD0 of an EXIF TIFF block; 0 when
// it is missing or malformed.
func tiffOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	if order.Uint16(tiff[2:]) != 42 {
		return 0
	}
	ifd := int(order.Uint32(tiff[4:]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0
	}
	count := int(order.Uint16(tiff[ifd:]))
	for index := 0; index < count; index++ {
		entry := ifd + 2 + index*12
		if entry+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[entry:]) != 0x0112 {
			continue
		}
		// SHORT, one value, stored in the first two bytes of the value field.
		if order.Uint16(tiff[entry+2:]) != 3 {
			return 0
		}
		value := int(order.Uint16(tiff[entry+8:]))
		if value < 1 || value > 8 {
			return 0
		}
		return value
	}
	return 0
}

// orientationSwapsAxes reports whether the photo is shown turned a quarter:
// its displayed width is the stored height.
func orientationSwapsAxes(orientation int) bool { return orientation >= 5 && orientation <= 8 }

// applyOrientation turns stored pixels upright as the EXIF tag says.
func applyOrientation(source *image.RGBA, orientation int) *image.RGBA {
	if orientation < 2 || orientation > 8 {
		return source
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	outWidth, outHeight := width, height
	if orientationSwapsAxes(orientation) {
		outWidth, outHeight = height, width
	}
	out := image.NewRGBA(image.Rect(0, 0, outWidth, outHeight))
	for y := 0; y < height; y++ {
		row := source.Pix[(y)*source.Stride:]
		for x := 0; x < width; x++ {
			var dx, dy int
			switch orientation {
			case 2: // mirrored
				dx, dy = width-1-x, y
			case 3: // turned 180°
				dx, dy = width-1-x, height-1-y
			case 4: // mirrored vertically
				dx, dy = x, height-1-y
			case 5: // transposed
				dx, dy = y, x
			case 6: // turned 90° clockwise to show
				dx, dy = height-1-y, x
			case 7: // transversed
				dx, dy = height-1-y, width-1-x
			case 8: // turned 90° counter-clockwise to show
				dx, dy = y, width-1-x
			}
			copy(out.Pix[dy*out.Stride+dx*4:dy*out.Stride+dx*4+4], row[x*4:x*4+4])
		}
	}
	return out
}
