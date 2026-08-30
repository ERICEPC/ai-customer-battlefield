const millisecondsPerMinute = 60_000;

export function instantToLocalDateTimeInput(
  instant: string,
  offsetMinutes = new Date(instant).getTimezoneOffset(),
): string {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) throw new Error("无效的时间值。");
  return new Date(value.getTime() - offsetMinutes * millisecondsPerMinute)
    .toISOString()
    .slice(0, 16);
}

export function localDateTimeInputToInstant(
  localValue: string,
  offsetMinutes = new Date(localValue).getTimezoneOffset(),
): string {
  const localAsUtc = Date.parse(`${localValue}:00.000Z`);
  if (Number.isNaN(localAsUtc)) throw new Error("无效的本地时间值。");
  return new Date(
    localAsUtc + offsetMinutes * millisecondsPerMinute,
  ).toISOString();
}
