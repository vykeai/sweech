cask "sweech-bar" do
  version "0.2.0"
  sha256 "PLACEHOLDER"

  url "https://github.com/vykeai/sweech/releases/download/v#{version}/SweechBar-#{version}.dmg"
  name "SweechBar"
  desc "Menu bar companion for sweech — live AI usage monitoring"
  homepage "https://github.com/vykeai/sweech"

  app "SweechBar.app"

  zap trash: [
    "~/Library/Preferences/ai.sweech.bar.plist",
    "~/Library/LaunchAgents/ai.sweech.bar.plist",
  ]
end
