import { CREATIVE_ASSETS } from "./creative-manifest";

const CREATIVE_ASSET_PREFIX = "/creative-assets/";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Serve only the immutable, deliberately public advertising art in the manifest. */
export function getCreativeAssetResponse(request: Request): Response | null {
	const pathname = new URL(request.url).pathname;
	if (!pathname.startsWith(CREATIVE_ASSET_PREFIX)) return null;
	if (!Object.prototype.hasOwnProperty.call(CREATIVE_ASSETS, pathname)) {
		return new Response("Creative asset not found.", {
			status: 404,
			headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
		});
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed.", {
			status: 405,
			headers: { Allow: "GET, HEAD", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
		});
	}

	try {
		const asset = CREATIVE_ASSETS[pathname];
		if (!asset.base64 || !BASE64_PATTERN.test(asset.base64)) throw new Error("Invalid base64.");
		const binary = atob(asset.base64);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const validJpeg = asset.mimeType === "image/jpeg"
			&& bytes.length >= 5
			&& bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
			&& bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
		const validPng = asset.mimeType === "image/png"
			&& PNG_SIGNATURE.every((value, index) => bytes[index] === value);
		if (!validJpeg && !validPng) throw new Error("Invalid raster signature.");
		return new Response(request.method === "HEAD" ? null : bytes, {
			status: 200,
			headers: {
				"Content-Type": asset.mimeType,
				"Content-Length": String(bytes.byteLength),
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch {
		return new Response("Creative asset unavailable.", {
			status: 500,
			headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
		});
	}
}
