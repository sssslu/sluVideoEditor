/** FFprobe 8.0.1 leaves end_is_offset/duration_frames/end uninitialized when
 * parsing a start-only read interval, then reads them in read_interval_packets.
 * Depending on the allocation, a valid seek can return zero frames with exit 0.
 * https://github.com/FFmpeg/FFmpeg/blob/n8.0.1/fftools/ffprobe.c
 *
 * Explicitly initialize the absolute endpoint to the largest whole second
 * representable in signed int64 microseconds. This exceeds our safe-integer
 * microsecond clock; it cannot truncate a supported frame or a reordered
 * reference packet. Consumers still stop on decoded presentation timestamps,
 * not a packet count or the requested cut's packet timestamp. */
export function ffprobeIntervalFrom(seconds:number):string {
  if(!Number.isFinite(seconds)||!Number.isSafeInteger(Math.round(seconds*1e6)))throw new Error('영상 탐색 시각이 지원 범위를 벗어났습니다.');
  return `${seconds.toFixed(6)}%9223372036854`;
}
