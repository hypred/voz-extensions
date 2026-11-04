// Records the microphone and all system audio until SIGINT or SIGTERM, then mixes both into one 16 kHz mono m4a.
// usage: meeting-rec <out.m4a> | meeting-rec --watch [--processes]
import AVFoundation
import AppKit
import ApplicationServices
import CoreAudio
import CryptoKit
import Darwin

struct BrowserPage: Encodable {
  let id: String
  let host: String
  var end = false
  var leave = false
  var microphone = false
}

struct CallControls {
  var inCall = false
  var pages: [BrowserPage] = []
}

struct AudioAppSnapshot: Encodable {
  let bundleID: String
  let input: Bool
  let output: Bool
  let inCall: Bool
  let pages: [BrowserPage]
}

struct AudioSnapshot: Encodable {
  let version = 2
  let capturedAt: Int64
  let apps: [AudioAppSnapshot]
  let request: Int?
}

final class RefreshRequests {
  let wake = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var pending: Int?

  func submit(_ request: Int) {
    lock.lock()
    pending = request
    lock.unlock()
    wake.signal()
  }

  func take() -> Int? {
    lock.lock()
    defer { lock.unlock() }
    let value = pending
    pending = nil
    return value
  }
}

struct DetectionConfiguration: Decodable {
  let nativeApps: [String: String]
  let browsers: [String: String]
  let callControlApps: [String]
  let endCallLabels: [String]
  let leaveLabels: [String]
  let microphoneLabels: [String]
}

func callButtonLabel(_ text: String) -> String {
  // Screen readers often append a keyboard shortcut in parentheses.
  (text.components(separatedBy: "(").first ?? text)
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
}

struct CallControlLabels {
  let end: Set<String>
  let leave: Set<String>
  let microphone: Set<String>

  init(_ configuration: DetectionConfiguration) {
    end = Set(configuration.endCallLabels.map(callButtonLabel))
    leave = Set(configuration.leaveLabels.map(callButtonLabel))
    microphone = Set(configuration.microphoneLabels.map(callButtonLabel))
  }
}

