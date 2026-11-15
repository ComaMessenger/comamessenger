package orgstructure

import (
	"errors"
	"fmt"
)

// Sentinel errors; the HTTP layer maps each to one contract code.
var (
	ErrForbidden          = errors.New("org structure action forbidden")
	ErrDepartmentNotFound = errors.New("department not found")
	ErrPositionNotFound   = errors.New("position not found")
	ErrPersonNotFound     = errors.New("person not found")
	ErrInvalid            = errors.New("invalid org structure input")
	ErrNameTaken          = errors.New("org structure name taken")
	ErrCycle              = errors.New("department cycle")
	ErrDepthExceeded      = errors.New("department depth exceeded")
	ErrLimitReached       = errors.New("org structure limit reached")
	ErrVersionConflict    = errors.New("org structure version conflict")
	ErrChatExists         = errors.New("department chat exists")
	ErrChatInvalid        = errors.New("department chat invalid")
)

// Error carries the details of a refusal: the request field at fault
// (details.field) or the limit that was reached (details.limit).
type Error struct {
	Kind    error
	Field   string
	Limit   string
	Message string
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.Kind }

func invalid(field, format string, args ...any) error {
	return &Error{Kind: ErrInvalid, Field: field, Message: fmt.Sprintf(format, args...)}
}

func limitReached(limit, format string, args ...any) error {
	return &Error{Kind: ErrLimitReached, Limit: limit, Message: fmt.Sprintf(format, args...)}
}

func nameTaken(field string) error {
	return &Error{Kind: ErrNameTaken, Field: field, Message: "The name is already taken."}
}
