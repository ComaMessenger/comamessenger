import { defineCatalog } from "../i18n/catalog";

/** Error texts of `apiErrorKey` and `fieldErrorKey` (packages/core) the web did not have. */
export const settingsCatalog = defineCatalog(
  {
    errorWrongPassword: "Текущий пароль указан неверно",
    errorEmailTaken: "Эта почта уже занята в пространстве",
    errorRateLimited: "Слишком много попыток. Подождите и повторите",
    errorTooLarge: "Файл слишком большой",
    errorUnsupportedFormat: "Этот формат не поддерживается",
  },
  {
    errorWrongPassword: "The current password is incorrect",
    errorEmailTaken: "This email is already used in the workspace",
    errorRateLimited: "Too many attempts. Wait and try again",
    errorTooLarge: "The file is too large",
    errorUnsupportedFormat: "This format is not supported",
  },
);
