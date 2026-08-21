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

func (h *identityHandlers) getActorAvatar(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.files.Avatar(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "actorID"))
	if err != nil {
		h.fileError(w, r, err)
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
	if result.Reader != nil {
		defer result.Reader.Close()
		w.Header().Set("Content-Type", result.File.MIME)
		w.Header().Set("Content-Length", fmt.Sprintf("%d", result.File.Size))
		w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+strings.ReplaceAll(url.PathEscape(result.File.Name), "+", "%20"))
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
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
	case errors.Is(err, files.ErrStorageFull), errors.Is(err, storage.ErrStorageFull):
		h.writeError(w, r, standardhttp.StatusInsufficientStorage, "storage_full", "File storage quota or free-space guard was reached.")
	default:
		h.internalError(w, r, err)
	}
}