func readAccessibilityAttribute(_ element: AXUIElement, _ name: String, _ deadline: TimeInterval) -> CFTypeRef? {
  let remaining = deadline - ProcessInfo.processInfo.systemUptime
  guard remaining > 0 else { return nil }
  AXUIElementSetMessagingTimeout(element, Float(min(0.025, remaining)))
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func accessibilityFrame(_ element: AXUIElement, _ deadline: TimeInterval) -> CGRect? {
  guard let position = readAccessibilityAttribute(element, kAXPositionAttribute, deadline),
    let size = readAccessibilityAttribute(element, kAXSizeAttribute, deadline),
    CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
    AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
    point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite,
    dimensions.width > 0, dimensions.height > 0 else { return nil }
  return CGRect(origin: point, size: dimensions)
}

func applicationCallControls(_ bundleID: String, webOnly: Bool, _ labels: CallControlLabels, _ deadline: TimeInterval, _ prepared: inout Set<pid_t>, _ pageKey: SymmetricKey) -> CallControls {
  var result = CallControls()
  guard AXIsProcessTrusted() else { return result }
  func accessibilityAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    readAccessibilityAttribute(element, name, deadline)
  }
  for application in NSRunningApplication.runningApplications(withBundleIdentifier: bundleID) {
    guard ProcessInfo.processInfo.systemUptime < deadline else { return result }
    let root = AXUIElementCreateApplication(application.processIdentifier)
    if !prepared.contains(application.processIdentifier) {
      // As in Voz's FocusedWebsite, Chromium needs to be asked to expose its web tree.
      AXUIElementSetMessagingTimeout(root, 0.025)
      for attribute in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
        guard ProcessInfo.processInfo.systemUptime < deadline else { return result }
        AXUIElementSetAttributeValue(root, attribute as CFString, kCFBooleanTrue)
      }
      prepared.insert(application.processIdentifier)
    }
    let windows = accessibilityAttribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var visited = 0
    for window in windows {
      if accessibilityAttribute(window, kAXMinimizedAttribute) as? Bool == true { continue }
      guard let windowFrame = accessibilityFrame(window, deadline) else { continue }
      var stack: [(AXUIElement, Int, Int?, CGRect)] = [(window, 0, webOnly ? nil : 0, windowFrame)]
      var nextScope = 0
      var controls: [Int: (end: Bool, leave: Bool, microphone: Bool)] = [:]
      var pages: [Int: BrowserPage] = [:]
      while let (element, depth, parentScope, parentFrame) = stack.popLast() {
        guard visited < 1500, ProcessInfo.processInfo.systemUptime < deadline else { break }
        visited += 1
        guard depth < 64, let role = accessibilityAttribute(element, kAXRoleAttribute) as? String else { continue }
        if accessibilityAttribute(element, "AXHidden") as? Bool == true { continue }
        var scope = parentScope
        var visibleFrame = parentFrame
        if role == "AXWebArea" {
          nextScope += 1
          scope = nextScope
          if webOnly {
            let value = accessibilityAttribute(element, kAXURLAttribute)
            guard let url = (value as? URL) ?? (value as? String).flatMap(URL.init(string:)),
              url.scheme?.lowercased() == "https", let host = url.host?.lowercased(), !host.isEmpty
            else { continue }
            // The room URL stays inside this process. A random per-run key makes its token unlinkable across runs.
            let identity = "\(bundleID)\n\(application.processIdentifier)\n\(CFHash(window))\n\(url.absoluteString)"
            let token = HMAC<SHA256>.authenticationCode(for: Data(identity.utf8), using: pageKey)
              .map { String(format: "%02x", $0) }.joined()
            pages[nextScope] = BrowserPage(id: token, host: host)
          }
          if let frame = accessibilityFrame(element, deadline) { visibleFrame = visibleFrame.intersection(frame) }
        }
        if visibleFrame.isNull || visibleFrame.isEmpty { continue }
        if role == kAXButtonRole || role == kAXMenuButtonRole {
          guard let scope, accessibilityAttribute(element, kAXEnabledAttribute) as? Bool == true,
            let frame = accessibilityFrame(element, deadline), frame.intersects(visibleFrame) else { continue }
          // Read only button labels, never text fields, page text or window titles.
          let names = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute]
            .compactMap { accessibilityAttribute(element, $0) as? String }.map(callButtonLabel)
          let previous = controls[scope] ?? (end: false, leave: false, microphone: false)
          let endButton = names.contains(where: labels.end.contains)
          let leaveButton = names.contains(where: labels.leave.contains)
          let end = previous.end || endButton
          let leave = previous.leave || leaveButton
          // The same button must not satisfy both sides through conflicting label/help text.
          let microphone = previous.microphone || (!endButton && !leaveButton && names.contains(where: labels.microphone.contains))
          controls[scope] = (end, leave, microphone)
          if !webOnly && (end || (leave && microphone)) {
            result.inCall = true
            return result
          }
          continue
        }
        // Text and editable controls cannot contain the call buttons we are looking for.
        if [kAXStaticTextRole, kAXTextFieldRole, kAXTextAreaRole, kAXImageRole].contains(role) { continue }
        let children = (accessibilityAttribute(element, kAXVisibleChildrenAttribute) as? [AXUIElement])
          ?? (accessibilityAttribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        stack.append(contentsOf: children.reversed().map { ($0, depth + 1, scope, visibleFrame) })
      }
      for (scope, value) in pages.sorted(by: { $0.key < $1.key }) {
        var page = value
        guard result.pages.count < 64 else { return result }
        let state = controls[scope] ?? (end: false, leave: false, microphone: false)
        page.end = state.end
        page.leave = state.leave
        page.microphone = state.microphone
        if state.end || state.leave || state.microphone { result.pages.append(page) }
      }
    }
  }
  return result
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed: \(status)") }
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "Reading property \(selector)")
  return value
}

// A disappearing process is normal during detection. Failed reads must never retain a positive signal.
func audioValue<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
  return value
}

@available(macOS 14.4, *)
func audioApplication(_ object: AudioObjectID) -> String? {
  // Chromium and Electron can put input and output in different helpers. Resolve the
  // enclosing application from the executable, never from a guessed bundle-ID prefix.
  if let pid = audioValue(object, kAudioProcessPropertyPID, pid_t(-1)), pid > 0 {
    var buffer = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
    if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 {
      var url = URL(fileURLWithPath: "/")
      for component in URL(fileURLWithPath: String(cString: buffer)).pathComponents.dropFirst() {
        url.appendPathComponent(component)
        if url.pathExtension == "app", let id = Bundle(url: url)?.bundleIdentifier { return id }
      }
    }
  }
  var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr,
    let id = value?.takeRetainedValue() as String?, !id.isEmpty else { return nil }
  return id
}

