/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "notification-service",
  name: "NotificationService",
  bundleIdentifier: ".notification-service",
  deploymentTarget: "16.4",
  // Shares the notification key with the app (src/push/keys.ts).
  entitlements: {
    "com.apple.security.application-groups": [
      `group.${config.ios.bundleIdentifier}`,
    ],
    "keychain-access-groups": [`group.${config.ios.bundleIdentifier}`],
  },
});
