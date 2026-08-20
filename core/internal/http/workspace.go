package http

import (
	"errors"
	"io"
	"mime"
	standardhttp "net/http"
	"strconv"

	"github.com/comamessenger/comamessenger/core/internal/workspace"
	"github.com/go-chi/chi/v5"
)

func (h *identityHandlers) publicBranding(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	value, err := h.workspace.PublicBranding(r.Context())
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) brandingAsset(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	value, err := h.workspace.Asset(r.Context(), chi.URLParam(r, "kind"))
	if errors.Is(err, workspace.ErrNotFound) {
		standardhttp.NotFound(w, r)
		return
	}
	if err != nil {
		h.internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", value.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=3600, must-revalidate")
	w.Header().Set("Last-Modified", value.UpdatedAt.UTC().Format(standardhttp.TimeFormat))
	w.WriteHeader(standardhttp.StatusOK)
	_, _ = w.Write(value.Content)
}

func (h *identityHandlers) workspaceSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	value, err := h.workspace.Settings(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) updateWorkspaceSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input workspace.UpdateSettingsInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	value, err := h.workspace.UpdateSettings(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) putBrandingAsset(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		h.writeError(w, r, standardhttp.StatusUnsupportedMediaType, "unsupported_format", "A supported image Content-Type is required.")
		return
	}
	r.Body = standardhttp.MaxBytesReader(w, r.Body, 512*1024)
	content, err := io.ReadAll(r.Body)
	if err != nil {
		h.writeError(w, r, standardhttp.StatusRequestEntityTooLarge, "payload_too_large", "Branding image must not exceed 512 KiB.")
		return
	}
	if err := h.workspace.PutAsset(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "kind"), contentType, content); err != nil {
		h.workspaceError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) deleteBrandingAsset(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	if err := h.workspace.DeleteAsset(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "kind")); err != nil {
		h.workspaceError(w, r, err)
		return
	}
	w.WriteHeader(standardhttp.StatusNoContent)
}

func (h *identityHandlers) infrastructureSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	value, err := h.workspace.Infrastructure(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) updateInfrastructureSettings(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input workspace.UpdateInfrastructureInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	value, err := h.workspace.UpdateInfrastructure(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) testInfrastructureConnection(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input workspace.ConnectionTestInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	value, err := h.workspace.TestConnection(r.Context(), authFromContext(r.Context()).User, input)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) organizationMembers(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	members, err := h.workspace.Members(r.Context(), authFromContext(r.Context()).User)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, map[string]any{"members": members})
}

func (h *identityHandlers) updateOrganizationMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input workspace.UpdateMemberInput
	if err := decodeJSON(w, r, &input); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	value, err := h.workspace.UpdateMember(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "actorID"), input)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) organizationAudit(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	value, err := h.workspace.Audit(r.Context(), authFromContext(r.Context()).User, limit)
	if err != nil {
		h.workspaceError(w, r, err)
		return
	}
	writeJSON(h.logger, w, standardhttp.StatusOK, value)
}

func (h *identityHandlers) workspaceError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	switch {
	case errors.Is(err, workspace.ErrForbidden):
		h.writeError(w, r, standardhttp.StatusForbidden, "forbidden", "You do not have permission to manage this workspace.")
	case errors.Is(err, workspace.ErrNotFound):
		h.writeError(w, r, standardhttp.StatusNotFound, "workspace_not_found", "Workspace resource was not found.")
	case errors.Is(err, workspace.ErrVersionConflict):
		h.writeError(w, r, standardhttp.StatusConflict, "version_conflict", "Workspace settings changed. Reload and try again.")
	case errors.Is(err, workspace.ErrInvalid):
		h.writeError(w, r, standardhttp.StatusUnprocessableEntity, "validation_failed", err.Error())
	default:
		h.internalError(w, r, err)
	}
}
