package egress

import "bytes"

func newBytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
