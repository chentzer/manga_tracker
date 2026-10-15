const { withGradleProperties } = require('@expo/config-plugins');

// "Could not receive a message from the daemon" during EAS builds
// usually means the Gradle daemon got OOM-killed by the build
// container, not a clean out-of-memory error — the default/unset JVM
// heap can try to claim more memory than a shared "medium" build
// machine actually has available. This sets a conservative, explicit
// heap size instead of leaving it to Gradle's own guess, and disables
// the daemon outright (each build runs fresh in one process — slightly
// slower, but eliminates daemon-communication failures like this one
// as a possible cause entirely).
module.exports = function withGradleMemoryFix(config) {
  return withGradleProperties(config, (config) => {
    const props = config.modResults;
    const setProp = (key, value) => {
      const existing = props.find((p) => p.type === 'property' && p.key === key);
      if (existing) {
        existing.value = value;
      } else {
        props.push({ type: 'property', key, value });
      }
    };

    setProp('org.gradle.jvmargs', '-Xmx3072m -XX:MaxMetaspaceSize=512m');
    setProp('org.gradle.daemon', 'false');

    return config;
  });
};
