import Cocoa
import Carbon.HIToolbox

/// Registers a global keyboard shortcut to toggle the SweechBar popover.
/// Default: Cmd+Shift+S. Configurable via UserDefaults "sweechHotkeyEnabled".
class HotkeyManager {
    static let shared = HotkeyManager()

    private var eventHandler: EventHandlerRef?
    private var hotkeyRef: EventHotKeyRef?
    private let hotkeyID = EventHotKeyID(signature: OSType(0x5357_4348), id: 1) // "SWCH"

    var onToggle: (() -> Void)?

    private init() {}

    func register() {
        let enabled = UserDefaults.standard.object(forKey: "sweechHotkeyEnabled") as? Bool ?? true
        guard enabled else { return }

        // Cmd+Shift+S
        let modifiers: UInt32 = UInt32(cmdKey | shiftKey)
        let keyCode: UInt32 = UInt32(kVK_ANSI_S)

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))

        let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
            HotkeyManager.shared.onToggle?()
            return noErr
        }

        InstallEventHandler(GetApplicationEventTarget(), handler, 1, &eventType, nil, &eventHandler)
        RegisterEventHotKey(keyCode, modifiers, hotkeyID, GetApplicationEventTarget(), 0, &hotkeyRef)
    }

    func unregister() {
        if let ref = hotkeyRef {
            UnregisterEventHotKey(ref)
            hotkeyRef = nil
        }
    }
}
