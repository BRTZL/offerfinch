// Prints the text macOS Vision reads in an image, one line per observation. A failed read (Vision
// could not run) exits 1 with the error on stderr, so the caller never takes it for a blank image.
// Usage: swift scripts/ocr.swift <image>   (scripts/check-public.mjs compiles it once)
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
let handler = VNImageRequestHandler(url: url)
do {
	try handler.perform([request])
} catch {
	FileHandle.standardError.write("ocr: \(error)\n".data(using: .utf8)!)
	exit(1)
}
for observation in request.results ?? [] {
	if let text = observation.topCandidates(1).first?.string { print(text) }
}
