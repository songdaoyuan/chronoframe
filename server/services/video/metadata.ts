import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NeededExif } from '~~/shared/types/photo'

const run = promisify(execFile)

export interface VideoMetadata {
  dateTaken: string | null
  exif: NeededExif
  latitude: number | null
  longitude: number | null
  width: number | null
  height: number | null
}

const stringValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}

const numberValue = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const parseExifDate = (value: unknown, assumeUTC = false): string | null => {
  const text = stringValue(value)
  if (!text) return null

  const match = text.match(
    /^(\d{4}):?(\d{2}):?(\d{2})[ T](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?$/,
  )
  if (!match) return null

  const [, year, month, day, time, rawOffset] = match
  if (!rawOffset && !assumeUTC) return null
  const offset = rawOffset
    ? rawOffset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : 'Z'
  const date = new Date(`${year}-${month}-${day}T${time}${offset}`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const parseVideoTags = (
  tags: Record<string, unknown>,
  includeLocation = true,
): VideoMetadata => {
  // Apple's CreationDate includes the capture timezone. QuickTime CreateDate
  // is UTC and may instead describe a later exported rendition.
  const dateTaken =
    parseExifDate(tags.CreationDate) ||
    parseExifDate(tags.DateTimeOriginal) ||
    parseExifDate(tags.CreateDate, true)
  const latitude = includeLocation ? numberValue(tags.GPSLatitude) : undefined
  const longitude = includeLocation ? numberValue(tags.GPSLongitude) : undefined
  const validCoordinates =
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180

  const creationDate = stringValue(tags.CreationDate)
  const timezone = creationDate?.match(/([+-]\d{2}:?\d{2})$/)?.[1]
  const exif: Partial<NeededExif> = {
    DateTimeOriginal: dateTaken || undefined,
    Make: stringValue(tags.Make),
    Model: stringValue(tags.Model),
    Software: stringValue(tags.Software),
    LensModel: stringValue(tags.LensModel),
    FocalLengthIn35mmFormat: stringValue(tags.FocalLengthIn35mmFormat),
    ImageWidth: numberValue(tags.ImageWidth),
    ImageHeight: numberValue(tags.ImageHeight),
    tz: timezone?.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2'),
    VideoCodec: stringValue(tags.CompressorName),
    VideoFrameRate: numberValue(tags.VideoFrameRate),
    VideoDuration: numberValue(tags.Duration),
  }
  if (validCoordinates) {
    exif.GPSLatitude = latitude
    exif.GPSLongitude = longitude
    exif.GPSAltitude = numberValue(tags.GPSAltitude)
  }

  return {
    dateTaken,
    exif: exif as NeededExif,
    latitude: validCoordinates ? latitude : null,
    longitude: validCoordinates ? longitude : null,
    width: numberValue(tags.ImageWidth) ?? null,
    height: numberValue(tags.ImageHeight) ?? null,
  }
}

export const extractVideoMetadata = async (
  filePath: string,
  includeLocation = true,
): Promise<VideoMetadata> => {
  const { stdout } = await run('/usr/bin/exiftool', ['-json', '-n', filePath], {
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
  })
  const tags = JSON.parse(stdout)?.[0]
  if (!tags || typeof tags !== 'object') {
    throw new Error('Video metadata is unavailable')
  }
  const metadata = parseVideoTags(tags, includeLocation)
  try {
    const probe = await run(
      '/usr/bin/ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_transfer:stream_side_data=side_data_type,dv_profile,dv_bl_signal_compatibility_id',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 30000 },
    )
    const stream = JSON.parse(probe.stdout)?.streams?.[0]
    const dolby = stream?.side_data_list?.find(
      (item: { side_data_type?: string }) =>
        item.side_data_type === 'DOVI configuration record',
    )
    if (dolby?.dv_profile === 8 && dolby?.dv_bl_signal_compatibility_id === 4) {
      metadata.exif.VideoHDRFormat = 'Dolby Vision 8.4 / HLG'
    } else if (dolby) {
      metadata.exif.VideoHDRFormat = `Dolby Vision Profile ${dolby.dv_profile}`
    } else if (stream?.color_transfer === 'arib-std-b67') {
      metadata.exif.VideoHDRFormat = 'HLG'
    } else if (stream?.color_transfer === 'smpte2084') {
      metadata.exif.VideoHDRFormat = 'PQ HDR'
    }
  } catch {
    // ExifTool fields are still useful when ffprobe cannot identify HDR.
  }
  return metadata
}

export const extractVideoMetadataFromBuffer = async (
  buffer: Buffer,
  storageKey: string,
  includeLocation = true,
): Promise<VideoMetadata> => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'cframe-video-meta-'))
  try {
    const input = path.join(
      tempDir,
      `input${path.extname(storageKey).toLowerCase()}`,
    )
    await writeFile(input, buffer)
    return await extractVideoMetadata(input, includeLocation)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
