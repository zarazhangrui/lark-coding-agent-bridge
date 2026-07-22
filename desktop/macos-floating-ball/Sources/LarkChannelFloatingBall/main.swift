import AppKit
import Foundation

enum DesktopStatus: String, Codable {
    case offline
    case connecting
    case idle
    case queued
    case thinking
    case toolRunning = "tool_running"
    case streaming
    case reconnecting
    case error

    var label: String {
        switch self {
        case .offline: return "offline"
        case .connecting: return "connecting"
        case .idle: return "idle"
        case .queued: return "queued"
        case .thinking: return "thinking"
        case .toolRunning: return "tool"
        case .streaming: return "streaming"
        case .reconnecting: return "reconnecting"
        case .error: return "error"
        }
    }

    var color: NSColor {
        switch self {
        case .offline: return NSColor.systemGray
        case .connecting: return NSColor.systemBlue
        case .idle: return NSColor.systemGreen
        case .queued: return NSColor.systemYellow
        case .thinking: return NSColor.systemPurple
        case .toolRunning: return NSColor.systemOrange
        case .streaming: return NSColor.systemTeal
        case .reconnecting: return NSColor.systemIndigo
        case .error: return NSColor.systemRed
        }
    }
}

struct ProfileStatus: Codable {
    let profile: String
    let botName: String?
    let appIdSuffix: String?
    let agent: String
    let status: DesktopStatus
    let activeRunCount: Int
    let queuedMessageCount: Int
    let updatedAt: String
    let lastErrorKind: String?
}

struct StatusSnapshot: Codable {
    let updatedAt: String
    let aggregateStatus: DesktopStatus
    let profiles: [ProfileStatus]
}

struct BallPosition: Codable {
    let x: Double
    let y: Double
}

final class StatusStore {
    private let statusURL: URL
    private let positionURL: URL
    private let logURL: URL

    init(root: URL) {
        self.statusURL = root.appendingPathComponent("desktop-status.json")
        self.positionURL = root.appendingPathComponent("desktop-floating-ball.json")
        self.logURL = root.appendingPathComponent("desktop-floating-ball.log")
    }

    func readSnapshot() -> StatusSnapshot {
        guard let data = try? Data(contentsOf: statusURL),
              let snapshot = try? JSONDecoder().decode(StatusSnapshot.self, from: data) else {
            return StatusSnapshot(updatedAt: isoNow(), aggregateStatus: .offline, profiles: [])
        }
        return snapshot
    }

    func readPosition() -> NSPoint? {
        guard let data = try? Data(contentsOf: positionURL),
              let position = try? JSONDecoder().decode(BallPosition.self, from: data) else {
            return nil
        }
        return NSPoint(x: position.x, y: position.y)
    }

    func writePosition(_ point: NSPoint) {
        let position = BallPosition(x: point.x, y: point.y)
        guard let data = try? JSONEncoder().encode(position) else { return }
        try? FileManager.default.createDirectory(
            at: positionURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: positionURL, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: positionURL.path)
    }

    func log(_ message: String) {
        let line = "\(isoNow()) \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        try? FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if FileManager.default.fileExists(atPath: logURL.path),
           let handle = try? FileHandle(forWritingTo: logURL) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: logURL, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        }
    }
}

final class SingleInstanceLock {
    private let fd: Int32

    init?(root: URL) {
        let dir = root.appendingPathComponent("registry", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("desktop-floating-ball.lock").path
        fd = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }
        ftruncate(fd, 0)
        let pid = "\(ProcessInfo.processInfo.processIdentifier)\n"
        _ = pid.withCString { write(fd, $0, strlen($0)) }
    }

    deinit {
        flock(fd, LOCK_UN)
        close(fd)
    }
}

final class BallView: NSView {
    var snapshot = StatusSnapshot(updatedAt: isoNow(), aggregateStatus: .offline, profiles: []) {
        didSet { needsDisplay = true }
    }
    var expanded = false {
        didSet { needsDisplay = true }
    }
    var onHoverChanged: ((Bool) -> Void)?
    var onDragEnded: (() -> Void)?

    private var tracking: NSTrackingArea?
    private var dragStart: NSPoint?
    private var windowStart: NSPoint?

