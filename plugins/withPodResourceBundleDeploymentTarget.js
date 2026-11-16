// Expo config plugin: raise every pod's resource-bundle target to React Native's minimum iOS version.
//
// Xcode 27 refuses to build a target whose iOS deployment target is below 15.0 (older Xcodes only
// warned). React Native's own post-install hook (`ReactNativePodsUtils.updateOSDeploymentTarget`)
// already raises each pod's main target to `min_ios_version_supported`, but it never touches the
// separate resource-bundle targets a pod declares. Those keep the podspec's own floor, so
// react-native-svg 15.15.4 (the version Expo SDK 57 pins) leaves `RNSVG-RNSVGFilters` at iOS 12.4
// and the archive fails.
//
// This adds the same rule for resource bundles, inside the Podfile's existing `post_install`. It only
// ever raises a target, never lowers one. Drop it once React Native's hook covers resource bundles
// or Expo's pinned react-native-svg declares iOS 15+ itself (15.16 does).
const { withPodfile } = require("expo/config-plugins");

const MARKER = "# @generated withPodResourceBundleDeploymentTarget";

const SNIPPET = `    ${MARKER}
    installer.target_installation_results.pod_target_installation_results.each_value do |result|
      result.resource_bundle_targets.each do |bundle|
        bundle.build_configurations.each do |config|
          current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
          if current.nil? || current.to_f < min_ios_version_supported.to_f
            config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = min_ios_version_supported
          end
        end
      end
    end
`;

const HOOK = "post_install do |installer|\n";

module.exports = function withPodResourceBundleDeploymentTarget(config) {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;
    if (podfile.includes(MARKER)) return cfg;
    if (!podfile.includes(HOOK)) {
      throw new Error(
        "withPodResourceBundleDeploymentTarget: no `post_install do |installer|` in the Podfile",
      );
    }
    cfg.modResults.contents = podfile.replace(HOOK, HOOK + SNIPPET);
    return cfg;
  });
};
