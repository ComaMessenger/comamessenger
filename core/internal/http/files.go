package http

import (
	"errors"
	"fmt"
	"io"
	standardhttp "net/http"
	"net/url"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/files"
	"github.com/comamessenger/comamessenger/core/internal/storage"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) createFileUpload(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input files.CreateUploadInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.files.CreateUpload(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	w.Header().Set("Location", "/api/v1/files/uploads/"+result.ID)
	writeJSON(h.logger, w, standardhttp.StatusCreated, result)
}

func (h *identityHandlers) putMyAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context()).User
	h.putAvatar(w, r, auth.ActorID)
}

func (h *identityHandlers) deleteMyAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	auth := authFromContext(r.Context()).User
	h.deleteAvatar(w, r, auth.ActorID)
}

func (h *identityHandlers) putMemberAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.putAvatar(w, r, chi.URLParam(r, "actorID"))
}

func (h *identityHandlers) deleteMemberAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.deleteAvatar(w, r, chi.URLParam(r, "actorID"))
}

func (h *identityHandlers) putAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request, actorID string) {
	result, err := h.files.PutAvatar(r.Context(), authFromContext(r.Context()).User, actorID, r.Header.Get("Content-Type"), r.Body)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request, actorID string) {
	result, err := h.files.DeleteAvatar(r.Context(), authFromContext(r.Context()).User, actorID)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

// objectLink answers ?delivery=link: native clients cannot rely on the HTTP
// stack dropping Authorization on a cross-host redirect, and S3 rejects a
// presigned URL that also carries it. Local blobs keep bearer authentication.
type objectLink struct {
	URL           string `json:"url"`
	Authenticated bool   `json:"authenticated"`
}

func (h *identityHandlers) writeObjectLink(w standardhttp.ResponseWriter, presigned string, reader io.Closer, localPath string) {
	if reader != nil {
		_ = reader.Close()
		writeJSON(h.logger, w, standardhttp.StatusOK, objectLink{URL: localPath, Authenticated: true})
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, objectLink{URL: presigned})
}

func (h *identityHandlers) getActorAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.Avatar(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "actorID"))
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	h.serveAvatar(w, r, result, "/api/v1/actors/"+url.PathEscape(chi.URLParam(r, "actorID"))+"/avatar")
}

func (h *identityHandlers) putChatAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.PutChatAvatar(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"), r.Header.Get("Content-Type"), r.Body)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) deleteChatAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.DeleteChatAvatar(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) getChatAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.ChatAvatar(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "chatID"))
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	h.serveAvatar(w, r, result, "/api/v1/chats/"+url.PathEscape(chi.URLParam(r, "chatID"))+"/avatar")
}

func (h *identityHandlers) serveAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request, result files.Download, localPath string) {
	if r.URL.Query().Get("delivery") == "link" {
		var reader io.Closer
		if result.Reader != nil {
			reader = result.Reader
		}
		h.writeObjectLink(w, result.URL, reader, localPath)
		return
	}
	if result.Reader == nil {
		standardhttp.Redirect(w, r, result.URL, standardhttp.StatusTemporaryRedirect)
		return
	}
	defer result.Reader.Close()
	w.Header().Set("Content-Type", result.File.MIME)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", result.File.Size))
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, result.Reader)
}

func (h *identityHandlers) putFileUploadContent(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.PutContent(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "uploadID"), r.Body)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) signFileUploadParts(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input struct {
		PartNumbers []int32 `json:"part_numbers"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	result, err := h.files.SignParts(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "uploadID"), input.PartNumbers)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"parts": result})
}

func (h *identityHandlers) completeFileUpload(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input struct {
		Parts []files.CompletedPart `json:"parts"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &input); err != nil {
			h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
			return
		}
	}
	result, err := h.files.CompleteUpload(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "uploadID"), input.Parts)
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) abortFileUpload(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.files.AbortUpload(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "uploadID")); err != nil {
		h.fileError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) getFile(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.Get(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "fileID"))
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) downloadFile(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.Download(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "fileID"))
	if err != nil {
		h.fileError(w, r, err)
		return
	}
	h.writeDownload(w, r, result, "/api/v1/files/"+url.PathEscape(chi.URLParam(r, "fileID"))+"/download")
}

