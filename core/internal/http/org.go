package http

import (
	"errors"
	standardhttp "net/http"
	"strconv"
	"strings"

	"github.com/comamessenger/comamessenger/core/internal/api"
	"github.com/comamessenger/comamessenger/core/internal/chat"
	"github.com/comamessenger/comamessenger/core/internal/orgstructure"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// orgRoutes serve the org structure («Оргструктура», phase 6.5 wave 2). Any
// active person reads it; writes need org.manage or members.manage (the
// department chat also its lead) and are limited to 120 a minute per person.
// Without the service (tests of other packages) every route answers 501.
func (h *identityHandlers) orgRoutes(protected chi.Router) {
	if h.org == nil {
		for _, route := range orgContractRoutes {
			protected.MethodFunc(route.method, route.path, h.orgNotImplemented)
		}
		return
	}
	write := protected.With(h.actorRateLimit("org-write", h.orgWriteRate))
	protected.Get("/org", h.getOrgStructure)
	write.Post("/org/departments", h.createDepartment)
	write.Patch("/org/departments/{departmentID}", h.updateDepartment)
	write.Delete("/org/departments/{departmentID}", h.deleteDepartment)
	write.Post("/org/departments/{departmentID}/move", h.moveDepartment)
	write.Put("/org/departments/{departmentID}/members/{actorID}", h.setDepartmentMember)
	write.Delete("/org/departments/{departmentID}/members/{actorID}", h.removeDepartmentMember)
	write.Post("/org/departments/{departmentID}/chat", h.createDepartmentChat)
	write.Put("/org/departments/{departmentID}/chat", h.linkDepartmentChat)
	write.Delete("/org/departments/{departmentID}/chat", h.unlinkDepartmentChat)
	protected.Get("/org/departments/{departmentID}/chat/missing", h.listDepartmentChatMissing)
	write.Post("/org/departments/{departmentID}/chat/add-missing", h.addDepartmentChatMissing)
	write.Put("/org/people/{actorID}", h.setPersonOrg)
	write.Post("/org/people/assign", h.assignPeopleOrg)
	write.Post("/org/positions", h.createPosition)
	write.Post("/org/positions/bulk", h.createPositions)
	write.Patch("/org/positions/{positionID}", h.updatePosition)
	write.Delete("/org/positions/{positionID}", h.deletePosition)
	protected.Get("/org/title-suggestions", h.listTitleSuggestions)
}

var orgContractRoutes = []struct{ method, path string }{
	{"GET", "/org"},
	{"POST", "/org/departments"},
	{"PATCH", "/org/departments/{departmentID}"},
	{"DELETE", "/org/departments/{departmentID}"},
	{"POST", "/org/departments/{departmentID}/move"},
	{"PUT", "/org/departments/{departmentID}/members/{actorID}"},
	{"DELETE", "/org/departments/{departmentID}/members/{actorID}"},
	{"POST", "/org/departments/{departmentID}/chat"},
	{"PUT", "/org/departments/{departmentID}/chat"},
	{"DELETE", "/org/departments/{departmentID}/chat"},
	{"GET", "/org/departments/{departmentID}/chat/missing"},
	{"POST", "/org/departments/{departmentID}/chat/add-missing"},
	{"PUT", "/org/people/{actorID}"},
	{"POST", "/org/people/assign"},
	{"POST", "/org/positions"},
	{"POST", "/org/positions/bulk"},
	{"PATCH", "/org/positions/{positionID}"},
	{"DELETE", "/org/positions/{positionID}"},
	{"GET", "/org/title-suggestions"},
}

func (h *identityHandlers) orgNotImplemented(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	h.writeError(w, r, standardhttp.StatusNotImplemented, "not_implemented", "The org structure is not available on this server yet.")
}

func orgETag(version int64) string {
	return `"org-` + strconv.FormatInt(version, 10) + `"`
}

// etagMatches implements If-None-Match for one strong tag: a list, weak
// forms and "*" are accepted.
func etagMatches(header, tag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == tag {
			return true
		}
	}
	return false
}

func (h *identityHandlers) getOrgStructure(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	user := authFromContext(r.Context()).User
	w.Header().Set("Cache-Control", "private, no-cache")
	if header := r.Header.Get("If-None-Match"); header != "" && len(header) <= 256 {
		version, err := h.org.Version(r.Context(), user)
		if err != nil {
			h.writeOrgError(w, r, err)
			return
		}
		if tag := orgETag(version); etagMatches(header, tag) {
			w.Header().Set("ETag", tag)
			w.WriteHeader(standardhttp.StatusNotModified)
			return
		}
	}
	result, err := h.org.Structure(r.Context(), user)
	if err != nil {
		h.writeOrgError(w, r, err)
		return
	}
	w.Header().Set("ETag", orgETag(result.Version))
	writeJSON(h.logger, w, standardhttp.StatusOK, result)
}

func (h *identityHandlers) createDepartment(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.CreateDepartmentInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.CreateDepartment(r.Context(), authFromContext(r.Context()).User, input)
	h.writeOrg(w, r, standardhttp.StatusCreated, result, err)
}

