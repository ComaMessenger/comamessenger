import type { ExpoConfig } from "expo/config";

// The bundle identifier is fixed by the first store build and depends on the
// public Coma domain (ADR-0011); until that decision it comes from the env.
const bundleIdentifier = process.env.COMA_BUNDLE_ID ?? "dev.comamessenger.app";

const config: ExpoConfig = {
  name: "Coma",
  slug: "coma",
  scheme: "coma",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier,
    supportsTablet: false,
    deploymentTarget: "16.4",
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: bundleIdentifier,
    adaptiveIcon: {
      backgroundColor: "#174586",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 200,
        backgroundColor: "#174586",
      },
    ],
    ["expo-build-properties", { android: { minSdkVersion: 26 } }],
  ],
  experiments: { typedRoutes: true },
};

export default config;
