/**
 * Module catalogs: every feature folder may ship an `i18n.ts` with the keys it
 * introduces. The English side must mirror the Russian keys exactly, which the
 * type parameter enforces at compile time.
 */
export type Catalog<K extends string = string> = {
  ru: Record<K, string>;
  en: Record<K, string>;
};

export function defineCatalog<const R extends Record<string, string>>(
  ru: R,
  en: Record<keyof R, string>,
): Catalog<Extract<keyof R, string>> {
  return { ru, en };
}

export function mergeCatalogs(
  base: Catalog,
  modules: Catalog[],
): { ru: Record<string, string>; en: Record<string, string> } {
  const ru: Record<string, string> = { ...base.ru };
  const en: Record<string, string> = { ...base.en };
  for (const module of modules) {
    for (const key of Object.keys(module.ru)) {
      if (import.meta.env.DEV && key in ru)
        throw new Error(`Duplicate translation key: ${key}`);
      ru[key] = module.ru[key]!;
      en[key] = module.en[key]!;
    }
  }
  return { ru, en };
}
