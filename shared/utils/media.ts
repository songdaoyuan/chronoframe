export const isVideoStorageKey = (key?: string | null): boolean =>
  /\.(mov|mp4)$/i.test(key || '')
