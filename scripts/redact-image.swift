// Pixelates every line of text in an image that contains a listed term, in place.
// Usage: redact-image <image.png|jpg> <terms file, one per line>   (scripts/redact-images.mjs
// compiles it once). Prints how many lines it covered. The terms file stays outside the repo.
import AppKit
import CoreImage
import Foundation
import Vision

let path = CommandLine.arguments[1]
let terms = (try? String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8))?
	.split(separator: "\n")
	.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
	.filter { !$0.isEmpty && !$0.hasPrefix("#") } ?? []

let url = URL(fileURLWithPath: path)
guard let image = CIImage(contentsOf: url) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try? VNImageRequestHandler(url: url).perform([request])

let extent = image.extent
var output = image
var covered = 0
for observation in request.results ?? [] {
	guard let text = observation.topCandidates(1).first?.string.lowercased() else { continue }
	if !terms.contains(where: { text.contains($0) }) { continue }
	// Vision's box is normalized with the origin at the bottom left, as Core Image's is.
	let box = observation.boundingBox
	let rect = CGRect(
		x: box.minX * extent.width - 4,
		y: box.minY * extent.height - 4,
		width: box.width * extent.width + 8,
		height: box.height * extent.height + 8
	).intersection(extent)
	let scale = max(8, rect.height / 2)
	let pixelated = image.cropped(to: rect)
		.applyingFilter("CIPixellate", parameters: [
			kCIInputScaleKey: scale,
			kCIInputCenterKey: CIVector(x: rect.minX, y: rect.minY),
		])
		.cropped(to: rect)
	output = pixelated.composited(over: output)
	covered += 1
}

if covered > 0 {
	let context = CIContext()
	let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
	if path.lowercased().hasSuffix(".png") {
		try context.writePNGRepresentation(
			of: output.cropped(to: extent), to: url, format: .RGBA8, colorSpace: space)
	} else {
		try context.writeJPEGRepresentation(
			of: output.cropped(to: extent), to: url, colorSpace: space)
	}
}
print(covered)
