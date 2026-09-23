import { eq } from 'drizzle-orm'
import { isVideoStorageKey } from '~~/shared/utils/media'

export default eventHandler(async (event) => {
  const photoId = getRouterParam(event, 'photoId')
  if (!photoId) {
    throw createError({ statusCode: 404, statusMessage: 'Video not found' })
  }

  const photo = await useDB()
    .select({ storageKey: tables.photos.storageKey })
    .from(tables.photos)
    .where(eq(tables.photos.id, photoId))
    .get()

  if (!photo?.storageKey || !isVideoStorageKey(photo.storageKey)) {
    throw createError({ statusCode: 404, statusMessage: 'Video not found' })
  }

  const { storageProvider } = useStorageProvider(event)
  return sendRedirect(
    event,
    storageProvider.getPublicUrl(photo.storageKey),
    302,
  )
})
