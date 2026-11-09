/**
 * Runs fn over items with at most `limit` calls in flight, keeping the order of
 * items in the result. Used where one request needs many small reads: running
 * them one after another made pages slow, and running all at once can exceed
 * DynamoDB's throughput on a large class.
 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
