class Sweech < Formula
  desc "AI CLI switcher — isolated profile dirs per provider"
  homepage "https://github.com/vykeai/sweech"
  url "https://github.com/vykeai/sweech/archive/refs/tags/v0.2.0.tar.gz"
  # sha256 will need to be filled in when the release is published
  sha256 "PLACEHOLDER"
  license "MIT"

  depends_on "node@18" => :build
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "sweech", shell_output("#{bin}/sweech --version")
  end
end
