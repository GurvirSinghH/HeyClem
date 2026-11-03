import { desktopCapturer, screen } from "electron";

export interface Screenshot {
  jpegBase64: string;
  width: number;
  height: number;
  /** Mouse pointer in screenshot pixels, or null if it's on another display. */
  cursor: { x: number; y: number } | null;
  displayLabel: string;
  ms: number;
}

/**
 * Measured on Llama 4 Scout: 1280 px at quality 70 gave a first word about a second sooner than
 * 1568 px at quality 80, used fewer neurons, and could still read 8 pt text.
 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 70;

/** Captures the display under the mouse pointer: that's the screen the user is asking about. */
export async function captureActiveDisplay(): Promise<Screenshot> {
  const t0 = performance.now();
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const all = screen.getAllDisplays();

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.max(...all.map((d) => Math.round(d.size.width * d.scaleFactor))),
      height: Math.max(...all.map((d) => Math.round(d.size.height * d.scaleFactor))),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("Screen capture returned an empty image.");
  }

  let image = source.thumbnail;
  const full = image.getSize();
  const scale = Math.min(1, MAX_EDGE / Math.max(full.width, full.height));
  if (scale < 1) {
    image = image.resize({
      width: Math.round(full.width * scale),
      height: Math.round(full.height * scale),
      quality: "best",
    });
  }
  const size = image.getSize();

  const b = display.bounds;
  const inside = point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  const cursor = inside
    ? {
        x: Math.round(((point.x - b.x) / b.width) * size.width),
        y: Math.round(((point.y - b.y) / b.height) * size.height),
      }
    : null;

  return {
    jpegBase64: image.toJPEG(JPEG_QUALITY).toString("base64"),
    width: size.width,
    height: size.height,
    cursor,
    displayLabel: display.label || `display ${display.id}`,
    ms: Math.round(performance.now() - t0),
  };
}
