import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Photo } from '~~/server/utils/db'
import type { StorageProvider } from '~~/server/services/storage'
import { compressUint8Array } from '~~/shared/utils/u8array'
import { generateThumbnailAndHash } from '../image/thumbnail'
import { generateMediaId } from '~~/server/utils/file-utils'
import { extractVideoMetadata } from './metadata'
import { videoDisplaySize, VIDEO_FALLBACK_SCALE } from './display'
import { eraseVideoFileLocation, saveVideoSource } from './privacy'

const run = promisify(execFile)

export const prepareStandaloneVideo = async (
  storageKey: string,
  storageProvider: StorageProvider,
  includeLocation = true,
): Promise<Photo> => {
  const videoBuffer = await storageProvider.get(storageKey)
  if (!videoBuffer) throw new Error(`Video file not found: ${storageKey}`)

  const videoId = generateMediaId(storageKey)
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-video-'))

  try {
    const input = path.join(
      tempDir,
      `input${path.extname(storageKey).toLowerCase()}`,
    )
    const frame = path.join(tempDir, 'frame.jpg')
    const playback = path.join(tempDir, 'playback.mp4')
    await writeFile(input, videoBuffer)
    let sourceSize = videoBuffer.length
    if (!includeLocation) {
      await eraseVideoFileLocation(input)
      const sanitized = await readFile(input)
      await saveVideoSource(storageProvider, storageKey, sanitized)
      sourceSize = sanitized.length
    }
    let metadata: Awaited<ReturnType<typeof extractVideoMetadata>> | null = null
    try {
      metadata = await extractVideoMetadata(input, includeLocation)
    } catch (error) {
      logger.chrono.warn(
        `Could not read video metadata for ${storageKey}`,
        error,
      )
    }

    const { stdout } = await run(
      '/usr/bin/ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,pix_fmt,color_transfer:stream_side_data=rotation',
        '-of',
        'json',
        input,
      ],
      { timeout: 30000 },
    )
    const streams = JSON.parse(stdout).streams || []
    const stream = streams.find(
      (item: { codec_type?: string }) => item.codec_type === 'video',
    )
    const audioStream = streams.find(
      (item: { codec_type?: string }) => item.codec_type === 'audio',
    )
    if (!stream?.width || !stream?.height) {
      throw new Error(`No decodable video stream: ${storageKey}`)
    }
    const dimensions = videoDisplaySize(
      stream.width,
      stream.height,
      stream.side_data_list?.find(
        (data: { rotation?: number }) => data.rotation !== undefined,
      )?.rotation ?? 0,
    )

    let playbackUrl = storageProvider.getPublicUrl(storageKey)
    if (/\.mov$/i.test(storageKey)) {
      // Preserve the original MOV for capable browsers and make an SDR MP4
      // fallback. HDR transfer characteristics must be tone-mapped before
      // encoding an 8-bit H.264 fallback.
      const hasHdrTransfer = ['arib-std-b67', 'smpte2084'].includes(
        stream.color_transfer,
      )
      // An SDR H.264 MOV only needs a container change for MP4 playback.
      // Copying its bitstream preserves the uploaded resolution, frame rate,
      // color and bitrate instead of encoding it a second time.
      const canRemux =
        stream.codec_name === 'h264' &&
        stream.pix_fmt === 'yuv420p' &&
        !hasHdrTransfer
      await run(
        '/usr/bin/ffmpeg',
        [
          '-v',
          'error',
          '-i',
          input,
          ...(!canRemux && hasHdrTransfer
            ? [
                '-vf',
                `${VIDEO_FALLBACK_SCALE},zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:p=bt709,format=yuv420p`,
                '-color_primaries',
                'bt709',
                '-color_trc',
                'bt709',
                '-colorspace',
                'bt709',
              ]
            : []),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c:v',
          canRemux ? 'copy' : 'libx264',
          ...(!canRemux
            ? ['-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p']
            : []),
          '-c:a',
          audioStream?.codec_name === 'aac' ? 'copy' : 'aac',
          ...(audioStream?.codec_name === 'aac' ? [] : ['-b:a', '128k']),
          '-movflags',
          '+faststart',
          '-threads',
          '1',
          '-y',
          playback,
        ],
        { timeout: 300000 },
      )
      const converted = await storageProvider.create(
        `videos/${videoId}.mp4`,
        await readFile(playback),
        'video/mp4',
      )
      playbackUrl = storageProvider.getPublicUrl(converted.key)
    }

    let thumbnailKey: string | null = null
    let thumbnailUrl: string | null = null
    let thumbnailHash: string | null = null
    try {
      await run(
        '/usr/bin/ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          '0.5',
          '-i',
          input,
          '-frames:v',
          '1',
          '-threads',
          '1',
          '-y',
          frame,
        ],
        { timeout: 30000 },
      )
      const { thumbnailBuffer, thumbnailHash: hash } =
        await generateThumbnailAndHash(await readFile(frame))
      const thumbnail = await storageProvider.create(
        `thumbnails/${videoId}.webp`,
        thumbnailBuffer,
        'image/webp',
      )
      thumbnailKey = thumbnail.key
      thumbnailUrl = storageProvider.getPublicUrl(thumbnail.key)
      thumbnailHash = hash ? compressUint8Array(hash) : null
    } catch (error) {
      logger.chrono.warn(
        `Could not generate video thumbnail for ${storageKey}`,
        error,
      )
    }

    return {
      id: videoId,
      title: path.basename(storageKey, path.extname(storageKey)),
      description: null,
      width: dimensions.width,
      height: dimensions.height,
      aspectRatio: dimensions.width / dimensions.height,
      dateTaken: metadata?.dateTaken || new Date().toISOString(),
      storageKey,
      thumbnailKey,
      fileSize: sourceSize,
      lastModified: new Date().toISOString(),
      originalUrl: playbackUrl,
      thumbnailUrl,
      thumbnailHash,
      tags: [],
      exif: metadata?.exif || null,
      latitude: metadata?.latitude ?? null,
      longitude: metadata?.longitude ?? null,
      country: null,
      city: null,
      locationName: null,
      isLivePhoto: 0,
      livePhotoVideoUrl: null,
      livePhotoVideoKey: null,
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
