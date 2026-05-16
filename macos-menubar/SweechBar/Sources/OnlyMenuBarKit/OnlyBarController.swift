import AppKit
import SwiftUI

// MARK: - OnlyBarController

open class OnlyBarController: NSObject {
    public let theme: OnlyBarTheme
    public let popoverWidth: CGFloat
    public let popoverHeight: CGFloat?
    public var iconName: String
    public var badgeCount: Int = 0 { didSet { updateIcon() } }
    public var onRefresh: (() -> Void)?
    public var onToggle: ((Bool) -> Void)?

    private var _statusItem: NSStatusItem
    private var popover: NSPopover

    /// Access the status bar button (e.g. for onboarding popovers).
    public var statusBarButton: NSStatusBarButton? { _statusItem.button }

    /// Update the status item length (e.g. for variable-width text labels).
    public func setStatusItemLength(_ length: CGFloat) {
        _statusItem.length = length
    }

    // MARK: - Init

    public init(
        theme: OnlyBarTheme = .defaultTheme,
        width: CGFloat = 360,
        height: CGFloat? = nil,
        icon: String,
        statusItemLength: CGFloat = NSStatusItem.squareLength
    ) {
        self.theme = theme
        self.popoverWidth = width
        self.popoverHeight = height
        self.iconName = icon
        self._statusItem = NSStatusBar.system.statusItem(withLength: statusItemLength)
        self.popover = NSPopover()
        super.init()

        popover.behavior = .transient
        popover.animates = true
        popover.appearance = NSAppearance(named: .darkAqua)

        if let button = _statusItem.button {
            button.action = #selector(handleClick(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        updateIcon()
    }

    // MARK: - Override points

    /// Return the SwiftUI view to display in the popover.
    /// Called every time the popover opens (fresh content each time).
    open func makeBody() -> AnyView {
        fatalError("Subclass must override makeBody()")
    }

    /// Override to customize icon rendering (e.g. custom PNG, tinting).
    /// Default renders the SF Symbol from `iconName` with optional badge.
    open func renderIcon() -> NSImage? {
        let img = NSImage(systemSymbolName: iconName, accessibilityDescription: iconName)
        img?.isTemplate = false
        if badgeCount > 0, let base = img {
            return Self.badgeImage(base: base, count: badgeCount)
        }
        return img
    }

    /// Override to provide a right-click context menu. Return nil for no menu.
    open func contextMenu() -> NSMenu? { nil }

    // MARK: - Icon

    public final func updateIcon() {
        guard let button = _statusItem.button else { return }
        button.image = renderIcon()
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyUpOrDown
    }

    /// Proven badge rendering — red pill with white count, composited onto the icon.
    public static func badgeImage(base: NSImage, count: Int) -> NSImage {
        let size = NSSize(width: 28, height: 22)
        let badge = NSImage(size: size)
        badge.lockFocus()
        base.draw(in: NSRect(x: 0, y: 0, width: 18, height: 18),
                   from: NSRect.zero, operation: .sourceOver, fraction: 1.0)
        let text = "\(count)" as NSString
        let fontSize: CGFloat = count > 9 ? 8 : 10
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let textSize = text.size(withAttributes: attrs)
        let badgeR = NSRect(x: size.width - textSize.width - 3,
                             y: size.height - textSize.height - 1,
                             width: textSize.width + 2,
                             height: textSize.height + 1)
        let pill = NSBezierPath(roundedRect: badgeR.insetBy(dx: -1, dy: -0.5), xRadius: 4, yRadius: 4)
        NSColor.systemRed.setFill()
        pill.fill()
        text.draw(in: badgeR, withAttributes: attrs)
        badge.unlockFocus()
        return badge
    }

    // MARK: - Click handling

    @objc private final func handleClick(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp, let menu = contextMenu() {
            _statusItem.menu = menu
            _statusItem.button?.performClick(nil)
            _statusItem.menu = nil
        } else {
            togglePopover()
        }
    }

    // MARK: - Toggle

    @objc public final func togglePopover() {
        guard let button = _statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
            onToggle?(false)
        } else {
            let contentHeight = popoverHeight ?? 10

            // Build fresh content each open
            let view = makeBody()
            let hc = NSHostingController(rootView: view)

            // Positioning fix: explicit frame + contentSize AFTER contentViewController
            hc.view.frame = NSRect(x: 0, y: 0, width: popoverWidth, height: contentHeight)
            hc.view.layer?.backgroundColor = NSColor.clear.cgColor
            popover.contentViewController = hc
            popover.contentSize = NSSize(width: popoverWidth, height: contentHeight)

            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            onRefresh?()
            onToggle?(true)
        }
    }

    /// Close the popover programmatically (e.g. before showing a settings window).
    public final func closePopover() {
        if popover.isShown {
            popover.performClose(nil)
            onToggle?(false)
        }
    }
}
