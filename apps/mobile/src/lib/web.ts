import * as WebBrowser from "expo-web-browser";

/** Opens a page of the instance's web client, e.g. settings the app does not cover. */
export function openWebClient(serverURL: string, path = "/") {
  return WebBrowser.openBrowserAsync(`${serverURL}${path}`);
}
