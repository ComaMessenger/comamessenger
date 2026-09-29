const { withGradleProperties } = require("expo/config-plugins");

// The Expo template caps Gradle's metaspace at 512 MB, which the release
// dex merge of this app exceeds. android/ is generated, so the limit is set
// here rather than in gradle.properties by hand.
const JVM_ARGS =
  "-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8";

module.exports = (config) =>
  withGradleProperties(config, (gradleConfig) => {
    const properties = gradleConfig.modResults.filter(
      (item) =>
        !(item.type === "property" && item.key === "org.gradle.jvmargs"),
    );
    properties.push({
      type: "property",
      key: "org.gradle.jvmargs",
      value: JVM_ARGS,
    });
    gradleConfig.modResults = properties;
    return gradleConfig;
  });
