import i18n from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { ru } from "./ru";
import { en } from "./en";
import { mergeCatalogs } from "./catalog";
import { authCatalog } from "../auth/i18n";
import { shellCatalog } from "../shell/i18n";
import { chatsCatalog } from "../chats/i18n";
import { conversationCatalog } from "../conversation/i18n";
import { dialogsCatalog } from "../dialogs/i18n";
import { directoriesCatalog } from "../directories/i18n";

const catalogs = mergeCatalogs({ ru, en }, [
  authCatalog,
  shellCatalog,
  chatsCatalog,
  conversationCatalog,
  dialogsCatalog,
  directoriesCatalog,
]);

const pseudo = Object.fromEntries(
  Object.entries(catalogs.en).map(([key, value]) => [
    key,
    `⟦${value.replace(/[aeiou]/gi, "$&$&")}····⟧`,
  ]),
);
const saved =
  localStorage.getItem("coma-locale") ??
  (navigator.language.startsWith("ru") ? "ru" : "en");
void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    lng: saved,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      ru: { translation: catalogs.ru },
      en: { translation: catalogs.en },
      pseudo: { translation: pseudo },
    },
  });
document.documentElement.lang = saved === "pseudo" ? "en" : saved;
export async function setLocale(locale: string) {
  localStorage.setItem("coma-locale", locale);
  document.documentElement.lang = locale === "pseudo" ? "en" : locale;
  await i18n.changeLanguage(locale);
}
export default i18n;