// writeDownload streams a file, redirects to a presigned URL, or with
// ?delivery=link describes where to fetch it; selfPath is the streaming route.
func (h *identityHandlers) writeDownload(w standardhttp.ResponseWriter, r *standardhttp.Request, result files.Download, selfPath string) {
	if r.URL.Query().Get("delivery") == "link" {
		var reader io.Closer
		if result.Reader != nil {
			reader = result.Reader
		}
		h.writeObjectLink(w, result.URL, reader, selfPath)
		return
	}
	if result.Reader != nil {
		defer result.Reader.Close()
		w.Header().Set("Content-Type", result.File.MIME)
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(result.File.Name), "+", "%20"))
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Files are private and access can be revoked (leaving a chat,
		// deletion), so no cache, shared or on disk, keeps a copy.
		w.Header().Set("Cache-Control", "private, no-store")
		// A seekable local blob answers one Range, so players can seek a
		// voice recording without loading it whole. ServeContent keeps the
		// Content-Type set above and never sniffs. The S3 redirect gets
		// Range support from the object store.
		if seeker, ok := result.Reader.(io.ReadSeeker); ok {
			// Several ranges would come back as a multipart body that can be
			// many times larger than the file. RFC 9110 lets a server ignore
			// Range, so such a request gets the whole file with 200: the
			// answer is never larger than the file and players that asked
			// for several ranges still work.
			if strings.Contains(r.Header.Get("Range"), ",") {
				r.Header.Del("Range")
			}
			modified := result.File.CreatedAt
			if result.File.ReadyAt != nil {
				modified = *result.File.ReadyAt
			}
			standardhttp.ServeContent(w, r, "", modified, seeker)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprintf("%d", result.File.Size))
		_ = standardhttp.NewResponseController(w).Flush()
		_, _ = io.Copy(w, result.Reader)
		return
	}
	standardhttp.Redirect(w, r, result.URL, standardhttp.StatusTemporaryRedirect)
}

func (h *identityHandlers) fileError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, files.ErrInvalid), errors.Is(err, storage.ErrSizeMismatch), errors.Is(err, storage.ErrChecksumMismatch):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	case errors.Is(err, files.ErrNotFound), errors.Is(err, storage.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "file_not_found", "File or upload session was not found.")
	case errors.Is(err, files.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "File access is forbidden.")
	case errors.Is(err, files.ErrConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "file_conflict", "File upload is not in the required state.")
	case errors.Is(err, files.ErrTooManyChecks):
		w.Header().Set("Retry-After", "5")
		h.writeError(w, r, standardhttp.StatusTooManyRequests, "voice_check_in_progress", "Another voice message of yours is being checked. Retry in a few seconds.")
	case errors.Is(err, files.ErrBusy):
		w.Header().Set("Retry-After", "5")
		h.writeError(w, r, standardhttp.StatusServiceUnavailable, "voice_check_busy", "Voice messages are being checked for other users. Retry in a few seconds.")
	case errors.Is(err, files.ErrUnavailable):
		w.Header().Set("Retry-After", "5")
		h.writeError(w, r, standardhttp.StatusServiceUnavailable, "storage_unavailable", "File storage is temporarily unavailable. The upload is kept; complete it again.")
	case errors.Is(err, files.ErrStorageFull), errors.Is(err, storage.ErrStorageFull):
		h.writeError(w, r, standardhttp.StatusInsufficientStorage, "storage_full", "File storage quota or free-space guard was reached.")
	default:
		h.internalError(w, r, err)
	}
}