func (h *identityHandlers) updateDepartment(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.UpdateDepartmentInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.UpdateDepartment(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) deleteDepartment(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.org.DeleteDepartment(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), r.URL.Query().Get("members_to"))
	h.writeOrg(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) moveDepartment(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.MoveDepartmentInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.MoveDepartment(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) setDepartmentMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.SetDepartmentMemberInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.SetDepartmentMember(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), chi.URLParam(r, "actorID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) removeDepartmentMember(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.org.RemoveDepartmentMember(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), chi.URLParam(r, "actorID"))
	h.writeOrg(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) setPersonOrg(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.SetPersonInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.SetPerson(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "actorID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) assignPeopleOrg(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.AssignPeopleInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.AssignPeople(r.Context(), authFromContext(r.Context()).User, input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) createPosition(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.CreatePositionInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.CreatePosition(r.Context(), authFromContext(r.Context()).User, input)
	h.writeOrg(w, r, standardhttp.StatusCreated, result, err)
}

func (h *identityHandlers) createPositions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.CreatePositionsInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.CreatePositions(r.Context(), authFromContext(r.Context()).User, input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) updatePosition(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.UpdatePositionInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.UpdatePosition(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "positionID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) deletePosition(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.org.DeletePosition(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "positionID"))
	h.writeOrg(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) listTitleSuggestions(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.org.TitleSuggestions(r.Context(), authFromContext(r.Context()).User)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) createDepartmentChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.org.CreateDepartmentChat(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"))
	h.writeOrg(w, r, standardhttp.StatusCreated, result, err)
}

func (h *identityHandlers) linkDepartmentChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	var input orgstructure.LinkDepartmentChatInput
	if !h.decodeOrg(w, r, &input) {
		return
	}
	result, err := h.org.LinkDepartmentChat(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"), input)
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) unlinkDepartmentChat(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	err := h.org.UnlinkDepartmentChat(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"))
	h.writeOrg(w, r, standardhttp.StatusNoContent, nil, err)
}

func (h *identityHandlers) listDepartmentChatMissing(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.org.DepartmentChatMissing(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"))
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) addDepartmentChatMissing(w standardhttp.ResponseWriter, r *standardhttp.Request) {
	result, err := h.org.AddDepartmentChatMissing(r.Context(), authFromContext(r.Context()).User, chi.URLParam(r, "departmentID"))
	h.writeOrg(w, r, standardhttp.StatusOK, result, err)
}

func (h *identityHandlers) decodeOrg(w standardhttp.ResponseWriter, r *standardhttp.Request, destination any) bool {
	if err := decodeJSON(w, r, destination); err != nil {
		h.writeError(w, r, standardhttp.StatusBadRequest, "invalid_request", err.Error())
		return false
	}
	return true
}

func (h *identityHandlers) writeOrg(w standardhttp.ResponseWriter, r *standardhttp.Request, status int, payload any, err error) {
	if err != nil {
		h.writeOrgError(w, r, err)
		return
	}
	if status == standardhttp.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	writeJSON(h.logger, w, status, payload)
}

func (h *identityHandlers) writeOrgError(w standardhttp.ResponseWriter, r *standardhttp.Request, err error) {
	var detailed *orgstructure.Error
	details := map[string]any{}
	message := ""
	if errors.As(err, &detailed) {
		if detailed.Field != "" {
			details["field"] = detailed.Field
		}
		if detailed.Limit != "" {
			details["limit"] = detailed.Limit
		}
		message = detailed.Message
	}
	write := func(status int, code api.ErrorCode, fallback string) {
		if message == "" {
			message = fallback
		}
		body := api.Error{Code: code, Message: message, RequestId: middleware.GetReqID(r.Context())}
		if len(details) > 0 {
			body.Details = &details
		}
		writeJSON(h.logger, w, status, body)
	}
	switch {
	case errors.Is(err, orgstructure.ErrForbidden), errors.Is(err, chat.ErrForbidden):
		message = ""
		write(standardhttp.StatusForbidden, "forbidden", "You do not have permission to change the org structure.")
	case errors.Is(err, orgstructure.ErrDepartmentNotFound):
		write(standardhttp.StatusNotFound, "department_not_found", "The department was not found.")
	case errors.Is(err, orgstructure.ErrPositionNotFound):
		write(standardhttp.StatusNotFound, "position_not_found", "The position was not found.")
	case errors.Is(err, orgstructure.ErrInvalid):
		write(standardhttp.StatusUnprocessableEntity, "org_invalid", "The org structure input is invalid.")
	case errors.Is(err, orgstructure.ErrNameTaken):
		write(standardhttp.StatusConflict, "org_name_taken", "The name is already taken.")
	case errors.Is(err, orgstructure.ErrCycle):
		write(standardhttp.StatusConflict, "org_cycle", "A department cannot be inside its own subdepartment.")
	case errors.Is(err, orgstructure.ErrDepthExceeded):
		write(standardhttp.StatusUnprocessableEntity, "org_depth_exceeded", "Departments are nested too deep.")
	case errors.Is(err, orgstructure.ErrLimitReached):
		write(standardhttp.StatusConflict, "org_limit_reached", "An org structure limit was reached.")
	case errors.Is(err, orgstructure.ErrVersionConflict):
		write(standardhttp.StatusConflict, "org_version_conflict", "The org structure changed. Reload and try again.")
	case errors.Is(err, orgstructure.ErrChatExists):
		write(standardhttp.StatusConflict, "department_chat_exists", "The department or the chat is already linked.")
	case errors.Is(err, orgstructure.ErrChatInvalid):
		write(standardhttp.StatusUnprocessableEntity, "department_chat_invalid", "The chat cannot be the department chat.")
	case errors.Is(err, chat.ErrInvalid):
		message = ""
		write(standardhttp.StatusUnprocessableEntity, "validation_failed", trimErrorPrefix(err))
	case errors.Is(err, chat.ErrNotFound):
		message = ""
		write(standardhttp.StatusForbidden, "forbidden", "You cannot add members to this chat.")
	default:
		h.internalError(w, r, err)
	}
}
