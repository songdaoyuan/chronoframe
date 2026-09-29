import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { StorageProvider } from '../storage'

const run = promisify(execFile)

export const eraseVideoFileLocation = async (filePath: string) => {
  await run(
    '/usr/bin/exiftool',
    [
      '-overwrite_original',
      '-GPS:all=',
      '-XMP:GPS*=',
      '-QuickTime:GPSCoordinates=',
      '-QuickTime:LocationInformation=',
      filePath,
    ],
    { timeout: 30000 },
  )
  // Embedded GPS tracks may be readable but not writable by ExifTool.
  // Fail the task instead of publishing a video that still contains coordinates.
  const { stdout } = await run(
    '/usr/bin/exiftool',
    ['-json', '-n', '-ee', '-GPS*', '-LocationInformation', filePath],
    { timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
  )
  const tags = JSON.parse(stdout)?.[0]
  if (
    !tags ||
    Object.entries(tags).some(
      ([key, value]) =>
        /GPS|LocationInformation/i.test(key) && value !== null && value !== '',
    )
  ) {
    throw new Error('Video location metadata could not be fully removed')
  }
}

export const saveVideoSource = async (
  provider: StorageProvider,
  key: string,
  buffer: Buffer,
) => {
  const prefix = (provider.config?.prefix || '').replace(/\/+$/, '')
  const relativeKey =
    prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key
  await provider.create(
    relativeKey,
    buffer,
    /\.mov$/i.test(key) ? 'video/quicktime' : 'video/mp4',
  )
}

export const eraseStoredVideoLocation = async (
  provider: StorageProvider,
  key: string,
) => {
  const buffer = await provider.get(key)
  if (!buffer) throw new Error(`Video file not found: ${key}`)
  const directory = await mkdtemp(path.join(tmpdir(), 'cframe-video-privacy-'))
  try {
    const filePath = path.join(directory, `input${path.extname(key)}`)
    await writeFile(filePath, buffer)
    await eraseVideoFileLocation(filePath)
    await saveVideoSource(provider, key, await readFile(filePath))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
