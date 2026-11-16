# Refuses to ship an iOS binary that iOS 27 will kill at launch.
#
# An app linked against the iOS 27 SDK (Xcode 27+) must adopt the UIScene lifecycle, or UIKit traps
# in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption the moment the first scene is
# created (EXC_BREAKPOINT, ~0.4 s after launch). 1.3.0 builds 17–20 shipped that way: Xcode 27.2
# and no UIApplicationSceneManifest. The config fix is expo-build-properties `enableSceneSupport`
# (see app.config.ts). This guard checks the BUILT artifact, so any regression fails the lane
# before upload, whatever the cause.
#
# Fastfile calls it after build_app. Run by hand on any .ipa / .app / .xcarchive:
#   ruby fastlane/scene_guard.rb build/SansApp.ipa

require "open3"
require "tmpdir"

module SceneGuard
  FIRST_SDK_REQUIRING_SCENES = 27

  module_function

  # Returns nil when the artifact will launch, or a human-readable reason when it will not.
  def problem(artifact)
    with_info_plist(artifact) do |plist|
      sdk = plist_value(plist, "DTSDKName") or return "no DTSDKName in #{artifact}'s Info.plist"
      major = sdk[/\d+/].to_i
      return nil if major < FIRST_SDK_REQUIRING_SCENES
      return nil if plist_value(plist, "UIApplicationSceneManifest:UISceneConfigurations")

      "#{File.basename(artifact)} is linked against #{sdk} but has no UIApplicationSceneManifest — " \
        "it will crash at launch on iOS #{FIRST_SDK_REQUIRING_SCENES}+. " \
        "Check expo-build-properties ios.enableSceneSupport in app.config.ts."
    end
  end

  def with_info_plist(artifact)
    path = File.expand_path(artifact)
    case path
    when /\.ipa\z/
      Dir.mktmpdir do |dir|
        _out, err, st = Open3.capture3("unzip", "-q", "-o", path, "Payload/*.app/Info.plist", "-d", dir)
        raise "unzip #{path} failed: #{err}" unless st.success?
        yield Dir[File.join(dir, "Payload", "*.app", "Info.plist")].first || raise("no Info.plist in #{path}")
      end
    when /\.xcarchive\z/
      yield Dir[File.join(path, "Products", "Applications", "*.app", "Info.plist")].first ||
        raise("no app in #{path}")
    when /\.app\z/
      yield File.join(path, "Info.plist")
    else
      raise "expected an .ipa, .app or .xcarchive, got #{artifact}"
    end
  end

  def plist_value(plist, key)
    out, _err, st = Open3.capture3("/usr/libexec/PlistBuddy", "-c", "Print :#{key}", plist)
    st.success? ? out.strip : nil
  end
end

if $PROGRAM_NAME == __FILE__
  abort "usage: ruby #{$PROGRAM_NAME} <.ipa|.app|.xcarchive>..." if ARGV.empty?
  failed = false
  ARGV.each do |artifact|
    if (reason = SceneGuard.problem(artifact))
      warn "FAIL  #{reason}"
      failed = true
    else
      puts "ok    #{artifact}"
    end
  end
  exit(failed ? 1 : 0)
end
