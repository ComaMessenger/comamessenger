// Package wirejson encodes realtime frames. Unlike json.Marshal it leaves
// <, > and & as they are: a browser never parses these frames as HTML, and
// escaping turns one byte of message text into six bytes of frame.
package wirejson

import (
	"bytes"
	"encoding/json"
)

func Marshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
