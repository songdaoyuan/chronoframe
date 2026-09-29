import sharp from 'sharp'
import { isVideoStorageKey } from '~~/shared/utils/media'
import { PreviewCache } from '~~/server/services/image/preview-cache'
import type { StorageProvider } from '~~/server/services/storage'

const caches = new WeakMap<StorageProvider, PreviewCache>()

const width = 1200
const height = 630

const playIcon = Buffer.from(`
  <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <circle cx="600" cy="315" r="70" fill="#000" fill-opacity=".55"/>
    <path d="M580 275 L580 355 L648 315 Z" fill="#fff"/>
  </svg>
`)

export default eventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const photo = useDB()
    .select({
      thumbnailKey: tables.photos.thumbnailKey,
      storageKey: tables.photos.storageKey,
      lastModified: tables.photos.lastModified,
    })
    .from(tables.photos)
    .where(eq(tables.photos.id, id))
    .get()
  if (!photo) {
    throw createError({ statusCode: 404, statusMessage: 'Photo not found' })
  }

  const { storageProvider } = useStorageProvider(event)
  let cache = caches.get(storageProvider)
  if (!cache) {
    cache = new PreviewCache()
    caches.set(storageProvider, cache)
  }
  setHeader(event, 'Content-Type', 'image/jpeg')
  // Revalidate with the server so metadata updates invalidate cached previews.
  setHeader(event, 'Cache-Control', 'public, max-age=0, must-revalidate')
  return cache.get(
    JSON.stringify([
      id,
      photo.thumbnailKey,
      photo.storageKey,
      photo.lastModified,
    ]),
    async () => {
      const thumbnail = photo.thumbnailKey
        ? await storageProvider.get(photo.thumbnailKey)
        : null

      const background = thumbnail
        ? await sharp(thumbnail)
            .rotate()
            .resize(width, height, { fit: 'cover' })
            .blur(18)
            .modulate({ brightness: 0.4 })
            .png()
            .toBuffer()
        : await sharp({
            create: {
              width,
              height,
              channels: 4,
              background: '#242424',
            },
          })
            .png()
            .toBuffer()

      const overlays: sharp.OverlayOptions[] = []
      if (thumbnail) {
        overlays.push({
          input: await sharp(thumbnail)
            .rotate()
            .resize(width, height, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer(),
        })
      }
      if (isVideoStorageKey(photo.storageKey)) {
        overlays.push({ input: playIcon })
      }

      return sharp(background)
        .composite(overlays)
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
    },
  )
})
