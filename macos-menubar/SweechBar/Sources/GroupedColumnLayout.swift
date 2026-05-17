import Foundation

struct GroupedColumnSection<Item> {
    let title: String
    let items: [Item]
}

enum GroupedColumnLayout {
    static func buildColumns<Item>(
        claude: [Item],
        codex: [Item],
        externalGroups: [GroupedColumnSection<Item>]
    ) -> [[GroupedColumnSection<Item>]] {
        var columns: [[GroupedColumnSection<Item>]] = []

        if !claude.isEmpty {
            columns.append([GroupedColumnSection(title: "Anthropic", items: claude)])
        }

        if !codex.isEmpty {
            columns.append([GroupedColumnSection(title: "OpenAI", items: codex)])
        }

        let externalOnly = externalGroups.filter { !$0.items.isEmpty }
        if !externalOnly.isEmpty {
            columns.append(externalOnly)
        }

        return columns
    }
}
