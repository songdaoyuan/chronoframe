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
  return parseVideoTags(tags, includeLocation)
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
