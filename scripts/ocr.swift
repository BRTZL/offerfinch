// Prints the text macOS Vision reads in an image, one line per observation.
// Usage: swift scripts/ocr.swift <image>   (scripts/check-public.mjs compiles it once)
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
let handler = VNImageRequestHandler(url: url)
try? handler.perform([request])
for observation in request.results ?? [] {
	if let text = observation.topCandidates(1).first?.string { print(text) }
}
