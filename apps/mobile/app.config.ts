import type { ExpoConfig } from "expo/config";

// The bundle identifier is fixed by the first store build and depends on the
// public Coma domain (ADR-0011); until that decision it comes from the env.
const bundleIdentifier = process.env.COMA_BUNDLE_ID ?? "com.comamessenger.app";
// Store build numbers come from the fastlane lanes (next after the stores).
const buildNumber = process.env.COMA_BUILD_NUMBER;

// Shared with the Notification Service Extension for the notification key.
const appGroup = `group.${bundleIdentifier}`;

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
    ...(buildNumber ? { buildNumber } : {}),
    supportsTablet: false,
    deploymentTarget: "16.4",
    config: { usesNonExemptEncryption: false },
    appleTeamId: process.env.APPLE_TEAM_ID,
    entitlements: {
      "com.apple.security.application-groups": [appGroup],
      "keychain-access-groups": [appGroup],
    },
  },
  android: {
    package: bundleIdentifier,
    ...(buildNumber ? { versionCode: Number(buildNumber) } : {}),
    adaptiveIcon: {
      backgroundColor: "#174586",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    // Firebase config of the published app; supplied by EAS, never committed.
    googleServicesFile: process.env.GOOGLE_SERVICES_FILE,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    ["expo-notifications", { color: "#174586" }],
    [
      "expo-image-picker",
      {
        photosPermission:
          "Coma opens your library so you can attach photos and videos to messages and pick a profile photo.",
        cameraPermission:
          "Coma uses the camera so you can send photos and videos to chats.",
        microphonePermission:
          "Coma uses the microphone when you record video for chats.",
      },
    ],
    "@bacons/apple-targets",
    "./plugins/withAndroidReleaseSigning",
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
  // Permission prompts in the phone's language; English is the fallback above.
  locales: { ru: "./locales/ru.json", en: "./locales/en.json" },
  experiments: { typedRoutes: true },
  extra: {
    appGroup,
    // Relay whose APNs/FCM keys this build is signed for (ADR-0012).
    pushRelayURL: process.env.COMA_PUSH_RELAY_URL ?? "",
  },
};

export default config;