    override var isFlipped: Bool { true }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let next = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self
        )
        addTrackingArea(next)
        tracking = next
    }

    override func mouseEntered(with event: NSEvent) {
        onHoverChanged?(true)
    }

    override func mouseExited(with event: NSEvent) {
        onHoverChanged?(false)
    }

    override func mouseDown(with event: NSEvent) {
        dragStart = NSEvent.mouseLocation
        windowStart = window?.frame.origin
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let dragStart, let windowStart else { return }
        let current = NSEvent.mouseLocation
        let next = NSPoint(
            x: windowStart.x + current.x - dragStart.x,
            y: windowStart.y + current.y - dragStart.y
        )
        window.setFrameOrigin(next)
    }

    override func mouseUp(with event: NSEvent) {
        dragStart = nil
        windowStart = nil
        onDragEnded?()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        if expanded {
            drawPanel(in: bounds)
        }
        drawBall(in: collapsedBallRect())
    }

    private func collapsedBallRect() -> NSRect {
        let side: CGFloat = 44
        if expanded {
            return NSRect(
                x: bounds.width - side,
                y: (bounds.height - side) / 2,
                width: side,
                height: side
            )
        }
        return NSRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
    }

    private func drawBall(in rect: NSRect) {
        let path = NSBezierPath(ovalIn: rect.insetBy(dx: 3, dy: 3))
        snapshot.aggregateStatus.color.setFill()
        path.fill()
        NSColor.white.withAlphaComponent(0.82).setStroke()
        path.lineWidth = 2
        path.stroke()
    }

    private func drawPanel(in rect: NSRect) {
        let panel = NSBezierPath(roundedRect: rect.insetBy(dx: 2, dy: 2), xRadius: 18, yRadius: 18)
        NSColor.windowBackgroundColor.withAlphaComponent(0.94).setFill()
        panel.fill()
        NSColor.separatorColor.withAlphaComponent(0.45).setStroke()
        panel.lineWidth = 1
        panel.stroke()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.labelColor,
        ]
        let profiles = snapshot.profiles.isEmpty
            ? [ProfileStatus(profile: "bridge", botName: nil, appIdSuffix: nil, agent: "-", status: .offline, activeRunCount: 0, queuedMessageCount: 0, updatedAt: isoNow(), lastErrorKind: nil)]
            : snapshot.profiles
        for (idx, profile) in profiles.prefix(8).enumerated() {
            let rowY = CGFloat(14 + idx * 26)
            let dot = NSBezierPath(ovalIn: NSRect(x: 18, y: rowY + 4, width: 10, height: 10))
            profile.status.color.setFill()
            dot.fill()
            let name = profile.botName ?? profile.profile
            let counts = profile.activeRunCount > 0 ? " \(profile.activeRunCount) run" :
                profile.queuedMessageCount > 0 ? " \(profile.queuedMessageCount) queued" : ""
            let text = "\(name)  \(profile.status.label)\(counts)" as NSString
            text.draw(in: NSRect(x: 36, y: rowY, width: rect.width - 54, height: 18), withAttributes: attrs)
        }
    }
}

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class BallController {
    private let store: StatusStore
    private let window: FloatingPanel
    private let view: BallView
    private var timer: Timer?
    private var collapseTimer: Timer?
    private var collapsedOrigin: NSPoint

    init(store: StatusStore) {
        self.store = store
        self.view = BallView(frame: NSRect(x: 0, y: 0, width: 44, height: 44))
        self.collapsedOrigin = BallController.safeOrigin(for: store.readPosition())
        self.window = FloatingPanel(
            contentRect: NSRect(origin: collapsedOrigin, size: NSSize(width: 44, height: 44)),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.hasShadow = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = false
        window.contentView = view
        view.onHoverChanged = { [weak self] expanded in self?.handleHoverChanged(expanded) }
        view.onDragEnded = { [weak self] in self?.saveCollapsedPosition() }
    }

    func start() {
        refresh()
        store.log("show window origin=\(window.frame.origin.x),\(window.frame.origin.y) size=\(window.frame.size.width),\(window.frame.size.height) screens=\(screenSummary())")
        window.orderFrontRegardless()
        window.display()
        timer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private func refresh() {
        view.snapshot = store.readSnapshot()
    }

    private func handleHoverChanged(_ hovering: Bool) {
        if hovering {
            collapseTimer?.invalidate()
            collapseTimer = nil
            setExpanded(true)
            return
        }
        scheduleCollapseIfOutside()
    }

    private func scheduleCollapseIfOutside() {
        collapseTimer?.invalidate()
        collapseTimer = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.collapseTimer = nil
            let mouse = NSEvent.mouseLocation
            if self.window.frame.insetBy(dx: -4, dy: -4).contains(mouse) {
                return
            }
            self.setExpanded(false)
        }
    }

    private func setExpanded(_ expanded: Bool) {
        if view.expanded == expanded {
            return
        }
        let size = expanded ? expandedSize() : NSSize(width: 44, height: 44)
        let origin: NSPoint
        if expanded {
            view.expanded = true
            origin = BallController.clamp(
                origin: NSPoint(
                    x: collapsedOrigin.x - (size.width - 44),
                    y: collapsedOrigin.y - (size.height - 44) / 2
                ),
                size: size
            )
            window.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
            view.frame = NSRect(origin: .zero, size: size)
        } else {
            let collapsedFrame = NSRect(origin: collapsedOrigin, size: size)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.allowsImplicitAnimation = true
                window.animator().setFrame(collapsedFrame, display: true)
            } completionHandler: { [weak self] in
                guard let self else { return }
                self.view.frame = NSRect(origin: .zero, size: size)
                self.view.expanded = false
            }
        }
    }

    private func expandedSize() -> NSSize {
        let rows = max(1, min(8, view.snapshot.profiles.count))
        return NSSize(width: 180, height: CGFloat(28 + rows * 26))
    }

    private func saveCollapsedPosition() {
        let origin = view.expanded
            ? NSPoint(
                x: window.frame.maxX - 44,
                y: window.frame.midY - 22
            )
            : window.frame.origin
        collapsedOrigin = BallController.clamp(origin: origin, size: NSSize(width: 44, height: 44))
        window.setFrameOrigin(collapsedOrigin)
        store.writePosition(collapsedOrigin)
    }

    private static func safeOrigin(for saved: NSPoint?) -> NSPoint {
        let visible = defaultVisibleFrame()
        let fallback = NSPoint(x: visible.midX - 22, y: visible.midY - 22)
        return clamp(origin: saved ?? fallback, size: NSSize(width: 44, height: 44))
    }

    private static func clamp(origin: NSPoint, size: NSSize) -> NSPoint {
        let frame = NSScreen.screens.first(where: { $0.visibleFrame.insetBy(dx: -200, dy: -200).contains(origin) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 900, height: 700)
        let inset: CGFloat = 8
        return NSPoint(
            x: min(max(origin.x, frame.minX + inset), frame.maxX - size.width - inset),
            y: min(max(origin.y, frame.minY + inset), frame.maxY - size.height - inset)
        )
    }

    private static func defaultVisibleFrame() -> NSRect {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.visibleFrame.contains(mouse) })?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSScreen.screens.first?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 900, height: 700)
    }
}

