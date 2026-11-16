const fs = require("fs");
const path = require("path");
const {
  withAndroidManifest,
  withDangerousMod,
} = require("expo/config-plugins");

// Plain HTTP is accepted only for a Core on the developer's machine
// (src/lib/server.ts: localhost, 127.0.0.1, ::1 and 10.0.2.2, the Android
// emulator's host). Debug builds allow cleartext everywhere; without this a
// release APK could not reach a local Core at all, while every other host
// stays HTTPS-only. Debug builds get a variant that keeps cleartext open, so
// Metro on a LAN address still works on a phone (the manifest's
// usesCleartextTraffic is ignored once a security config is set).
// android/ is generated, so the files are written here.
const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
    <domain includeSubdomains="false">::1</domain>
  </domain-config>
</network-security-config>
`;

const DEBUG_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

function write(root, variant, contents) {
  const dir = path.join(root, `app/src/${variant}/res/xml`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "network_security_config.xml"), contents);
}

const withConfigFile = (config) =>
  withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const root = modConfig.modRequest.platformProjectRoot;
      write(root, "main", CONFIG);
      write(root, "debug", DEBUG_CONFIG);
      return modConfig;
    },
  ]);

module.exports = (config) =>
  withAndroidManifest(withConfigFile(config), (manifestConfig) => {
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (application)
      application.$["android:networkSecurityConfig"] =
        "@xml/network_security_config";
    return manifestConfig;
  });