@available(macOS 14.4, *)
func watchAudioProcesses(includeBrowsers: Bool) -> Never {
  let system = AudioObjectID(kAudioObjectSystemObject)
  let configurationURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("detection-config.json")
  guard let data = try? Data(contentsOf: configurationURL),
    let configuration = try? JSONDecoder().decode(DetectionConfiguration.self, from: data)
  else { fail("Missing meeting detection configuration. Rebuild and package voz-meeting.") }
  let browsers = includeBrowsers ? Set(configuration.browsers.keys) : Set<String>()
  let supported = Set(configuration.nativeApps.keys).union(browsers)
  let controlRequired = browsers.union(configuration.callControlApps)
  let labels = CallControlLabels(configuration)
  var preparedApplications = Set<pid_t>()
  let pageKey = SymmetricKey(size: .bits256)
  let requests = RefreshRequests()
  Thread {
    while let line = readLine() {
      guard line.utf8.count <= 128, let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let request = command["refresh"] as? Int, request > 0, request <= 9_007_199_254_740_991 else { continue }
      requests.submit(request)
    }
    exit(0)
  }.start()
  while true {
    // Capture before scanning: only a scan begun after the request may acknowledge it.
    let request = requests.take()
    autoreleasepool {
      let capturedAt = Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
      var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      var size: UInt32 = 0
      var apps: [String: (input: Bool, output: Bool)] = [:]
      if AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 {
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        if AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr {
          for object in objects {
            guard let input = audioValue(object, kAudioProcessPropertyIsRunningInput, UInt32(0)),
              let output = audioValue(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)),
              input != 0 || output != 0,
              let id = audioApplication(object), supported.contains(id) else { continue }
            let previous = apps[id] ?? (input: false, output: false)
            apps[id] = (input: input != 0 || previous.input, output: output != 0 || previous.output)
          }
        }
      }
      var snapshot: [AudioAppSnapshot] = []
      // Give every active app its own bounded share, so a slow browser cannot starve another call.
      let probeCount = apps.filter { controlRequired.contains($0.key) && $0.value.input && $0.value.output }.count
      let budget = min(0.8, 1.6 / Double(max(probeCount, 1)))
      for id in apps.keys.sorted() {
        let state = apps[id]!
        let controls = controlRequired.contains(id) && state.input && state.output
          ? applicationCallControls(id, webOnly: browsers.contains(id), labels, ProcessInfo.processInfo.systemUptime + budget, &preparedApplications, pageKey)
          : CallControls()
        snapshot.append(AudioAppSnapshot(bundleID: id, input: state.input, output: state.output, inCall: controls.inCall, pages: controls.pages))
      }
      // A heartbeat keeps both the qualification delay and call-end grace period current.
      if var data = try? JSONEncoder().encode(AudioSnapshot(capturedAt: capturedAt, apps: snapshot, request: request)) {
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
      }
    }
    _ = requests.wake.wait(timeout: .now() + 1)
  }
}

final class Track {
  let file: AVAudioFile
  let converter: AVAudioConverter
  let input: AVAudioPCMBuffer
  var ended = false

  init(_ url: URL, _ format: AVAudioFormat) {
    guard let file = try? AVAudioFile(forReading: url),
      let converter = AVAudioConverter(from: file.processingFormat, to: format),
      let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16384)
    else { fail("Cannot read \(url.path)") }
    converter.downmix = true
    (self.file, self.converter, self.input) = (file, converter, input)
  }

  func read(into buffer: AVAudioPCMBuffer) {
    buffer.frameLength = 0
    if ended { return }
    let status = converter.convert(to: buffer, error: nil) { _, inputStatus in
      if (try? self.file.read(into: self.input)) == nil || self.input.frameLength == 0 {
        inputStatus.pointee = .endOfStream
        return nil
      }
      inputStatus.pointee = .haveData
      return self.input
    }
    if status != .haveData { ended = true }
  }
}

func mix(_ first: URL, _ second: URL, into output: URL) {
  let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
  let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000]
  let file: AVAudioFile
  do { file = try AVAudioFile(forWriting: output, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false) } catch { fail("Cannot write \(output.path): \(error)") }
  let tracks = [Track(first, format), Track(second, format)]
  let buffers = tracks.map { _ in AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000)! }
  while true {
    for (track, buffer) in zip(tracks, buffers) { track.read(into: buffer) }
    let frames = buffers.map(\.frameLength).max()!
    if frames == 0 { break }
    let sum = buffers[0].floatChannelData![0]
    let other = buffers[1].floatChannelData![0]
    for i in 0..<Int(frames) {
      sum[i] = (i < Int(buffers[0].frameLength) ? sum[i] : 0) + (i < Int(buffers[1].frameLength) ? other[i] : 0)
    }
    buffers[0].frameLength = frames
    do { try file.write(from: buffers[0]) } catch { fail("Writing \(output.path) failed: \(error)") }
  }
}