func screenSummary() -> String {
    NSScreen.screens.enumerated().map { idx, screen in
        let frame = screen.visibleFrame
        return "#\(idx)(x:\(Int(frame.minX)),y:\(Int(frame.minY)),w:\(Int(frame.width)),h:\(Int(frame.height)))"
    }.joined(separator: ",")
}

func isoNow() -> String {
    ISO8601DateFormatter().string(from: Date())
}

func rootURL() -> URL {
    let args = CommandLine.arguments
    if let idx = args.firstIndex(of: "--root"), idx + 1 < args.count {
        return URL(fileURLWithPath: args[idx + 1], isDirectory: true)
    }
    if let home = ProcessInfo.processInfo.environment["LARK_CHANNEL_HOME"] {
        return URL(fileURLWithPath: home, isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".lark-channel", isDirectory: true)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let root: URL
    private var instanceLock: SingleInstanceLock?
    private var controller: BallController?

    init(root: URL) {
        self.root = root
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = StatusStore(root: root)
        guard let lock = SingleInstanceLock(root: root) else {
            store.log("another instance is already running")
            NSApplication.shared.terminate(nil)
            return
        }
        instanceLock = lock
        store.log("application did finish launching root=\(root.path)")
        let controller = BallController(store: store)
        self.controller = controller
        controller.start()
    }
}

var retainedAppDelegate: AppDelegate?

let app = NSApplication.shared
retainedAppDelegate = AppDelegate(root: rootURL())
app.delegate = retainedAppDelegate
app.setActivationPolicy(.accessory)
app.run()
