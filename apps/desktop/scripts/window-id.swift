// Prints the window number of a process's largest on-screen window, for `screencapture -l`.
// Usage: swift window-id.swift <pid>   (scripts/screenshots.mjs compiles it once)
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
var best: (Int, Double)? = nil
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
	let b = w[kCGWindowBounds as String] as! [String: Double]
	let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
	if best == nil || area > best!.1 { best = (w[kCGWindowNumber as String] as! Int, area) }
}
if let b = best { print(b.0) }