let arguments = CommandLine.arguments
if (arguments.count == 3 || (arguments.count == 4 && arguments[3] == "--no-browser-controls")),
  arguments[1] == "--watch", arguments[2] == "--processes" {
  if #available(macOS 14.4, *) { watchAudioProcesses(includeBrowsers: arguments.count == 3) }
  fail("Meeting detection needs macOS 14.4 or later")
}
// `meeting-rec --watch` prints 1 or 0 whenever any app starts or stops using the default microphone, until stdin closes
if arguments.count == 2, arguments[1] == "--watch" {
  let system = AudioObjectID(kAudioObjectSystemObject)
  let queue = DispatchQueue(label: "meeting-rec")
  var running = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var defaultInput = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var device = AudioObjectID(kAudioObjectUnknown)
  var last = ""
  let emit = {
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    let line = AudioObjectGetPropertyData(device, &running, 0, nil, &size, &value) == noErr && value != 0 ? "1\n" : "0\n"
    if line != last { FileHandle.standardOutput.write(line.data(using: .utf8)!) }
    last = line
  }
  let report: AudioObjectPropertyListenerBlock = { _, _ in emit() }
  // Follow the default microphone when it changes, such as when AirPods connect
  let follow = {
    if device != kAudioObjectUnknown { AudioObjectRemovePropertyListenerBlock(device, &running, queue, report) }
    device = property(system, kAudioHardwarePropertyDefaultInputDevice, AudioObjectID(kAudioObjectUnknown))
    if device != kAudioObjectUnknown { AudioObjectAddPropertyListenerBlock(device, &running, queue, report) }
    emit()
  }
  check(AudioObjectAddPropertyListenerBlock(system, &defaultInput, queue) { _, _ in follow() }, "Watching the default microphone")
  queue.async(execute: follow)
  // Voz restarting extensions closes stdin, so the watcher never outlives them
  Thread {
    while readLine() != nil {}
    exit(0)
  }.start()
  dispatchMain()
}
guard arguments.count == 2 else { fail("usage: meeting-rec <out.m4a> | meeting-rec --watch [--processes]") }
let output = URL(fileURLWithPath: arguments[1])
let micURL = output.appendingPathExtension("mic.caf")
let systemURL = output.appendingPathExtension("system.caf")

let engine = AVAudioEngine()
let micFormat = engine.inputNode.outputFormat(forBus: 0)
var micFile: AVAudioFile? = try? AVAudioFile(forWriting: micURL, settings: micFormat.settings)
guard micFile != nil else { fail("Cannot write \(micURL.path)") }
engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
  try? micFile?.write(from: buffer)
}

let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.isPrivate = true
tapDescription.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "Creating the system audio tap")

let outputDevice = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(kAudioObjectUnknown))
let outputUID = property(outputDevice, kAudioDevicePropertyDeviceUID, "" as CFString) as String
let aggregateDescription: [String: Any] = [
  kAudioAggregateDeviceNameKey: "Voz Meeting",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID), "Creating the aggregate device")

var tapStream = property(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
guard let systemFormat = AVAudioFormat(streamDescription: &tapStream) else { fail("Unsupported tap format") }
var systemFile: AVAudioFile? = try? AVAudioFile(forWriting: systemURL, settings: systemFormat.settings, commonFormat: systemFormat.commonFormat, interleaved: systemFormat.isInterleaved)
guard systemFile != nil else { fail("Cannot write \(systemURL.path)") }

var procID: AudioDeviceIOProcID?
check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, DispatchQueue(label: "meeting-rec")) { _, input, _, _, _ in
  guard let buffer = AVAudioPCMBuffer(pcmFormat: systemFormat, bufferListNoCopy: input, deallocator: nil) else { return }
  try? systemFile?.write(from: buffer)
}, "Creating the IO proc")

check(AudioDeviceStart(aggregateID, procID), "Starting system audio")
do { try engine.start() } catch { fail("Starting the microphone failed: \(error)") }

func stop() {
  engine.stop()
  engine.inputNode.removeTap(onBus: 0)
  AudioDeviceStop(aggregateID, procID)
  AudioDeviceDestroyIOProcID(aggregateID, procID!)
  AudioHardwareDestroyAggregateDevice(aggregateID)
  AudioHardwareDestroyProcessTap(tapID)
  micFile?.close()
  systemFile?.close()
  micFile = nil
  systemFile = nil
  mix(micURL, systemURL, into: output)
  try? FileManager.default.removeItem(at: micURL)
  try? FileManager.default.removeItem(at: systemURL)
  exit(0)
}

var sources: [DispatchSourceSignal] = []
for signalNumber in [SIGINT, SIGTERM] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler(handler: stop)
  source.resume()
  sources.append(source)
}
dispatchMain()
