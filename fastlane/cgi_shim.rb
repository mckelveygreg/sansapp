# Ruby 4 moved CGI.parse out of the default cgi gem, and fastlane's Apple login (spaceship) still
# calls it. Load this before fastlane until spaceship stops relying on it:
#   RUBYOPT="-r./fastlane/cgi_shim.rb" fastlane ios beta
require "cgi"
unless CGI.respond_to?(:parse)
  def CGI.parse(query)
    params = Hash.new { |h, k| h[k] = [] }
    query.to_s.split(/[&;]/).each do |pair|
      next if pair.empty?
      key, value = pair.split("=", 2).map { |v| CGI.unescape(v.to_s.tr("+", " ")) }
      params[key] << value
    end
    params.default = nil
    params
  end
end
