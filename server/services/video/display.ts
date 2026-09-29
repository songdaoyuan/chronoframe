export const videoDisplaySize = (
  width: number,
  height: number,
  rotation = 0,
) => {
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1
  return quarterTurn ? { width: height, height: width } : { width, height }
}

// Bound both axes, keep even dimensions for H.264, and never upscale.
export const VIDEO_FALLBACK_SCALE =
  "scale=w='trunc(iw*min(1,min(1920/iw,1920/ih))/2)*2':h='trunc(ih*min(1,min(1920/iw,1920/ih))/2)*2'"
