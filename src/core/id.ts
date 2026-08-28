// Minimal sortable unique id — a real ULID library can replace this later;
// this scaffold intentionally has zero runtime dependencies so it's
// trivially auditable end to end.
let lastTimestamp = 0;
let counter = 0;

export function generateId(): string {
  const now = Date.now();
  if (now === lastTimestamp) {
    counter++;
  } else {
    lastTimestamp = now;
    counter = 0;
  }
  const ts = now.toString(36).padStart(9, "0");
  const seq = counter.toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}${seq}${rand}`;
}
