// Reviewed public advertising artwork manifest.
// Public marketing images only. Do not place private data or credentials here.
import asset0 from "./creative-data/preparo-feed";
import asset1 from "./creative-data/fundamentos-feed";
import asset2 from "./creative-data/preparo-stories";
import asset3 from "./creative-data/fundamentos-stories";
import asset4 from "./creative-data/acls-permanente-feed";
import asset5 from "./creative-data/pals-permanente-feed";

export const CREATIVE_ASSETS: Record<string, { mimeType: "image/jpeg" | "image/png"; base64: string }> = {
  "/creative-assets/brevar-preparo-feed-e0ab576a73501a45.jpg": { mimeType: "image/jpeg", base64: asset0 },
  "/creative-assets/brevar-fundamentos-feed-e25c570dca600000.jpg": { mimeType: "image/jpeg", base64: asset1 },
  "/creative-assets/brevar-preparo-stories-a1c8eb967bd9f5f0.jpg": { mimeType: "image/jpeg", base64: asset2 },
  "/creative-assets/brevar-fundamentos-stories-2a39f0866bd9d016.jpg": { mimeType: "image/jpeg", base64: asset3 },
  "/creative-assets/acls-permanente-feed-16460afa407e1187.jpg": { mimeType: "image/jpeg", base64: asset4 },
  "/creative-assets/pals-permanente-feed-33c5e02bbd528547.jpg": { mimeType: "image/jpeg", base64: asset5 }
};
