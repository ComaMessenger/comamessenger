import i18n from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import { ru } from "./ru";
import { en } from "./en";

export type Locale = "ru" | "en";

function deviceLocale(): Locale {
  return getLocales()[0]?.languageCode === "ru" ? "ru" : "en";
}

void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    lng: deviceLocale(),
    fallbackLng: "en",
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { ru: { translation: ru }, en: { translation: en } },
  });

/** Applies the account locale from server preferences; unknown values keep the device language. */
export function setLocale(locale: string | undefined) {
  if (locale === "ru" || locale === "en") void i18n.changeLanguage(locale);
}

export default i18n;
