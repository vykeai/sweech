import XCTest
@testable import SweechBar

final class GroupedColumnLayoutTests: XCTestCase {
    func testBuildColumnsPlacesClaudeThenCodexThenExternalGroups() {
        let columns = GroupedColumnLayout.buildColumns(
            claude: ["claude-a", "claude-b"],
            codex: ["codex-a"],
            externalGroups: [
                GroupedColumnSection(title: "Alibaba Cloud", items: ["ali"]),
                GroupedColumnSection(title: "MiniMax", items: ["mini"]),
                GroupedColumnSection(title: "Kimi", items: ["kimi"]),
            ]
        )

        XCTAssertEqual(columns.count, 3)
        XCTAssertEqual(columns[0].map(\.title), ["claude"])
        XCTAssertEqual(columns[1].map(\.title), ["codex"])
        XCTAssertEqual(columns[2].map(\.title), ["Alibaba Cloud", "MiniMax", "Kimi"])
    }

    func testBuildColumnsOmitsEmptyColumnsButKeepsExternalStacked() {
        let columns = GroupedColumnLayout.buildColumns(
            claude: [],
            codex: ["codex-a"],
            externalGroups: [
                GroupedColumnSection(title: "Alibaba Cloud", items: []),
                GroupedColumnSection(title: "MiniMax", items: ["mini"]),
            ]
        )

        XCTAssertEqual(columns.count, 2)
        XCTAssertEqual(columns[0].map(\.title), ["codex"])
        XCTAssertEqual(columns[1].map(\.title), ["MiniMax"])
    }

    func testBuildColumnsReturnsSingleClaudeColumnWhenNoOtherGroupsExist() {
        let columns = GroupedColumnLayout.buildColumns(
            claude: ["claude-a"],
            codex: [],
            externalGroups: []
        )

        XCTAssertEqual(columns.count, 1)
        XCTAssertEqual(columns[0].map(\.title), ["claude"])
    }
}
