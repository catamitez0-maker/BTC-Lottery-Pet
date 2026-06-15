export function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [hours, minutes, remainingSeconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}
